use colored::*;
use dashmap::DashMap;
use std::cell::RefCell;
use std::env;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use strum::FromRepr;
use wasi_shell::{
    CommandRegistry, IoContext, KeyEvent, KeyEventHandler, LineEditor, handle_parallel,
};

thread_local! {
    static CANCELLATION_TOKEN: RefCell<Option<wasibox_core::CancellationToken>> = RefCell::new(None);
}

fn normalize_path_logical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            Component::Normal(c) => normalized.push(c),
            Component::RootDir => {
                normalized.push("/");
            }
            Component::Prefix(_) => {}
        }
    }
    normalized
}

// ============================================================
// Terminal Echo Handler
// ============================================================

struct TerminalEchoHandler<'a> {
    pub needs_redraw: bool,
    pub writer: &'a mut dyn Write,
}

impl<'a> KeyEventHandler for TerminalEchoHandler<'a> {
    fn on_key_event(&mut self, key: KeyEvent) {
        match key {
            KeyEvent::Enter => {
                write!(self.writer, "\r\n").unwrap();
            }
            KeyEvent::CtrlC => {
                write!(self.writer, "^C\r\n").unwrap();
                self.needs_redraw = true;
            }
            KeyEvent::Char(c) if c == '\x0c' => {
                // Ctrl+L
                write!(self.writer, "\x1b[2J\x1b[H").unwrap();
                self.needs_redraw = true;
            }
            KeyEvent::Char(c) => {
                write!(self.writer, "{c}").unwrap();
            }
            KeyEvent::Right => {
                write!(self.writer, "\x1b[1C").unwrap();
            }
            KeyEvent::Left => {
                write!(self.writer, "\x1b[1D").unwrap();
            }
            _ => {
                self.needs_redraw = true;
            }
        }
        self.writer.flush().unwrap();
    }
}

// ============================================================
// Cross-Wasm ABI: scalar-only interface (no raw pointer passing)
// ============================================================

// IoPtr wraps a raw pointer to IoContext as usize (scalar).
// The pointer is always in vfs-shell's own memory space.
struct IoPtr(usize);
unsafe impl Send for IoPtr {}
unsafe impl Sync for IoPtr {}

// Each context_id maps to a Mutex<IoPtr> for thread-safe writes.
static IO_REGISTRY: LazyLock<DashMap<u32, Mutex<IoPtr>>> = LazyLock::new(|| DashMap::new());
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

// Buffer for passing command args from vfs-shell to vfs.
// vfs-shell writes here; vfs reads via vfs_shell::memcpy_to.
static CMD_ARGS: Mutex<Vec<u8>> = Mutex::new(Vec::new());

// ----------------------------------------------------------
// Exported functions for args passing (vfs-shell → vfs)
// ----------------------------------------------------------

/// Returns the pointer to cmd args buffer in vfs-shell's memory (as u32 scalar).
#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_get_cmd_args_ptr() -> u32 {
    CMD_ARGS.lock().unwrap().as_ptr() as u32
}

/// Returns the length of cmd args buffer.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_get_cmd_args_len() -> u32 {
    CMD_ARGS.lock().unwrap().len() as u32
}

// ----------------------------------------------------------
// Exported functions for memory allocation (vfs → vfs-shell)
// ----------------------------------------------------------

static ALLOC_LOCK: Mutex<()> = Mutex::new(());

/// Allocates a buffer in vfs-shell's memory. Returns address as u32.
/// The caller (vfs) can then use vfs_shell::memcpy to write into this buffer.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_alloc_buf(len: u32) -> u32 {
    let _guard = ALLOC_LOCK.lock().unwrap();
    let buf: Box<[u8]> = vec![0u8; len as usize].into_boxed_slice();
    let ptr = Box::into_raw(buf) as *mut u8;
    ptr as u32
}

/// Frees a buffer previously allocated by vfs_shell_alloc_buf.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vfs_shell_free_buf(ptr: u32, len: u32) {
    let _guard = ALLOC_LOCK.lock().unwrap();
    let slice = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, len as usize) };
    drop(unsafe { Box::from_raw(slice) });
}

// ----------------------------------------------------------
// Exported functions for stdout/stderr writes (vfs → vfs-shell)
// All pointers received here are in vfs-shell's own memory
// (allocated via vfs_shell_alloc_buf, written via vfs_shell::memcpy).
// ----------------------------------------------------------

