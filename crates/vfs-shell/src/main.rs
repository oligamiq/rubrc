use std::io::{self, Write};
use colored::*;

#[link(wasm_import_module = "__wasip1_vfs-host")]
unsafe extern "C" {
  fn example_external_function2(arg1: i32, arg2: *const u8, arg2_len: usize) -> i32;
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn example_external_function(arg1: i32, arg2: *const u8, arg2_len: usize) -> i32 {
  println!("Called example_external_function with arg1: {}, arg2: {}", arg1, std::str::from_utf8(std::slice::from_raw_parts(arg2, arg2_len)).unwrap_or("<invalid utf-8>"));
  example_external_function2(arg1 + 1, arg2, arg2_len)
}

use std::env;
use std::path::PathBuf;
use wasi_shell::{handle_parallel};

fn main() {
    let mut input = String::new();
    let stdin = io::stdin();

    println!("{}", "Welcome to WASI-Shell!".green().bold());
    println!("Type 'help' for available commands or 'exit' to quit.");

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

        if let Err(e) = handle_parallel(line, Box::new(io::stdin()), Box::new(io::stdout())) {
            eprintln!("{}", e.red());
        }
    }
}
