mod startup_sysroot_bootstrap;
mod sysroot_extraction;

use colored::*;
use dashmap::DashMap;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::env;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use strum::FromRepr;
use unicode_width::UnicodeWidthStr;
use wasi_shell::{
    CommandRegistry, IoContext, KeyEvent, KeyEventHandler, LineEditor, handle_parallel,
};

use startup_sysroot_bootstrap::{StartupSysroot, StartupSysrootBootstraps, StartupSysrootError};
use sysroot_extraction::{
    SysrootArchiveReader, extract_sysroot_archive, sysroot_meta_has_file, with_sysroot_load_lock,
};

macro_rules! debug_log {
    ($($arg:tt)*) => {
        #[cfg(feature = "debug-log")]
        eprintln!($($arg)*);
    };
}

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
// Special key code → ANSI escape sequence translation
// ============================================================

fn special_key_bytes(c: u32) -> Option<&'static [u8]> {
    match c {
        0x110001 => Some(b"\x1b[A"),
        0x110002 => Some(b"\x1b[B"),
        0x110003 => Some(b"\x1b[C"),
        0x110004 => Some(b"\x1b[D"),
        0x110005 => Some(b"\x1b[H"),
        0x110006 => Some(b"\x1b[F"),
        0x110007 => Some(b"\x1b[3~"),
        _ => None,
    }
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
                self.needs_redraw = true;
            }
            KeyEvent::Left => {
                self.needs_redraw = true;
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

// The IoContext pointer is always in vfs-shell's own memory space. stderr is
// routed directly to the session terminal to avoid re-entering VFS fd_write.
struct IoPtr {
    io: usize,
    session_id: u32,
}
unsafe impl Send for IoPtr {}
unsafe impl Sync for IoPtr {}

// Each context_id maps to a Mutex<IoPtr> for thread-safe writes.
static IO_REGISTRY: LazyLock<DashMap<u32, Mutex<IoPtr>>> = LazyLock::new(|| DashMap::new());
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

// Buffer for passing command args from vfs-shell to vfs.
// vfs-shell writes here; vfs reads via vfs_shell::memcpy_to.
static CMD_ARGS: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
enum AdditionalSysrootState {
    Pending = 0,
    Loading = 1,
    Ready = 2,
    Failed = 3,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
enum AdditionalSysrootError {
    None = 0,
    Fetch = 1,
    Extract = 2,
    InvalidRequest = 3,
    Cancelled = 4,
}

#[derive(Clone, Copy)]
struct AdditionalSysrootRequest {
    id: u32,
    state: AdditionalSysrootState,
    error: AdditionalSysrootError,
    cancelled: bool,
}

impl AdditionalSysrootRequest {
    const EMPTY: Self = Self {
        id: 0,
        state: AdditionalSysrootState::Pending,
        error: AdditionalSysrootError::None,
        cancelled: false,
    };
}

struct AdditionalSysrootRequests<const N: usize> {
    slots: Mutex<[AdditionalSysrootRequest; N]>,
    next_id: AtomicU32,
}

impl<const N: usize> AdditionalSysrootRequests<N> {
    const fn new() -> Self {
        Self {
            slots: Mutex::new([AdditionalSysrootRequest::EMPTY; N]),
            next_id: AtomicU32::new(1),
        }
    }

    fn slots(&self) -> std::sync::MutexGuard<'_, [AdditionalSysrootRequest; N]> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn register(&self) -> u32 {
        let mut slots = self.slots();
        let Some(slot_index) = slots.iter().position(|slot| slot.id == 0) else {
            return 0;
        };
        let id = self.next_id.load(Ordering::Relaxed);
        if id == 0 {
            return 0;
        }
        self.next_id.store(id.wrapping_add(1), Ordering::Relaxed);
        slots[slot_index] = AdditionalSysrootRequest {
            id,
            state: AdditionalSysrootState::Pending,
            error: AdditionalSysrootError::None,
            cancelled: false,
        };
        id
    }

    fn begin(&self, id: u32) -> bool {
        let mut slots = self.slots();
        let Some(slot) = slots.iter_mut().find(|slot| slot.id == id) else {
            return false;
        };
        if slot.state != AdditionalSysrootState::Pending {
            return false;
        }
        slot.state = AdditionalSysrootState::Loading;
        true
    }

    fn finish(&self, id: u32, result: Result<(), AdditionalSysrootError>) {
        let mut slots = self.slots();
        let Some(slot) = slots.iter_mut().find(|slot| slot.id == id) else {
            return;
        };
        if slot.state != AdditionalSysrootState::Loading {
            return;
        }
        if slot.cancelled {
            slot.state = AdditionalSysrootState::Failed;
            slot.error = AdditionalSysrootError::Cancelled;
            return;
        }
        match result {
            Ok(()) => {
                slot.state = AdditionalSysrootState::Ready;
                slot.error = AdditionalSysrootError::None;
            }
            Err(error) => {
                slot.state = AdditionalSysrootState::Failed;
                slot.error = error;
            }
        }
    }

    fn state_code(&self, id: u32) -> u32 {
        self.slots()
            .iter()
            .find(|slot| slot.id == id)
            .map(|slot| slot.state as u32)
            .unwrap_or(AdditionalSysrootState::Failed as u32)
    }

    fn error_code(&self, id: u32) -> u32 {
        self.slots()
            .iter()
            .find(|slot| slot.id == id)
            .map(|slot| slot.error as u32)
            .unwrap_or(AdditionalSysrootError::InvalidRequest as u32)
    }

    fn release(&self, id: u32) -> u32 {
        let mut slots = self.slots();
        let Some(slot) = slots.iter_mut().find(|slot| slot.id == id) else {
            return 0;
        };
        if !matches!(
            slot.state,
            AdditionalSysrootState::Ready | AdditionalSysrootState::Failed
        ) {
            return 0;
        }
        *slot = AdditionalSysrootRequest::EMPTY;
        1
    }

    fn cancel(&self, id: u32) -> u32 {
        let mut slots = self.slots();
        let Some(slot) = slots.iter_mut().find(|slot| slot.id == id) else {
            return 0;
        };
        match slot.state {
            AdditionalSysrootState::Pending => {
                slot.state = AdditionalSysrootState::Failed;
                slot.error = AdditionalSysrootError::Cancelled;
            }
            AdditionalSysrootState::Loading => slot.cancelled = true,
            AdditionalSysrootState::Ready | AdditionalSysrootState::Failed => return 0,
        }
        1
    }

    fn is_cancelled(&self, id: u32) -> bool {
        self.slots()
            .iter()
            .find(|slot| slot.id == id)
            .is_some_and(|slot| slot.cancelled)
    }
}

const ADDITIONAL_SYSROOT_REQUEST_CAPACITY: usize = 8;
static ADDITIONAL_SYSROOT_REQUESTS: AdditionalSysrootRequests<ADDITIONAL_SYSROOT_REQUEST_CAPACITY> =
    AdditionalSysrootRequests::new();

fn additional_sysroot_command_result(
    result: Result<(), String>,
) -> Result<(), AdditionalSysrootError> {
    result.map_err(|message| {
        if message.contains("additional sysroot request cancelled") {
            AdditionalSysrootError::Cancelled
        } else if StartupSysrootError::from_load_error(&message) == StartupSysrootError::Fetch {
            AdditionalSysrootError::Fetch
        } else {
            AdditionalSysrootError::Extract
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_additional_sysroot_register() -> u32 {
    ADDITIONAL_SYSROOT_REQUESTS.register()
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_additional_sysroot_state(request_id: u32) -> u32 {
    ADDITIONAL_SYSROOT_REQUESTS.state_code(request_id)
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_additional_sysroot_error_code(request_id: u32) -> u32 {
    ADDITIONAL_SYSROOT_REQUESTS.error_code(request_id)
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_additional_sysroot_cancel(request_id: u32) -> u32 {
    ADDITIONAL_SYSROOT_REQUESTS.cancel(request_id)
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_additional_sysroot_release(request_id: u32) -> u32 {
    ADDITIONAL_SYSROOT_REQUESTS.release(request_id)
}

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
            let io = unsafe { &mut *(guard.io as *mut IoContext) };
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
            unsafe { terminal_write(guard.session_id, ptr as i32, len as i32) };
            return len;
        }
    }
    0
}

// ----------------------------------------------------------

#[link(wasm_import_module = "__wasip1_vfs-host")]
unsafe extern "C" {
    #[link_name = "sysroot_start_fetch"]
    pub fn sysroot_start_fetch(triple_ptr: i32, triple_len: i32);

    #[link_name = "sysroot_get_archive_meta"]
    pub fn sysroot_get_archive_meta(data_len_ptr: i32) -> i32;

    #[link_name = "sysroot_read_archive_chunk"]
    pub fn sysroot_read_archive_chunk(data_ptr: i32, chunk_len: i32);

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

const VFS_COMMANDS: &[&str] = &[
    "cargo",
    "clang",
    "download",
    "llvm",
    "rust-analyzer",
    "rustc",
];
const SESSION_COMMANDS: &[&str] = &["load_src", "load_sysroot"];

fn print_available_commands(io: &mut IoContext) {
    writeln!(io.stdout, "{}", "Available Commands:".yellow().bold()).unwrap();

    let mut builtins: Vec<&str> = BUILTIN_REGISTRY.command_names();
    builtins.sort();
    writeln!(io.stdout, "  Builtins:  {}", builtins.join(", ")).unwrap();

    let mut vfs_cmds: Vec<&str> = VFS_COMMANDS.iter().copied().collect();
    vfs_cmds.sort();
    writeln!(io.stdout, "  External:  {}", vfs_cmds.join(", ")).unwrap();

    let mut session_cmds: Vec<&str> = SESSION_COMMANDS.iter().copied().collect();
    session_cmds.sort();
    writeln!(io.stdout, "  Session:   {}", session_cmds.join(", ")).unwrap();
}

fn create_session_registry(session_id: u32) -> Arc<CommandRegistry> {
    let mut reg = CommandRegistry::new();

    // Register session-aware wrappers for ALL built-in commands so that
    // every utility (echo, cat, rm, …) gets the session id set before
    // execution.  Commands that need custom session handling (cd,
    // load_sysroot, …) are registered afterwards and override the wrapper.
    for cmd in BUILTIN_REGISTRY.command_names() {
        let sid = session_id;
        reg.register(cmd.to_string(), move |args, io| {
            unsafe { vfs_set_current_session_id(sid) };
            (**BUILTIN_REGISTRY).execute(args, io)
        });
    }

    // Override help to list VFS and session commands in addition to builtins.
    let sid = session_id;
    reg.register("help", move |_args, io| {
        unsafe { vfs_set_current_session_id(sid) };
        print_available_commands(io);
        Ok(())
    });

    let sid = session_id;
    reg.register("load_sysroot", move |args, io| {
        unsafe { vfs_set_current_session_id(sid) };
        let triple = args.get(1).map(|s| s.as_str()).unwrap_or("wasm32-wasip1");
        let request_id = args
            .get(2)
            .map(|value| {
                value
                    .parse::<u32>()
                    .map_err(|_| format!("invalid additional sysroot request id: {value}"))
            })
            .transpose()?;
        if request_id.is_some_and(|id| !ADDITIONAL_SYSROOT_REQUESTS.begin(id)) {
            return Err(format!(
                "invalid additional sysroot request id: {}",
                request_id.unwrap()
            ));
        }
        let is_src = triple == "rust-src";

        if is_src {
            writeln!(io.stdout, "Loading Rust source...").unwrap();
        } else {
            writeln!(io.stdout, "Loading sysroot: {} ...", triple).unwrap();
        }

        let base_dir = if is_src {
            PathBuf::from("/sysroot/lib/rustlib/src/rust/library")
        } else {
            Path::new("/sysroot/lib/rustlib").join(triple).join("lib")
        };
        let load_result = with_sysroot_load_lock(|| {
            unsafe {
                sysroot_start_fetch(triple.as_ptr() as i32, triple.len() as i32);
            }

            std::fs::create_dir_all(&base_dir).map_err(|error| {
                format!(
                    "failed to create sysroot base directory '{}': {error}",
                    base_dir.display()
                )
            })?;

            let start_time = std::time::Instant::now();
            let mut archive_len = 0i32;
            let has_archive =
                unsafe { sysroot_get_archive_meta(&mut archive_len as *mut _ as i32) };
            if !sysroot_meta_has_file(has_archive, triple)? {
                return Err(format!("sysroot archive for '{triple}' is unavailable"));
            }
            let archive_len = usize::try_from(archive_len)
                .map_err(|_| format!("invalid sysroot archive length: {archive_len}"))?;
            let mut archive_bytes_read = 0usize;
            let mut last_progress_bytes = 0usize;
            let archive_reader = SysrootArchiveReader::new(
                archive_len,
                || request_id.is_some_and(|id| ADDITIONAL_SYSROOT_REQUESTS.is_cancelled(id)),
                |buffer: &mut [u8]| {
                    let chunk_len = i32::try_from(buffer.len()).map_err(|_| {
                        std::io::Error::other("sysroot archive read request exceeds i32::MAX")
                    })?;
                    unsafe {
                        sysroot_read_archive_chunk(buffer.as_mut_ptr() as i32, chunk_len);
                    }
                    archive_bytes_read += buffer.len();
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 {
                        archive_bytes_read as f64 / elapsed
                    } else {
                        0.0
                    };
                    if archive_len > 1024 * 1024
                        && (archive_bytes_read == archive_len
                            || archive_bytes_read.saturating_sub(last_progress_bytes)
                                >= 1024 * 1024)
                    {
                        let progress = (archive_bytes_read as f64 / archive_len as f64) * 100.0;
                        write!(
                            io.stdout,
                            "\r\x1b[KDownloading archive... [{:.1}%] Speed: {}/s",
                            progress,
                            format_size(speed as usize)
                        )
                        .unwrap();
                        let _ = io.stdout.flush();
                        last_progress_bytes = archive_bytes_read;
                    }
                    Ok(())
                },
            );

            let (files_loaded, total_bytes) = extract_sysroot_archive(&base_dir, archive_reader)?;

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

            Ok((files_loaded, total_bytes, start_time.elapsed()))
        });
        if let Some(request_id) = request_id {
            ADDITIONAL_SYSROOT_REQUESTS.finish(
                request_id,
                additional_sysroot_command_result(
                    load_result
                        .as_ref()
                        .map(|_| ())
                        .map_err(|error| error.clone()),
                ),
            );
        }
        let (files_loaded, total_bytes, total_elapsed) = load_result?;
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

        let cmd = args.get(0).map(|s| s.as_str()).unwrap_or("");

        if VFS_COMMANDS.contains(&cmd) {
            debug_log!(
                "[vfs-shell-debug] fallback:enter sid={} tid={:?} cmd={}",
                sid,
                std::thread::current().id(),
                args.join(" ")
            );
            let args_str = args.join("\0");
            let context_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

            *CMD_ARGS.lock().unwrap() = args_str.into_bytes();

            IO_REGISTRY.insert(
                context_id,
                Mutex::new(IoPtr {
                    io: io as *mut _ as usize,
                    session_id: sid,
                }),
            );

            debug_log!(
                "[vfs-shell-debug] fallback:vfs_execute_command:enter sid={} tid={:?} context_id={}",
                sid,
                std::thread::current().id(),
                context_id
            );
            let status = unsafe { vfs_execute_command(context_id) };
            debug_log!(
                "[vfs-shell-debug] fallback:vfs_execute_command:return sid={} tid={:?} context_id={} status={}",
                sid,
                std::thread::current().id(),
                context_id,
                status
            );

            IO_REGISTRY.remove(&context_id);

            if status == 0 {
                Ok(())
            } else {
                Err(format!("Command exited with status: {}", status))
            }
        } else {
            writeln!(io.stdout, "{}", format!("command not found: {}", cmd).red()).unwrap();
            print_available_commands(io);
            Ok(())
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
    BootstrapRustSrc = 6,
    BootstrapTarget = 7,
}

#[derive(Debug)]
pub enum SessionEvent {
    InputChar(u32),
    Resize(u32, u32),
    Interrupt,
    CreateSession,
    InputString(String),
    CloseSession,
    BootstrapRustSrc,
    BootstrapTarget,
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
            SessionEventType::BootstrapRustSrc => Some(Self::BootstrapRustSrc),
            SessionEventType::BootstrapTarget => Some(Self::BootstrapTarget),
        }
    }
}

struct SessionState {
    sender: mpsc::Sender<SessionEvent>,
    cancellation_token: wasibox_core::CancellationToken,
}

static SESSIONS: LazyLock<DashMap<u32, SessionState>> = LazyLock::new(|| DashMap::new());
const RUST_SRC_CORE: &str = "/sysroot/lib/rustlib/src/rust/library/core/src/lib.rs";
const STARTUP_TARGET_LIB: &str = "/sysroot/lib/rustlib/wasm32-wasip1/lib";
static STARTUP_SYSROOTS: StartupSysrootBootstraps = StartupSysrootBootstraps::new();

fn rust_src_core_exists_at(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

fn rust_src_core_exists() -> bool {
    rust_src_core_exists_at(Path::new(RUST_SRC_CORE))
}

fn target_core_exists_at(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("libcore-") && name.ends_with(".rlib")
        })
    })
}

fn target_core_exists() -> bool {
    target_core_exists_at(Path::new(STARTUP_TARGET_LIB))
}

struct BootstrapCommandOutcome {
    result: Result<(), StartupSysrootError>,
    report: Option<String>,
}

fn bootstrap_command_outcome(
    triple: &str,
    sentinel: &str,
    command_error: Option<&str>,
    sentinel_exists: bool,
) -> BootstrapCommandOutcome {
    if let Some(error) = command_error {
        BootstrapCommandOutcome {
            result: Err(StartupSysrootError::from_load_error(error)),
            report: Some(format!("{triple} bootstrap failed: {error}")),
        }
    } else if !sentinel_exists {
        BootstrapCommandOutcome {
            result: Err(StartupSysrootError::MissingSentinel),
            report: Some(format!("{triple} bootstrap failed: missing {sentinel}")),
        }
    } else {
        BootstrapCommandOutcome {
            result: Ok(()),
            report: None,
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_startup_sysroot_load_state(kind: u32) -> u32 {
    STARTUP_SYSROOTS.load_state_code(kind)
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_startup_sysroot_error_code(kind: u32) -> u32 {
    STARTUP_SYSROOTS.error_code(kind)
}

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
    debug_log!(
        "[vfs-shell-debug] prompt:enter tid={:?}",
        std::thread::current().id()
    );
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    write!(writer, "{} $ ", cwd.display().to_string().cyan()).unwrap();
    writer.flush().unwrap();
    debug_log!(
        "[vfs-shell-debug] prompt:return tid={:?}",
        std::thread::current().id()
    );
}

struct CommandStdin {
    rx: Arc<Mutex<mpsc::Receiver<SessionEvent>>>,
    deferred_events: Arc<Mutex<VecDeque<SessionEvent>>>,
    cancellation_token: wasibox_core::CancellationToken,
    buffer: Vec<u8>,
}

fn defer_startup_event(deferred_events: &Mutex<VecDeque<SessionEvent>>, event: SessionEvent) {
    deferred_events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push_back(event);
}

impl Read for CommandStdin {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.cancellation_token.is_cancelled() {
                return Ok(0);
            }
            if !self.buffer.is_empty() {
                let len = std::cmp::min(buf.len(), self.buffer.len());
                buf[..len].copy_from_slice(&self.buffer[..len]);
                self.buffer.drain(..len);
                return Ok(len);
            }

            let event = {
                let rx = self.rx.lock().unwrap();
                match rx.recv() {
                    Ok(e) => e,
                    Err(_) => return Ok(0),
                }
            };

            match event {
                SessionEvent::InputChar(c) => {
                    if let Some(ch) = char::from_u32(c) {
                        let mut b = [0; 4];
                        let result = ch.encode_utf8(&mut b);
                        let bytes = result.as_bytes();
                        let len = std::cmp::min(buf.len(), bytes.len());
                        buf[..len].copy_from_slice(&bytes[..len]);
                        if len < bytes.len() {
                            self.buffer.extend_from_slice(&bytes[len..]);
                        }
                        return Ok(len);
                    } else {
                        if let Some(bytes) = special_key_bytes(c) {
                            let len = std::cmp::min(buf.len(), bytes.len());
                            buf[..len].copy_from_slice(&bytes[..len]);
                            if len < bytes.len() {
                                self.buffer.extend_from_slice(&bytes[len..]);
                            }
                            return Ok(len);
                        }
                        continue;
                    }
                }
                SessionEvent::InputString(s) => {
                    let bytes = s.into_bytes();
                    if bytes.is_empty() {
                        continue;
                    }
                    let len = std::cmp::min(buf.len(), bytes.len());
                    buf[..len].copy_from_slice(&bytes[..len]);
                    if len < bytes.len() {
                        self.buffer.extend_from_slice(&bytes[len..]);
                    }
                    return Ok(len);
                }
                SessionEvent::Interrupt => {
                    self.cancellation_token.cancel();
                    return Ok(0);
                }
                SessionEvent::CloseSession => {
                    return Ok(0);
                }
                SessionEvent::Resize(_, _) => {
                    continue;
                }
                SessionEvent::CreateSession => {
                    continue;
                }
                event @ (SessionEvent::BootstrapRustSrc | SessionEvent::BootstrapTarget) => {
                    defer_startup_event(&self.deferred_events, event);
                    continue;
                }
            }
        }
    }
}

fn run_session_loop(
    session_id: u32,
    rx: mpsc::Receiver<SessionEvent>,
    cancellation_token: wasibox_core::CancellationToken,
) {
    unsafe { vfs_set_current_session_id(session_id) };
    CANCELLATION_TOKEN.with(|t| *t.borrow_mut() = Some(cancellation_token.clone()));

    let rx_arc = Arc::new(Mutex::new(rx));
    let deferred_events = Arc::new(Mutex::new(VecDeque::new()));
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
        ];

        for line in pre_lines {
            writeln!(stdout, "{}", line).unwrap();

            let cmd_stdin = CommandStdin {
                rx: Arc::clone(&rx_arc),
                deferred_events: Arc::clone(&deferred_events),
                cancellation_token: cancellation_token.clone(),
                buffer: Vec::new(),
            };

            let results = handle_parallel(
                vec![line.to_string()],
                Box::new(cmd_stdin),
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

    loop {
        let event = {
            let deferred = deferred_events
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front();
            if let Some(event) = deferred {
                event
            } else {
                let rx = rx_arc.lock().unwrap();
                match rx.recv() {
                    Ok(e) => e,
                    Err(_) => break,
                }
            }
        };

        match event {
            SessionEvent::InputChar(c) => {
                process_input_char(
                    c,
                    &mut line_reader,
                    &cancellation_token,
                    &mut stdout,
                    &session_reg,
                    session_id,
                    &rx_arc,
                    &deferred_events,
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
                        &rx_arc,
                        &deferred_events,
                    );
                }
            }
            SessionEvent::Resize(_cols, _rows) => {}
            SessionEvent::Interrupt => {
                cancellation_token.cancel();
            }
            SessionEvent::CreateSession => unreachable!(),
            SessionEvent::CloseSession => {
                break;
            }
            event @ (SessionEvent::BootstrapRustSrc | SessionEvent::BootstrapTarget) => {
                let (kind, triple, sentinel, sentinel_exists): (
                    StartupSysroot,
                    &str,
                    &str,
                    fn() -> bool,
                ) = match event {
                    SessionEvent::BootstrapRustSrc => (
                        StartupSysroot::RustSrc,
                        "rust-src",
                        RUST_SRC_CORE,
                        rust_src_core_exists,
                    ),
                    SessionEvent::BootstrapTarget => (
                        StartupSysroot::Target,
                        "wasm32-wasip1",
                        STARTUP_TARGET_LIB,
                        target_core_exists,
                    ),
                    _ => unreachable!(),
                };
                if !STARTUP_SYSROOTS.begin(kind) {
                    continue;
                }
                let command_stdin = CommandStdin {
                    rx: Arc::clone(&rx_arc),
                    deferred_events: Arc::clone(&deferred_events),
                    cancellation_token: cancellation_token.clone(),
                    buffer: Vec::new(),
                };
                let results = handle_parallel(
                    vec![format!("load_sysroot {triple}")],
                    Box::new(command_stdin),
                    Box::new(SessionStdout::new(session_id)),
                    Arc::clone(&session_reg),
                    cancellation_token.clone(),
                );
                let command_error = results.into_iter().find_map(Result::err);
                let has_sentinel = command_error.is_none() && sentinel_exists();
                let BootstrapCommandOutcome { result, report } = bootstrap_command_outcome(
                    triple,
                    sentinel,
                    command_error.as_deref(),
                    has_sentinel,
                );
                if let Some(report) = report {
                    writeln!(stdout, "{report}").unwrap();
                }
                STARTUP_SYSROOTS.finish(kind, result);
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
    _session_id: u32,
    rx_arc: &Arc<Mutex<mpsc::Receiver<SessionEvent>>>,
    deferred_events: &Arc<Mutex<VecDeque<SessionEvent>>>,
) {
    if cancellation_token.is_cancelled() {
        cancellation_token.reset();
    }

    let len_before = line_reader.buffer().len();
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
        if pos < buffer.len() {
            let suffix_width = UnicodeWidthStr::width(&buffer[pos..]);
            if suffix_width > 0 {
                write!(stdout, "\x1b[{}D", suffix_width).unwrap();
            }
        }
        stdout.flush().unwrap();
    } else {
        let pos_after = line_reader.cursor_pos();
        let len_after = line_reader.buffer().len();
        if len_after > len_before && pos_after < len_after {
            let buffer = line_reader.buffer();
            let rest = &buffer[pos_after..];
            if !rest.is_empty() {
                write!(stdout, "{}", rest).unwrap();
                let rest_width = UnicodeWidthStr::width(rest);
                if rest_width > 0 {
                    write!(stdout, "\x1b[{}D", rest_width).unwrap();
                }
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

        let cmd_stdin = CommandStdin {
            rx: Arc::clone(rx_arc),
            deferred_events: Arc::clone(deferred_events),
            cancellation_token: cancellation_token.clone(),
            buffer: Vec::new(),
        };

        debug_log!(
            "[vfs-shell-debug] handle_parallel:enter tid={:?} line={}",
            std::thread::current().id(),
            trimmed
        );
        let results = handle_parallel(
            vec![trimmed.to_string()],
            Box::new(cmd_stdin),
            Box::new(stdout.clone()),
            Arc::clone(session_reg),
            cancellation_token.clone(),
        );
        debug_log!(
            "[vfs-shell-debug] handle_parallel:return tid={:?} results={}",
            std::thread::current().id(),
            results.len()
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
    use crate::startup_sysroot_bootstrap::LoadState;

    #[test]
    fn additional_sysroot_requests_are_bounded_and_reusable() {
        let requests = AdditionalSysrootRequests::<2>::new();

        let first = requests.register();
        let second = requests.register();
        assert_ne!(first, 0);
        assert_ne!(second, 0);
        assert_ne!(first, second);
        assert_eq!(requests.register(), 0);
        assert_eq!(
            requests.state_code(first),
            AdditionalSysrootState::Pending as u32
        );

        assert_eq!(requests.release(first), 0);
        assert!(requests.begin(first));
        requests.finish(first, Ok(()));
        assert_eq!(requests.release(first), 1);
        assert_eq!(requests.release(first), 0);
        let replacement = requests.register();
        assert_ne!(replacement, 0);
        assert_ne!(replacement, first);
        assert_eq!(
            requests.state_code(first),
            AdditionalSysrootState::Failed as u32
        );
        assert_eq!(
            requests.error_code(first),
            AdditionalSysrootError::InvalidRequest as u32
        );
    }

    #[test]
    fn additional_sysroot_request_ids_skip_zero_and_active_ids_after_wrap() {
        let requests = AdditionalSysrootRequests::<3>::new();
        let first = requests.register();
        assert_eq!(first, 1);

        requests.next_id.store(u32::MAX, Ordering::Relaxed);
        let maximum = requests.register();
        assert_eq!(maximum, u32::MAX);
        assert!(requests.begin(first));
        requests.finish(first, Ok(()));
        assert_eq!(requests.release(first), 1);
        assert_eq!(requests.register(), 0);
    }

    #[test]
    fn additional_sysroot_loading_request_cancels_then_fails_terminally() {
        let requests = AdditionalSysrootRequests::<1>::new();
        let request_id = requests.register();

        assert!(requests.begin(request_id));
        assert_eq!(requests.cancel(request_id), 1);
        assert!(requests.is_cancelled(request_id));
        assert_eq!(requests.release(request_id), 0);
        requests.finish(request_id, Err(AdditionalSysrootError::Cancelled));
        assert_eq!(
            requests.state_code(request_id),
            AdditionalSysrootState::Failed as u32
        );
        assert_eq!(
            requests.error_code(request_id),
            AdditionalSysrootError::Cancelled as u32
        );
        assert_eq!(requests.release(request_id), 1);
    }

    #[test]
    fn additional_sysroot_cancel_wins_final_success_race() {
        let requests = AdditionalSysrootRequests::<1>::new();
        let request_id = requests.register();

        assert!(requests.begin(request_id));
        assert_eq!(requests.cancel(request_id), 1);
        requests.finish(request_id, Ok(()));

        assert_eq!(
            requests.state_code(request_id),
            AdditionalSysrootState::Failed as u32
        );
        assert_eq!(
            requests.error_code(request_id),
            AdditionalSysrootError::Cancelled as u32
        );
    }

    #[test]
    fn additional_sysroot_pending_request_cancels_terminally() {
        let requests = AdditionalSysrootRequests::<1>::new();
        let request_id = requests.register();

        assert_eq!(requests.cancel(request_id), 1);
        assert_eq!(
            requests.state_code(request_id),
            AdditionalSysrootState::Failed as u32
        );
        assert_eq!(
            requests.error_code(request_id),
            AdditionalSysrootError::Cancelled as u32
        );
        assert_eq!(requests.release(request_id), 1);
    }

    #[test]
    fn additional_sysroot_cancel_rejects_terminal_and_unknown_requests() {
        let requests = AdditionalSysrootRequests::<1>::new();
        let request_id = requests.register();
        assert_eq!(requests.cancel(u32::MAX), 0);

        assert!(requests.begin(request_id));
        requests.finish(request_id, Ok(()));
        assert_eq!(requests.cancel(request_id), 0);
    }

    #[test]
    fn additional_sysroot_requests_record_terminal_command_results() {
        let requests = AdditionalSysrootRequests::<1>::new();
        let request_id = requests.register();

        assert!(requests.begin(request_id));
        assert_eq!(
            requests.state_code(request_id),
            AdditionalSysrootState::Loading as u32
        );
        assert_eq!(requests.release(request_id), 0);
        requests.finish(request_id, Ok(()));
        assert_eq!(
            requests.state_code(request_id),
            AdditionalSysrootState::Ready as u32
        );
        assert_eq!(
            requests.error_code(request_id),
            AdditionalSysrootError::None as u32
        );

        assert_eq!(requests.release(request_id), 1);
        let failed_id = requests.register();
        assert!(requests.begin(failed_id));
        requests.finish(failed_id, Err(AdditionalSysrootError::Fetch));
        assert_eq!(
            requests.state_code(failed_id),
            AdditionalSysrootState::Failed as u32
        );
        assert_eq!(
            requests.error_code(failed_id),
            AdditionalSysrootError::Fetch as u32
        );
        assert!(!requests.begin(failed_id));
    }

    #[test]
    fn additional_sysroot_command_outcome_classifies_failures() {
        assert_eq!(additional_sysroot_command_result(Ok(())), Ok(()));
        assert_eq!(
            additional_sysroot_command_result(Err(
                "sysroot archive for 'x86_64-unknown-linux-gnu' is unavailable".to_string()
            )),
            Err(AdditionalSysrootError::Fetch)
        );
        assert_eq!(
            additional_sysroot_command_result(Err(
                "failed to decode sysroot archive entry".to_string()
            )),
            Err(AdditionalSysrootError::Extract)
        );
        assert_eq!(
            additional_sysroot_command_result(Err(
                "additional sysroot request cancelled".to_string()
            )),
            Err(AdditionalSysrootError::Cancelled)
        );
    }

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
    fn startup_sysroot_bootstrap_requires_nonempty_rust_src_core() {
        let path = std::env::temp_dir().join(format!("rubrc-rust-src-core-{}", std::process::id()));
        std::fs::write(&path, []).unwrap();
        assert!(!rust_src_core_exists_at(&path));

        std::fs::write(&path, b"pub mod core;\n").unwrap();
        assert!(rust_src_core_exists_at(&path));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn startup_sysroot_bootstrap_requires_target_libcore_rlib() {
        let path =
            std::env::temp_dir().join(format!("rubrc-target-libcore-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("libcore.rlib"), b"not hashed").unwrap();
        std::fs::write(path.join("libcore-example.rmeta"), b"wrong suffix").unwrap();
        assert!(!target_core_exists_at(&path));

        std::fs::write(path.join("libcore-example.rlib"), b"core").unwrap();
        assert!(target_core_exists_at(&path));
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn startup_sysroot_bootstrap_events_are_deferred_during_command_input() {
        let (sender, receiver) = mpsc::channel();
        sender.send(SessionEvent::BootstrapRustSrc).unwrap();
        sender.send(SessionEvent::BootstrapTarget).unwrap();
        sender.send(SessionEvent::Interrupt).unwrap();
        let deferred_events = Arc::new(Mutex::new(VecDeque::new()));
        let mut stdin = CommandStdin {
            rx: Arc::new(Mutex::new(receiver)),
            deferred_events: Arc::clone(&deferred_events),
            cancellation_token: wasibox_core::CancellationToken::new(),
            buffer: Vec::new(),
        };
        assert_eq!(stdin.read(&mut [0; 1]).unwrap(), 0);

        let mut events = deferred_events.lock().unwrap();
        assert!(matches!(
            events.pop_front(),
            Some(SessionEvent::BootstrapRustSrc)
        ));
        assert!(matches!(
            events.pop_front(),
            Some(SessionEvent::BootstrapTarget)
        ));
        assert!(events.is_empty());
    }

    #[test]
    fn startup_sysroot_bootstrap_command_outcomes_set_state_error_and_report_once() {
        let cases = [
            (
                Some("invalid sysroot archive length: -1"),
                false,
                Err(StartupSysrootError::Fetch),
                Some("rust-src bootstrap failed: invalid sysroot archive length: -1"),
                LoadState::Failed,
                StartupSysrootError::Fetch,
            ),
            (
                Some("failed to decode sysroot archive entry"),
                false,
                Err(StartupSysrootError::Extract),
                Some("rust-src bootstrap failed: failed to decode sysroot archive entry"),
                LoadState::Failed,
                StartupSysrootError::Extract,
            ),
            (
                None,
                false,
                Err(StartupSysrootError::MissingSentinel),
                Some("rust-src bootstrap failed: missing /sentinel"),
                LoadState::Failed,
                StartupSysrootError::MissingSentinel,
            ),
            (
                None,
                true,
                Ok(()),
                None,
                LoadState::Ready,
                StartupSysrootError::None,
            ),
        ];

        for (command_error, sentinel_exists, expected_result, expected_report, state, error) in
            cases
        {
            let outcome =
                bootstrap_command_outcome("rust-src", "/sentinel", command_error, sentinel_exists);
            assert_eq!(outcome.result, expected_result);
            assert_eq!(outcome.report.as_deref(), expected_report);

            let bootstraps = StartupSysrootBootstraps::new();
            assert!(bootstraps.begin(StartupSysroot::RustSrc));
            bootstraps.finish(StartupSysroot::RustSrc, outcome.result);
            assert_eq!(bootstraps.state(StartupSysroot::RustSrc), state);
            assert_eq!(bootstraps.error(StartupSysroot::RustSrc), error);
        }
    }
}