/// Writes data from vfs-shell's own memory buffer to the stdout of the given context.
/// Thread-safe: acquires Mutex before writing.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vfs_shell_write_stdout(id: u32, ptr: u32, len: u32) -> u32 {
    let is_cancelled = CANCELLATION_TOKEN.with(|t| {
        t.borrow()
            .as_ref()
            .map(|ct| ct.is_cancelled())
            .unwrap_or(false)
    });
    if is_cancelled {
        return 0;
    }
    if let Some(entry) = IO_REGISTRY.get(&id) {
        if let Ok(guard) = entry.value().lock() {
            let io = unsafe { &mut *(guard.0 as *mut IoContext) };
            let slice = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
            if let Ok(written) = io.stdout.write(slice) {
                return written as u32;
            }
        }
    }
    0
}

/// Writes data from vfs-shell's own memory buffer to the stderr of the given context.
/// Thread-safe: acquires Mutex before writing.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vfs_shell_write_stderr(id: u32, ptr: u32, len: u32) -> u32 {
    let is_cancelled = CANCELLATION_TOKEN.with(|t| {
        t.borrow()
            .as_ref()
            .map(|ct| ct.is_cancelled())
            .unwrap_or(false)
    });
    if is_cancelled {
        return 0;
    }
    if let Some(entry) = IO_REGISTRY.get(&id) {
        if let Ok(guard) = entry.value().lock() {
            let io = unsafe { &mut *(guard.0 as *mut IoContext) };
            let slice = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
            if let Ok(written) = io.stderr.write(slice) {
                return written as u32;
            }
        }
    }
    0
}

// ----------------------------------------------------------

#[link(wasm_import_module = "__wasip1_vfs-host")]
unsafe extern "C" {
    #[link_name = "sysroot_start_fetch"]
    pub fn sysroot_start_fetch(triple_ptr: i32, triple_len: i32);

    #[link_name = "sysroot_get_next_file_meta"]
    pub fn sysroot_get_next_file_meta(name_len_ptr: i32, data_len_ptr: i32) -> i32;

    #[link_name = "sysroot_read_file_name"]
    pub fn sysroot_read_file_name(name_ptr: i32, name_len: i32);

    #[link_name = "sysroot_read_file_chunk"]
    pub fn sysroot_read_file_chunk(data_ptr: i32, chunk_len: i32);

    #[link_name = "terminal_write"]
    pub fn terminal_write(session_id: u32, data_ptr: i32, data_len: i32);

    #[link_name = "vfs_set_current_session_id"]
    pub fn vfs_set_current_session_id(session_id: u32);
}

// Import: vfs_execute_command (scalar-only, no pointer args)
// ----------------------------------------------------------

#[cfg(not(test))]
#[link(wasm_import_module = "__wasip1_vfs-host")]
unsafe extern "C" {
    fn vfs_execute_command(context_id: u32) -> i32;
}

#[cfg(test)]
unsafe fn vfs_execute_command(_context_id: u32) -> i32 {
    0
}

// ============================================================
// Shell configuration
// ============================================================

fn format_size(size: usize) -> String {
    if size < 1024 {
        format!("{} B", size)
    } else if size < 1024 * 1024 {
        format!("{:.1} KB", size as f64 / 1024.0)
    } else {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
    }
}

static BUILTIN_REGISTRY: LazyLock<Arc<CommandRegistry>> =
    LazyLock::new(|| Arc::new(CommandRegistry::with_builtins()));

