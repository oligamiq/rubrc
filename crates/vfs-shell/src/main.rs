use std::io::{self, Write};
use colored::*;
use dashmap::DashMap;
use std::sync::{LazyLock, Mutex, Arc};
use wasi_shell::{IoContext, CommandRegistry, handle_parallel, LineEditor, KeyEventHandler, KeyEvent};
use std::sync::atomic::{AtomicU32, Ordering};
use std::env;
use std::path::PathBuf;

// ============================================================
// Terminal Echo Handler
// ============================================================

struct TerminalEchoHandler {
    pub needs_redraw: bool,
}

impl KeyEventHandler for TerminalEchoHandler {
    fn on_key_event(&mut self, key: KeyEvent) {
        match key {
            KeyEvent::Enter => {
                print!("\r\n");
            }
            KeyEvent::CtrlC => {
                print!("^C\r\n");
                self.needs_redraw = true;
            }
            KeyEvent::Char(c) if c == '\x0c' => { // Ctrl+L
                print!("\x1b[2J\x1b[H");
                self.needs_redraw = true;
            }
            KeyEvent::Char(c) => {
                print!("{c}");
            }
            KeyEvent::Right => {
              print!("\x1b[1C");
            }
            KeyEvent::Left => {
              print!("\x1b[1D");
            }
            _ => {
                self.needs_redraw = true;
            }
        }
        io::stdout().flush().unwrap();
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

/// Allocates a buffer in vfs-shell's memory. Returns address as u32.
/// The caller (vfs) can then use vfs_shell::memcpy to write into this buffer.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_alloc_buf(len: u32) -> u32 {
    let buf: Box<[u8]> = vec![0u8; len as usize].into_boxed_slice();
    let ptr = Box::into_raw(buf) as *mut u8;
    ptr as u32
}

/// Frees a buffer previously allocated by vfs_shell_alloc_buf.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vfs_shell_free_buf(ptr: u32, len: u32) {
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
    if CANCELLATION_TOKEN.is_cancelled() {
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
    if CANCELLATION_TOKEN.is_cancelled() {
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
// Import: vfs_execute_command (scalar-only, no pointer args)
// ----------------------------------------------------------

#[link(wasm_import_module = "__wasip1_vfs-host")]
unsafe extern "C" {
    fn vfs_execute_command(context_id: u32) -> i32;
}

// ============================================================
// Shell configuration
// ============================================================

static REGISTRY: LazyLock<Arc<CommandRegistry>> = LazyLock::new(|| {
    let mut reg = CommandRegistry::with_builtins();
    reg.set_fallback(|args: &[String], io: &mut IoContext| {
        println!("Executing command: {:?}", args);

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
});

static CANCELLATION_TOKEN: LazyLock<wasibox_core::CancellationToken> =
    LazyLock::new(|| wasibox_core::CancellationToken::new());

static LINE_READER: LazyLock<Mutex<LineEditor>> = LazyLock::new(|| Mutex::new(LineEditor::new(20)));

// ============================================================
// Exported functions for host interaction
// ============================================================

fn print_prompt() {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    print!("{} $ ", cwd.display().to_string().cyan());
    io::stdout().flush().unwrap();
}

#[unsafe(no_mangle)]
/// This function works precisely because it does not interact with memory and stack at all.
/// If it were to modify anything other than shared memory,
/// it would break functions running on other threads. It would be like running the main function again on the same memory space.
/// In that case, it would be necessary to create a new thread and implement it
/// so that the shared memory held statically can be modified while that thread remains in a waiting state.
pub extern "C" fn vfs_shell_interrupt() {
    CANCELLATION_TOKEN.cancel();
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_resize(
  columns: u32,
  lines: u32,
) {
    unsafe { std::env::set_var("COLUMNS", columns.to_string()) };
    unsafe { std::env::set_var("LINES", lines.to_string()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_input_char(c: u32) {
    if CANCELLATION_TOKEN.is_cancelled() {
        CANCELLATION_TOKEN.reset();
    }

    // Delegate to LineReader — handles echo, history, cursor, etc.
    let line = {
        let mut reader = LINE_READER.lock().unwrap();
        let mut handler = TerminalEchoHandler { needs_redraw: false };
        let line = reader.input_char_with_handler(c, &mut handler);

        if handler.needs_redraw {
            // Soft redraw: don't clear the whole line to avoid flicker/prompt disappearance.
            // Move to start of line, re-print prompt and buffer, then clear to end of line.
            print!("\r");
            print_prompt();
            let buffer = reader.buffer();
            print!("{}", buffer);
            print!("\x1b[K"); // Clear from cursor to end of line (in case new line is shorter)

            let pos = reader.cursor_pos();
            let len = buffer.chars().count();
            if pos < len {
                print!("\x1b[{}D", len - pos);
            }
            io::stdout().flush().unwrap();
        }
        line
    };
    // Drop the lock before executing so subsequent input_char calls aren't blocked

    if let Some(line) = line {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            print_prompt();
            return;
        }

        CANCELLATION_TOKEN.reset();
        let results = handle_parallel(
            vec![trimmed.to_string()],
            Box::new(io::stdin()),
            Box::new(io::stdout()),
            Arc::clone(&REGISTRY),
            CANCELLATION_TOKEN.clone(),
        );

        for res in results {
            if let Err(e) = res {
                eprintln!("{}", e.red());
            }
        }

        print_prompt();
    }
}

// ============================================================
// Main
// ============================================================

fn main() {
    let _ = LazyLock::force(&REGISTRY);
    let _ = LazyLock::force(&LINE_READER);
    CANCELLATION_TOKEN.reset();

    println!("{}", "Welcome to WASI-Shell!".green().bold());
    println!("Type 'help' for available commands or 'exit' to quit.");

    let pre_lines = vec![
        "help",
        "echo Hello, World!",
        "ls -la",
        "tree",
        "seq | grep 2 | head -n5",
    ];

    for line in pre_lines {
        println!("{}", line);
        let results = handle_parallel(
            vec![line.to_string()],
            Box::new(io::stdin()),
            Box::new(io::stdout()),
            Arc::clone(&REGISTRY),
            CANCELLATION_TOKEN.clone(),
        );
        for res in results {
            if let Err(e) = res {
                eprintln!("{}", e.red());
            }
        }
    }

    print_prompt();
}
