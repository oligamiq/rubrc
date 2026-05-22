use parking_lot::Mutex;
use std::sync::LazyLock;
use wasi_virt_layer::prelude::*;
use std::io::Write;
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

                    Downloader::download_file_start(filename.as_bytes().as_ptr() as usize as i32, filename.len() as u32 as i32);
                    for chunk in data.chunks(128 * 1024) {
                        Downloader::download_file_chunk(chunk.as_ptr() as usize as i32, chunk.len() as u32 as i32);
                        downloaded += chunk.len();

                        let progress = (downloaded as f64 / total_size as f64).min(1.0);
                        let filled = (progress * bar_width as f64) as usize;
                        let bar = format!("{nil:=>filled$}{nil: >empty$}", nil = "", filled = filled, empty = bar_width - filled);
                        
                        print!("\rDownloading {}: [{}] {:.1}% ({}/{})", 
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
        "load_sysroot" => {
            let triple = args.get(1).map(|s| s.as_str()).unwrap_or("wasm32-wasip1");
            println!("Loading sysroot: {} ...", triple);

            // Start the background fetch. This blocks Wasm via call_unknown_fn until JS completes queueing.
            Downloader::sysroot_start_fetch(triple.as_bytes().as_ptr() as i32, triple.len() as i32);

            let mut files_loaded = 0;
            let root_inode = crate::LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);
            
            // Create /sysroot directory
            let sysroot_inode = crate::VIRTUAL_FILE_SYSTEM.lfs.add_dir(root_inode, "sysroot").unwrap_or(root_inode);

            loop {
                let mut name_len = 0i32;
                let mut data_len = 0i32;
                
                // Pull next file metadata from JS
                let has_next = Downloader::sysroot_get_next_file_meta(&mut name_len as *mut _ as i32, &mut data_len as *mut _ as i32);
                if has_next == 0 {
                    break;
                }

                let mut name_buf = vec![0u8; name_len as usize];
                let mut data_buf = vec![0u8; data_len as usize];

                // Pull actual file data from JS
                Downloader::sysroot_read_file(name_buf.as_mut_ptr() as i32, data_buf.as_mut_ptr() as i32);

                if let Ok(name) = String::from_utf8(name_buf) {
                    // Navigate / Create directories in VFS
                    let mut current_inode = sysroot_inode;
                    let parts: Vec<&str> = name.split('/').collect();
                    
                    if parts.len() > 1 {
                        for part in &parts[..parts.len() - 1] {
                            if part.is_empty() || *part == "." {
                                continue;
                            }
                            current_inode = crate::VIRTUAL_FILE_SYSTEM.lfs.add_dir(current_inode, part).unwrap_or(current_inode);
                        }
                    }
                    
                    if let Some(file_name) = parts.last() {
                        let _ = crate::VIRTUAL_FILE_SYSTEM.lfs.add_file(current_inode, file_name, data_buf);
                    }
                    
                    files_loaded += 1;
                    print!("\r\x1b[KLoaded {} files...", files_loaded);
                    let _ = std::io::stdout().flush();
                }
            }
            println!("\nSysroot '{}' loaded successfully ({} files).", triple, files_loaded);
        }
        _ => {
            println!("Unknown command: {cmd}");
        }
    }
}