fn create_session_registry(session_id: u32) -> Arc<CommandRegistry> {
    let mut reg = CommandRegistry::new();

    // Register session-aware wrappers for common built-ins
    for cmd in ["sl", "ls", "tree", "seq", "grep", "head", "help", "pwd"] {
        let sid = session_id;
        reg.register(cmd, move |args, io| {
            unsafe { vfs_set_current_session_id(sid) };
            (**BUILTIN_REGISTRY).execute(args, io)
        });
    }

    let sid = session_id;
    reg.register("load_sysroot", move |args, io| {
        unsafe { vfs_set_current_session_id(sid) };
        let triple = args.get(1).map(|s| s.as_str()).unwrap_or("wasm32-wasip1");
        let is_src = triple == "rust-src";

        if is_src {
            writeln!(io.stdout, "Loading Rust source...").unwrap();
        } else {
            writeln!(io.stdout, "Loading sysroot: {} ...", triple).unwrap();
        }

        unsafe {
            sysroot_start_fetch(triple.as_ptr() as i32, triple.len() as i32);
        }

        let mut files_loaded = 0;
        let mut total_bytes = 0;
        let start_time = std::time::Instant::now();

        let base_dir = if is_src {
            PathBuf::from("/sysroot/lib/rustlib/src/rust/library")
        } else {
            Path::new("/sysroot/lib/rustlib")
                .join(triple)
                .join("lib")
        };

        if !base_dir.exists() {
            std::fs::create_dir_all(&base_dir).unwrap_or_default();
        }

        loop {
            let mut name_len = 0i32;
            let mut data_len = 0i32;

            let has_next = unsafe {
                sysroot_get_next_file_meta(
                    &mut name_len as *mut _ as i32,
                    &mut data_len as *mut _ as i32,
                )
            };
            if has_next == 0 {
                break;
            }

            let mut name_buf = vec![0u8; name_len as usize];
            unsafe {
                sysroot_read_file_name(name_buf.as_mut_ptr() as i32, name_len);
            }

            let mut data_buf = Vec::new();
            if data_len >= 0 {
                data_buf = vec![0u8; data_len as usize];
                let mut remaining = data_len as usize;
                let mut offset = 0;
                let chunk_size = 512 * 1024;
                while remaining > 0 {
                    let to_read = std::cmp::min(remaining, chunk_size);
                    unsafe {
                        sysroot_read_file_chunk(
                            data_buf[offset..].as_mut_ptr() as i32,
                            to_read as i32,
                        );
                    }
                    offset += to_read;
                    remaining -= to_read;
                    total_bytes += to_read;

                    let elapsed = start_time.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 {
                        total_bytes as f64 / elapsed
                    } else {
                        0.0
                    };

                    if data_len > 1024 * 1024 {
                        let progress = (offset as f64 / data_len as f64) * 100.0;
                        write!(
                            io.stdout,
                            "\r\x1b[KLoading {}... [{:.1}%] Speed: {}/s",
                            String::from_utf8_lossy(&name_buf),
                            progress,
                            format_size(speed as usize)
                        )
                        .unwrap();
                        let _ = io.stdout.flush();
                    }
                }
            }

            if let Ok(name) = String::from_utf8(name_buf) {
                let file_path = base_dir.join(&name);
                if data_len == -1 {
                    std::fs::create_dir_all(&file_path).unwrap_or_default();
                } else {
                    if let Some(parent) = file_path.parent() {
                        std::fs::create_dir_all(parent).unwrap_or_default();
                    }

                    std::fs::write(&file_path, data_buf).unwrap_or_else(|e| {
                        writeln!(io.stderr, "Failed to write sysroot file '{}': {}", name, e)
                            .unwrap();
                    });
                }

                files_loaded += 1;
                let elapsed = start_time.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 {
                    total_bytes as f64 / elapsed
                } else {
                    0.0
                };

                write!(
                    io.stdout,
                    "\r\x1b[KLoaded {} files ({} total) - Speed: {}/s",
                    files_loaded,
                    format_size(total_bytes),
                    format_size(speed as usize)
                )
                .unwrap();
                let _ = io.stdout.flush();
            } else {
                writeln!(io.stderr, "Failed to decode sysroot file name").unwrap();
            }
        }
        let total_elapsed = start_time.elapsed();
        if is_src {
            writeln!(
                io.stdout,
                "\nRust source loaded successfully ({} files, {} total) in {:.1}s.",
                files_loaded,
                format_size(total_bytes),
                total_elapsed.as_secs_f64()
            )
            .unwrap();
        } else {
            writeln!(
                io.stdout,
                "\nSysroot '{}' loaded successfully ({} files, {} total) in {:.1}s.",
                triple,
                files_loaded,
                format_size(total_bytes),
                total_elapsed.as_secs_f64()
            )
            .unwrap();
        }
        Ok(())
    });

    let sid = session_id;
    reg.register("load_src", move |_args, io| {
        unsafe { vfs_set_current_session_id(sid) };
        // Just call load_sysroot with "rust-src"
        let registry = create_session_registry(sid);
        registry.execute(&["load_sysroot".to_string(), "rust-src".to_string()], io)
    });

    let sid = session_id;
    reg.register("cd", move |args, _ctx| {
        unsafe { vfs_set_current_session_id(sid) };
        let new_dir = args.get(1).map(|s| s.as_str()).unwrap_or("/");
        let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        let target = current.join(new_dir);

        let resolved =
            std::fs::canonicalize(&target).unwrap_or_else(|_| normalize_path_logical(&target));

        std::env::set_current_dir(&resolved).map_err(|e| format!("cd: {}", e))
    });

    let sid = session_id;
    reg.set_fallback(move |args: &[String], io: &mut IoContext| {
        unsafe { vfs_set_current_session_id(sid) };
        writeln!(io.stdout, "Executing command: {:?}", args).unwrap();

        let args_str = args.join("\0"); // serialize args with NUL separator
        let context_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

        // Store args in vfs-shell's memory for vfs to read via memcpy_to
        *CMD_ARGS.lock().unwrap() = args_str.into_bytes();

        // Register IoContext with Mutex for thread-safe writes
        IO_REGISTRY.insert(context_id, Mutex::new(IoPtr(io as *mut _ as usize)));

        // Call into vfs — scalar only, no pointer crossing Wasm boundary
        let status = unsafe { vfs_execute_command(context_id) };

        IO_REGISTRY.remove(&context_id);

        if status == 0 {
            Ok(())
        } else {
            Err(format!("Command exited with status: {}", status))
        }
    });
    Arc::new(reg)
}

