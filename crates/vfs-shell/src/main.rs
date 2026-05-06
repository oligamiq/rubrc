use std::io::{self, Write};
use colored::*;
use dashmap::DashMap;
use std::sync::{LazyLock, Mutex};
use std::sync::Arc;
use wasi_shell::{IoContext, CommandRegistry, handle_parallel};
use std::sync::atomic::{AtomicU32, Ordering};
use std::env;
use std::path::PathBuf;

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
// Main shell loop
// ============================================================

fn main() {
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
    let registry = Arc::new(reg);

    let stdin = io::stdin();

    println!("{}", "Welcome to WASI-Shell!".green().bold());
    println!("Type 'help' for available commands or 'exit' to quit.");

    let mut pre_lines = vec![
        "help",
        "echo Hello, World!",
        "ls -la",
        "tree",
    ];
    pre_lines.reverse();

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        print!("{} $ ", cwd.display().to_string().cyan());
        io::stdout().flush().unwrap();

        let line = if let Some(pre_line) = pre_lines.pop() {
            println!("{}", pre_line);
            pre_line.to_string()
        } else {
            let mut line = String::new();
            if stdin.read_line(&mut line).unwrap_or(0) == 0 {
                println!("Goodbye!");
                break;
            }
            line
        };

        if line.is_empty() {
            continue;
        }

        let results = handle_parallel(
            vec![line.to_string()],
            Box::new(io::stdin()),
            Box::new(io::stdout()),
            Arc::clone(&registry),
        );

        for res in results {
            if let Err(e) = res {
                eprintln!("{}", e.red());
            }
        }
    }
}
