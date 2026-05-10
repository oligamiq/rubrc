use parking_lot::Mutex;
use std::sync::LazyLock;
use wasi_virt_layer::prelude::*;
use crate::*;
#[cfg(not(feature = "full-tools"))]

use crate::vfs::host::bridge::Downloader;

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

#[cfg(not(feature = "full-tools"))]
pub fn set_rustc_mock_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

#[cfg(not(feature = "full-tools"))]
pub fn set_llvm_mock_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

pub fn set_vfs_shell_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

#[cfg(not(feature = "full-tools"))]
wasi_virt_layer::plug_args!(@dynamic, { &mut VIRTUAL_ARGS.lock() }, rustc_mock, llvm_mock, vfs_shell);

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
                    Downloader::download_file_start(filename.as_bytes().as_ptr() as usize as i32, filename.len() as u32 as i32);
                    for chunk in data.chunks(128 * 1024) {
                        Downloader::download_file_chunk(chunk.as_ptr() as usize as i32, chunk.len() as u32 as i32);
                    }
                    Downloader::download_file_end();
                } else {
                    println!("Failed to read file or not a file: {}", filename);
                }
            } else {
                println!("File not found: {}", filename);
            }
        }
        _ => {
            println!("Unknown command: {cmd}");
        }
    }
}