#[derive(Debug, FromRepr)]
#[repr(u32)]
pub enum SessionEventType {
    InputChar = 0,
    Resize = 1,
    Interrupt = 2,
    CreateSession = 3,
    InputString = 4,
    CloseSession = 5,
}

#[derive(Debug)]
pub enum SessionEvent {
    InputChar(u32),
    Resize(u32, u32),
    Interrupt,
    CreateSession,
    InputString(String),
    CloseSession,
}

impl SessionEvent {
    pub fn from_raw(event_type: u32, arg1: u32, arg2: u32) -> Option<Self> {
        let ty = SessionEventType::from_repr(event_type)?;
        match ty {
            SessionEventType::InputChar => Some(Self::InputChar(arg1)),
            SessionEventType::Resize => Some(Self::Resize(arg1, arg2)),
            SessionEventType::Interrupt => Some(Self::Interrupt),
            SessionEventType::CreateSession => Some(Self::CreateSession),
            SessionEventType::InputString => {
                let ptr = arg1 as *const u8;
                let len = arg2 as usize;
                let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
                let s = String::from_utf8_lossy(slice).into_owned();
                Some(Self::InputString(s))
            }
            SessionEventType::CloseSession => Some(Self::CloseSession),
        }
    }
}

struct SessionState {
    sender: mpsc::Sender<SessionEvent>,
    cancellation_token: wasibox_core::CancellationToken,
}

static SESSIONS: LazyLock<DashMap<u32, SessionState>> = LazyLock::new(|| DashMap::new());

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_dispatch(session_id: u32, event_type: u32, arg1: u32, arg2: u32) {
    // println!(
    //     "[Shell] vfs_shell_dispatch: sid={}, ty={}, a1={}, a2={}",
    //     session_id, event_type, arg1, arg2
    // );
    let event = match SessionEvent::from_raw(event_type, arg1, arg2) {
        Some(e) => e,
        None => {
            // println!("[Shell] Unknown event type: {}", event_type);
            return;
        }
    };

    if let SessionEvent::Resize(cols, rows) = event {
        unsafe {
            std::env::set_var("COLUMNS", cols.to_string());
            std::env::set_var("LINES", rows.to_string());
        }
    }

    if let SessionEvent::CreateSession = event {
        // println!("[Shell] Creating session {}", session_id);
        let (tx, rx) = mpsc::channel();
        let cancellation_token = wasibox_core::CancellationToken::new();
        let state = SessionState {
            sender: tx,
            cancellation_token: cancellation_token.clone(),
        };
        SESSIONS.insert(session_id, state);
        std::thread::spawn(move || {
            run_session_loop(session_id, rx, cancellation_token);
        });
        return;
    }

    if let Some(session) = SESSIONS.get(&session_id) {
        if let SessionEvent::Interrupt = event {
            // println!("[Shell] Interrupting session {}", session_id);
            session.cancellation_token.cancel();
        } else if let SessionEvent::CloseSession = event {
            // println!("[Shell] Closing session {}", session_id);
            session.cancellation_token.cancel();
            drop(session);
            SESSIONS.remove(&session_id);
        } else {
            let _ = session.sender.send(event);
        }
    } else {
        // println!("[Shell] Session {} not found", session_id);
    }
}

