use crate::vfs::host::bridge::Downloader;
use crate::*;
use parking_lot::Mutex;
use std::io::Write;
use std::sync::LazyLock;
use wasi_virt_layer::prelude::*;

pub struct VirtualArgsState {
    pub args: Vec<String>,
}

impl<'a> VirtualArgs<'a> for VirtualArgsState {
    type Str = String;
    fn get_args(&mut self) -> &[Self::Str] {
        &self.args
    }
}

pub static VIRTUAL_ARGS: LazyLock<Mutex<VirtualArgsState>> =
    LazyLock::new(|| Mutex::new(VirtualArgsState { args: vec![] }));

const DEFAULT_RUSTC_SYSROOT: &str = "/sysroot";

pub fn set_rustc_opt_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

pub fn set_llvm_opt_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

pub fn set_lsp_opt_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

pub fn set_cargo_opt_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

pub fn set_vfs_shell_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

wasi_virt_layer::plug_args!(
    @dynamic,
    { &mut VIRTUAL_ARGS.lock() },
    rustc_opt,
    llvm_opt,
    vfs_shell,
    lsp_opt,
    cargo_opt
);

fn format_size(size: usize) -> String {
    if size < 1024 {
        format!("{} B", size)
    } else if size < 1024 * 1024 {
        format!("{:.1} KB", size as f64 / 1024.0)
    } else {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
    }
}

pub fn handle_command(args: Vec<String>) {
    if args.is_empty() {
        return;
    }
    let cmd = args[0].as_str();
    match cmd {
        "download" => {
            let filename = args.get(1).map(|s| s.as_str()).unwrap_or("");
            if filename.is_empty() {
                println!("Usage: download <filename>");
                return;
            }

            let mut current_inode = crate::LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);
            let mut found_file = true;
            for part in filename.split('/') {
                if part.is_empty() || part == "." {
                    continue;
                }
                let mut found = false;
                if let Ok(entries) = crate::VIRTUAL_FILE_SYSTEM.lfs.read_dir(current_inode) {
                    for (name, child_inode) in entries {
                        if name == part {
                            current_inode = child_inode;
                            found = true;
                            break;
                        }
                    }
                }
                if !found {
                    found_file = false;
                    break;
                }
            }

            if found_file {
                if let Ok(data) = crate::VIRTUAL_FILE_SYSTEM.lfs.read_file(current_inode) {
                    let total_size = data.len();
                    let mut downloaded = 0;
                    let bar_width = 25;

                    Downloader::download_file_start(
                        filename.as_bytes().as_ptr() as usize as i32,
                        filename.len() as u32 as i32,
                    );
                    for chunk in data.chunks(50 * 1024 * 1024) {
                        Downloader::download_file_chunk(
                            chunk.as_ptr() as usize as i32,
                            chunk.len() as u32 as i32,
                        );
                        downloaded += chunk.len();

                        let progress = (downloaded as f64 / total_size as f64).min(1.0);
                        let filled = (progress * bar_width as f64) as usize;
                        let bar = format!(
                            "{nil:=>filled$}{nil: >empty$}",
                            nil = "",
                            filled = filled,
                            empty = bar_width - filled
                        );

                        print!(
                            "\rDownloading {}: [{}] {:.1}% ({}/{})",
                            filename,
                            bar,
                            progress * 100.0,
                            format_size(downloaded),
                            format_size(total_size)
                        );
                        let _ = std::io::stdout().flush();
                    }
                    Downloader::download_file_end();
                    println!("\nDownload successful.");
                } else {
                    println!("Failed to read file or not a file: {}", filename);
                }
            } else {
                println!("File not found: {}", filename);
            }
        }
        "rustc" => {
            let mut args = args;
            if !args
                .iter()
                .skip(1)
                .any(|arg| arg == "--sysroot" || arg.starts_with("--sysroot="))
            {
                args.push("--sysroot".to_string());
                args.push(DEFAULT_RUSTC_SYSROOT.to_string());
            }
            set_rustc_opt_args(&args);
            crate::debug_trace("rustc:_reset:enter");
            crate::rustc_opt::_reset();
            crate::debug_trace("rustc:_reset:return");
            crate::debug_trace("rustc:_start:enter");
            crate::rustc_opt::_start();
            crate::debug_trace("rustc:_start:return");
            crate::debug_trace("rustc:_main:enter");
            crate::rustc_opt::_main();
            crate::debug_trace("rustc:_main:return");
        }
        "clang" | "llvm" => {
            set_llvm_opt_args(&args);
            crate::llvm_opt::_reset();
            crate::llvm_opt::_start();
            crate::llvm_opt::_main();
        }
        "cargo" => {
            set_cargo_opt_args(&args);
            crate::run_cargo();
        }
        "rust-analyzer" => {
            if crate::LSP_STARTED.load(std::sync::atomic::Ordering::SeqCst) {
                println!("rust-analyzer is already running for the Web editor");
                return;
            }
            set_lsp_opt_args(&args);
            crate::lsp_opt::_start();
        }
        _ => {
            println!("Unknown command: {cmd}");
        }
    }
}
