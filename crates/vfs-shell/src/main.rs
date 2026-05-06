use std::io::{self, Write};
use colored::*;
use dashmap::DashMap;
use std::sync::LazyLock;
use std::sync::Arc;
use wasi_shell::{IoContext, CommandRegistry, handle_parallel};
use std::sync::atomic::{AtomicU32, Ordering};
use std::env;
use std::path::PathBuf;

struct IoPtr(usize);
unsafe impl Send for IoPtr {}
unsafe impl Sync for IoPtr {}

static IO_REGISTRY: LazyLock<DashMap<u32, IoPtr>> = LazyLock::new(|| DashMap::new());
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn vfs_shell_write_stdout(id: u32, data: *const u8, len: usize) -> usize {
    if let Some(entry) = IO_REGISTRY.get(&id) {
        let io = unsafe { &mut *(entry.value().0 as *mut IoContext) };
        let slice = unsafe { std::slice::from_raw_parts(data, len) };
        if let Ok(written) = io.stdout.write(slice) {
            return written;
        }
    }
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn vfs_shell_write_stderr(id: u32, data: *const u8, len: usize) -> usize {
    if let Some(entry) = IO_REGISTRY.get(&id) {
        let io = unsafe { &mut *(entry.value().0 as *mut IoContext) };
        let slice = unsafe { std::slice::from_raw_parts(data, len) };
        if let Ok(written) = io.stderr.write(slice) {
            return written;
        }
    }
    0
}

#[link(wasm_import_module = "__wasip1_vfs-host")]
unsafe extern "C" {
    fn vfs_execute_command(args_ptr: *const u8, args_len: usize, context_id: u32) -> i32;
}

fn main() {
    let mut input = String::new();
    let stdin = io::stdin();

    println!("{}", "Welcome to WASI-Shell!".green().bold());
    println!("Type 'help' for available commands or 'exit' to quit.");

    let mut reg = CommandRegistry::new();
    reg.set_fallback(|args: &[String], io: &mut IoContext| {
        let args_str = args.join("\0"); // serialize args
        let context_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

        IO_REGISTRY.insert(context_id, IoPtr(io as *mut _ as usize));

        let status = unsafe { vfs_execute_command(args_str.as_ptr(), args_str.len(), context_id) };

        IO_REGISTRY.remove(&context_id);

        if status == 0 {
            Ok(())
        } else {
            Err(format!("Command exited with status: {}", status))
        }
    });
    let registry = Arc::new(reg);

    loop {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        print!("{} $ ", cwd.display().to_string().cyan());
        io::stdout().flush().unwrap();

        input.clear();
        let n = stdin.read_line(&mut input).unwrap_or(0);
        if n == 0 || input.trim() == "exit" {
            if n != 0 { println!("Goodbye!"); }
            break;
        }

        let line = input.trim();
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