#[derive(Clone)]
struct SessionStdout {
    session_id: u32,
}

impl SessionStdout {
    fn new(session_id: u32) -> Self {
        Self { session_id }
    }
}

impl Write for SessionStdout {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        unsafe {
            terminal_write(self.session_id, buf.as_ptr() as i32, buf.len() as i32);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn print_prompt(writer: &mut dyn Write) {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    write!(writer, "{} $ ", cwd.display().to_string().cyan()).unwrap();
    writer.flush().unwrap();
}

fn run_session_loop(
    session_id: u32,
    rx: mpsc::Receiver<SessionEvent>,
    cancellation_token: wasibox_core::CancellationToken,
) {
    // println!("[Shell] run_session_loop started for sid {}", session_id);
    unsafe { vfs_set_current_session_id(session_id) };
    CANCELLATION_TOKEN.with(|t| *t.borrow_mut() = Some(cancellation_token.clone()));

    let mut line_reader = LineEditor::new(20);
    let mut stdout = SessionStdout::new(session_id);
    let session_reg = create_session_registry(session_id);

    writeln!(stdout, "{}", "Welcome to WASI-Shell!".green().bold()).unwrap();
    writeln!(
        stdout,
        "Type 'help' for available commands or 'exit' to quit."
    )
    .unwrap();

    if session_id == 0 {
        let pre_lines = vec![
            "help",
            "echo Hello, World!",
            "ls -la",
            "tree",
            "seq | grep 2 | head -n5",
            "load_sysroot wasm32-wasip1",
        ];

        for line in pre_lines {
            writeln!(stdout, "{}", line).unwrap();
            let results = handle_parallel(
                vec![line.to_string()],
                Box::new(io::stdin()),
                Box::new(SessionStdout::new(session_id)),
                Arc::clone(&session_reg),
                cancellation_token.clone(),
            );
            for res in results {
                if let Err(e) = res {
                    writeln!(stdout, "{}", e.red()).unwrap();
                }
            }
        }
    }

    print_prompt(&mut stdout);

    while let Ok(event) = rx.recv() {
        // println!("[Shell] Session {} received event: {:?}", session_id, event);
        match event {
            SessionEvent::InputChar(c) => {
                process_input_char(
                    c,
                    &mut line_reader,
                    &cancellation_token,
                    &mut stdout,
                    &session_reg,
                    session_id,
                );
            }
            SessionEvent::InputString(s) => {
                for c in s.chars() {
                    process_input_char(
                        c as u32,
                        &mut line_reader,
                        &cancellation_token,
                        &mut stdout,
                        &session_reg,
                        session_id,
                    );
                }
            }
            SessionEvent::Resize(_cols, _rows) => {
                // Resize event logic is handled before dispatching
                // See `vfs_shell_dispatch` in vfs
            }
            SessionEvent::Interrupt => {
                cancellation_token.cancel();
            }
            SessionEvent::CreateSession => unreachable!(),
            SessionEvent::CloseSession => {
                // println!("[Shell] run_session_loop exiting for sid {}", session_id);
                break;
            }
        }
    }
}

fn process_input_char(
    c: u32,
    line_reader: &mut LineEditor,
    cancellation_token: &wasibox_core::CancellationToken,
    stdout: &mut SessionStdout,
    session_reg: &Arc<CommandRegistry>,
    session_id: u32,
) {
    // println!("[Shell] process_input_char: sid={}, char={}", session_id, c);
    if cancellation_token.is_cancelled() {
        cancellation_token.reset();
    }

    let len_before = line_reader.buffer().chars().count();
    let mut handler = TerminalEchoHandler {
        needs_redraw: false,
        writer: stdout,
    };
    let line = line_reader.input_char_with_handler(c, &mut handler);

    if handler.needs_redraw {
        write!(stdout, "\r").unwrap();
        print_prompt(stdout);
        let buffer = line_reader.buffer();
        write!(stdout, "{}", buffer).unwrap();
        write!(stdout, "\x1b[K").unwrap();

        let pos = line_reader.cursor_pos();
        let len = buffer.chars().count();
        if pos < len {
            write!(stdout, "\x1b[{}D", len - pos).unwrap();
        }
        stdout.flush().unwrap();
    } else {
        let pos_after = line_reader.cursor_pos();
        let len_after = line_reader.buffer().chars().count();
        if len_after > len_before && pos_after < len_after {
            let buffer = line_reader.buffer();
            let rest: String = buffer.chars().skip(pos_after).collect();
            if !rest.is_empty() {
                write!(stdout, "{}", rest).unwrap();
                write!(stdout, "\x1b[{}D", rest.chars().count()).unwrap();
                stdout.flush().unwrap();
            }
        }
    }

    if let Some(line) = line {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            print_prompt(stdout);
            return;
        }

        cancellation_token.reset();
        let results = handle_parallel(
            vec![trimmed.to_string()],
            Box::new(io::stdin()),
            Box::new(stdout.clone()),
            Arc::clone(session_reg),
            cancellation_token.clone(),
        );

        for res in results {
            if let Err(e) = res {
                writeln!(stdout, "{}", e.red()).unwrap();
            }
        }

        print_prompt(stdout);
    }
}

// ============================================================
// Main
// ============================================================

fn main() {
    let _ = LazyLock::force(&BUILTIN_REGISTRY);
    // Keep the main thread alive if needed, but returning is fine for wasi-threads
    // since background threads will keep running.
    // loop {
    //     std::thread::sleep(std::time::Duration::from_secs(3600));
    // }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_normalize_path_logical() {
        assert_eq!(
            normalize_path_logical(Path::new("/a/b/../c")),
            PathBuf::from("/a/c")
        );
        assert_eq!(
            normalize_path_logical(Path::new("/a/./b")),
            PathBuf::from("/a/b")
        );
        assert_eq!(
            normalize_path_logical(Path::new("/a/b/../..")),
            PathBuf::from("/")
        );
        assert_eq!(
            normalize_path_logical(Path::new("a/b/../c")),
            PathBuf::from("a/c")
        );
    }

    #[test]
    fn test_cd_parallel_execution() {
        // Ensure registry is initialized
        let registry = Arc::clone(&REGISTRY);

        // Use a temporary directory for testing if possible,
        // otherwise just test the logic with a simulated sequence.
        // In wasip1-threads, std::env::set_current_dir modifies process-wide state.

        let start_dir = std::env::current_dir().unwrap();

        // Simulate "cd . && cd ." which should be safe and stay in same dir
        let line = "cd . && cd .";
        let results = handle_parallel(
            vec![line.to_string()],
            Box::new(Cursor::new("")),
            Box::new(io::sink()),
            registry,
            wasibox_core::CancellationToken::new(),
        );

        for res in results {
            res.expect("Parallel cd command failed");
        }

        assert_eq!(
            std::env::current_dir().unwrap().canonicalize().unwrap(),
            start_dir.canonicalize().unwrap()
        );
    }

    #[test]
    fn test_shell_full_interaction_simulation() {
        let start_dir = std::env::current_dir().unwrap();

        // Ensure state is clean
        CANCELLATION_TOKEN.reset();

        // Simulate "cd . && cd .\n" input character by character
        // Most shells/terminals use 13 (\r) for Enter,
        // LineEditor usually maps 10 or 13 to KeyEvent::Enter.
        let cmd = "cd . && cd .\r";

        for c in cmd.chars() {
            vfs_shell_input_char(c as u32);
        }

        // vfs_shell_input_char handles command execution synchronously via handle_parallel,
        // so we can check the result immediately.
        assert_eq!(
            std::env::current_dir().unwrap().canonicalize().unwrap(),
            start_dir.canonicalize().unwrap()
        );
    }
}
