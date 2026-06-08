use const_struct::*;
use std::path::{Path, PathBuf};
use wasi_virt_layer::{file::*, poll::*, prelude::*, thread::VirtualThreadPool};

wit_bindgen::generate!({
    world: "vfs-host",
});

const LSP_SESSION_ID: u32 = 0xFFFFFFFF;
const EVENT_TYPE_LSP: u32 = 6;
const EVENT_TYPE_WRITE_FILE: u32 = 7;
pub static LSP_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub static THREAD_SESSIONS: std::sync::LazyLock<dashmap::DashMap<std::thread::ThreadId, u32>> = std::sync::LazyLock::new(|| dashmap::DashMap::new());

static LSP_STDIN: std::sync::LazyLock<(parking_lot::Mutex<Vec<u8>>, parking_lot::Condvar)> =
    std::sync::LazyLock::new(|| (parking_lot::Mutex::new(Vec::new()), parking_lot::Condvar::new()));

struct Wit;

impl Guest for Wit {
    fn init() {}
    fn main() {
        let threads = std::env::var("VFS_THREADS")
            .unwrap_or_else(|_| "8".to_string())
            .parse::<usize>()
            .unwrap_or(8);

        unsafe { THREAD_POOL.init() };

        for i in 1..=threads {
            print!(
                "\x1b[2K\r\x1b[36mInitializing Thread Pool: {}/{} ...\x1b[0m",
                i, threads
            );
            let _ = std::io::Write::flush(&mut std::io::stdout());
            THREAD_POOL.set_capacity(i);
            THREAD_POOL.flush_capacity().wait();
        }
        eprintln!(
            "\x1b[2K\r\x1b[32mThread Pool Initialized ({} threads)\x1b[0m",
            threads
        );

        Self::flush_to_vfs();

        vfs_shell::_reset();
        vfs_shell::_start();
        vfs_shell::_main();

        // test print all help
        // Self::run_command(vec!["ls".to_string(), "--help".to_string()]);
        // Self::run_command(vec!["tree".to_string(), "--help".to_string()]);
        // Self::run_command(vec!["echo LS_HELP && ls --help".to_string()]);

        // #[cfg(not(feature = "full-tools"))]
        // {
        //     Self::run_command(vec!["rustc".to_string(), "--help".to_string()]);
        //     Self::run_command(vec!["clang".to_string(), "--help".to_string()]);
        // }
    }

    fn flush_to_vfs() {
        let root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);

        fn walk_host(dir: &Path, vfs_parent: usize) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name().unwrap().to_string_lossy().to_string();

                    if path.is_dir() {
                        let vfs_child = VIRTUAL_FILE_SYSTEM
                            .lfs
                            .add_dir(vfs_parent, &name)
                            .unwrap_or(vfs_parent);
                        walk_host(&path, vfs_child);
                    } else if path.is_file() {
                        if let Ok(content) = std::fs::read(&path) {
                            let _ = VIRTUAL_FILE_SYSTEM.lfs.add_file(vfs_parent, &name, content);
                        }
                    }
                }
            }
        }

        walk_host(Path::new("."), root);
    }

    fn flush_from_vfs() {
        let root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);

        fn walk_vfs(vfs_inode: usize, host_path: PathBuf) {
            if let Ok(entries) = VIRTUAL_FILE_SYSTEM.lfs.read_dir(vfs_inode) {
                for (name, child_inode) in entries {
                    if name == "." || name == ".." {
                        continue;
                    }
                    let child_path = host_path.join(&name);

                    // Try to list as directory to check if it is one
                    if VIRTUAL_FILE_SYSTEM.lfs.read_dir(child_inode).is_ok() {
                        let _ = std::fs::create_dir_all(&child_path);
                        walk_vfs(child_inode, child_path);
                    } else {
                        // Treat as file
                        if let Ok(content) = VIRTUAL_FILE_SYSTEM.lfs.read_file(child_inode) {
                            let _ = std::fs::write(&child_path, content);
                        }
                    }
                }
            }
        }

        walk_vfs(root, PathBuf::from("."));
    }

    fn dispatch(session_id: u32, event_type: u32, arg1: u32, arg2: u32) {

        if session_id == LSP_SESSION_ID {
            if !crate::LSP_STARTED.load(std::sync::atomic::Ordering::SeqCst) {
                if !crate::LSP_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    std::thread::spawn(move || {
                        crate::shell::vfs_set_current_session_id(LSP_SESSION_ID);
                        crate::command::set_lsp_opt_args(&["rust-analyzer"]);
                        unsafe { lsp_opt::_start() };
                    });
                }
            }
        }

        if event_type == 1 {
            let mut env = VIRTUAL_SHELL_ENV.lock();
            env.env
                .retain(|s| !s.starts_with("COLUMNS=") && !s.starts_with("LINES="));
            env.env.push(format!("COLUMNS={}", arg1));
            env.env.push(format!("LINES={}", arg2));
        } else if event_type == EVENT_TYPE_LSP {
            let ptr = arg1 as *const u8;
            let len = arg2 as usize;
            let data = unsafe { std::slice::from_raw_parts(ptr, len) };
            let (lock, cvar) = &*LSP_STDIN;
            let mut stdin = lock.lock();
            stdin.extend_from_slice(data);
            cvar.notify_all();
            return;
        } else if event_type == EVENT_TYPE_WRITE_FILE {
            let ptr = arg1 as *const u8;
            let len = arg2 as usize;
            let data = unsafe { std::slice::from_raw_parts(ptr, len) };
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(data) {
                if let (Some(path), Some(content)) = (
                    json["path"].as_str(),
                    json["content"].as_str(),
                ) {
                    let path = Path::new(path);
                    let mut current_vfs_parent = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);
                    
                    if let Some(parent) = path.parent() {
                        for component in parent.components() {
                            if let std::path::Component::Normal(c) = component {
                                let name = c.to_string_lossy();
                                current_vfs_parent = VIRTUAL_FILE_SYSTEM
                                    .lfs
                                    .add_dir(current_vfs_parent, &name)
                                    .unwrap_or(current_vfs_parent);
                            }
                        }
                    }

                    if let Some(name) = path.file_name() {
                        let _ = VIRTUAL_FILE_SYSTEM.lfs.add_file(
                            current_vfs_parent,
                            &name.to_string_lossy(),
                            content.as_bytes().to_vec(),
                        );
                    }
                }
            }
            return;
        }
        unsafe { crate::shell::vfs_shell_dispatch(session_id, event_type, arg1, arg2) };
    }

    fn alloc_buf(len: u32) -> u32 {
        let layout = std::alloc::Layout::from_size_align(len as usize, 8).unwrap();
        let ptr = unsafe { std::alloc::alloc(layout) };
        ptr as u32
    }

    fn free_buf(ptr: u32, len: u32) {
        let layout = std::alloc::Layout::from_size_align(len as usize, 8).unwrap();
        unsafe { std::alloc::dealloc(ptr as *mut u8, layout) };
    }
}

export!(Wit);

pub struct VirtualEnvState {
    pub env: Vec<String>,
}

impl<'a> VirtualEnv<'a> for VirtualEnvState {
    type Str = String;
    fn get_environ(&mut self) -> &[Self::Str] {
        &self.env
    }
}

pub static VIRTUAL_SHELL_ENV: std::sync::LazyLock<parking_lot::Mutex<VirtualEnvState>> =
    std::sync::LazyLock::new(|| {
        parking_lot::Mutex::new(VirtualEnvState {
            env: vec![
                "HOME=~/".to_string(),
                // "RUST_SRC_PATH=/sysroot/lib/rustlib".to_string(),
                "SYSROOT=/sysroot".to_string(),
            ],
        })
    });

#[derive(Debug)]
pub struct ShellVirtualStdIO;

impl wasi_virt_layer::wasi::file::stdio::StdIO for ShellVirtualStdIO {
    fn write(buf: &[u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        let id = crate::shell::CURRENT_CONTEXT_ID
            .with(|id| id.get())
            .unwrap_or(0);
        if id != 0 {
            let len = buf.len() as u32;
            // 1. Allocate buffer in vfs-shell's memory
            let shell_ptr = unsafe { crate::shell::vfs_shell_alloc_buf(len) };
            // 2. Copy our data into vfs-shell's memory via cross-Wasm memcpy
            vfs_shell::memcpy(shell_ptr as *mut u8, buf);
            // 3. Tell vfs-shell to write from its own memory (scalar-only call)
            let written = unsafe { crate::shell::vfs_shell_write_stdout(id, shell_ptr, len) };
            // 4. Free the buffer in vfs-shell's memory
            unsafe { crate::shell::vfs_shell_free_buf(shell_ptr, len) };
            Ok(written as usize)
        } else {
            let session_id = crate::shell::CURRENT_SESSION_ID.with(|id| id.get());
            if session_id == LSP_SESSION_ID || session_id != 0 {
                crate::vfs::host::bridge::Terminal::terminal_write(
                    session_id,
                    buf.as_ptr() as i32,
                    buf.len() as i32,
                );
                Ok(buf.len())
            } else {
                let mut is_lsp = false;
                let current_thread = std::thread::current().id();

                if buf.starts_with(b"Content-Length: ") || buf.starts_with(b"{\"jsonrpc\"") {
                    crate::THREAD_SESSIONS.insert(current_thread, LSP_SESSION_ID);
                }

                if let Some(sid) = crate::THREAD_SESSIONS.get(&current_thread) {
                    if *sid == LSP_SESSION_ID {
                        is_lsp = true;
                    }
                }

                if is_lsp {
                    crate::vfs::host::bridge::Terminal::terminal_write(
                        LSP_SESSION_ID,
                        buf.as_ptr() as i32,
                        buf.len() as i32,
                    );
                    Ok(buf.len())
                } else {
                    wasi_virt_layer::wasi::file::stdio::DefaultStdIO::write(buf)
                }
            }
        }
    }
    fn ewrite(buf: &[u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        let id = crate::shell::CURRENT_CONTEXT_ID
            .with(|id| id.get())
            .unwrap_or(0);
        if id != 0 {
            let len = buf.len() as u32;
            let shell_ptr = unsafe { crate::shell::vfs_shell_alloc_buf(len) };
            vfs_shell::memcpy(shell_ptr as *mut u8, buf);
            let written = unsafe { crate::shell::vfs_shell_write_stderr(id, shell_ptr, len) };
            unsafe { crate::shell::vfs_shell_free_buf(shell_ptr, len) };
            Ok(written as usize)
        } else {
            let session_id = crate::shell::CURRENT_SESSION_ID.with(|id| id.get());
            if session_id == LSP_SESSION_ID || session_id != 0 {
                crate::vfs::host::bridge::Terminal::terminal_write(
                    session_id,
                    buf.as_ptr() as i32,
                    buf.len() as i32,
                );
                Ok(buf.len())
            } else {
                wasi_virt_layer::wasi::file::stdio::DefaultStdIO::ewrite(buf)
            }
        }
    }
    fn read(buf: &mut [u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        let session_id = crate::shell::CURRENT_SESSION_ID.with(|id| id.get());
        if session_id == LSP_SESSION_ID || (session_id == 0 && crate::LSP_STARTED.load(std::sync::atomic::Ordering::SeqCst)) {
            let (lock, cvar) = &*LSP_STDIN;
            let mut stdin = lock.lock();
            while stdin.is_empty() {
                cvar.wait(&mut stdin);
            }
            let len = std::cmp::min(buf.len(), stdin.len());
            buf[..len].copy_from_slice(&stdin[..len]);
            stdin.drain(..len);
            Ok(len)
        } else {
            wasi_virt_layer::wasi::file::stdio::DefaultStdIO::read(buf)
        }
    }
}

type LFS = StandardDynamicLFS<ShellVirtualStdIO>;
pub(crate) static LFS_ROOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub mod command;
pub mod process;
pub mod shell;

pub static VIRTUAL_FILE_SYSTEM: std::sync::LazyLock<StandardDynamicFileSystem<LFS>> =
    std::sync::LazyLock::new(|| {
        let lfs = StandardDynamicLFS::new();
        let root_inode = lfs.add_preopen(".");
        LFS_ROOT.store(root_inode, std::sync::atomic::Ordering::SeqCst);
        let vfs = StandardDynamicFileSystem::new(lfs);
        vfs.add_fd(root_inode, !0, !0);
        vfs
    });

import_wasm!(vfs_shell);
import_wasm!(lsp_opt);

#[cfg(not(feature = "full-tools"))]
import_wasm!(rustc_mock);
#[cfg(not(feature = "full-tools"))]
import_wasm!(llvm_mock);

#[cfg(feature = "full-tools")]
import_wasm!(rustc_opt);
#[cfg(feature = "full-tools")]
import_wasm!(llvm_opt);

#[cfg(not(feature = "full-tools"))]
plug_fs!(&*VIRTUAL_FILE_SYSTEM, rustc_mock, llvm_mock, vfs_shell, lsp_opt);

#[cfg(feature = "full-tools")]
plug_fs!(&*VIRTUAL_FILE_SYSTEM, rustc_opt, llvm_opt, vfs_shell, lsp_opt);

#[const_struct]
const VIRTUAL_ENV: VirtualEnvEmbeddedState = VirtualEnvEmbeddedState {
    // environ: &["RUST_MIN_STACK=16777216", "HOME=~/"],
    environ: &["HOME=~/"],
};

#[cfg(not(feature = "full-tools"))]
plug_env!(@embedded, VirtualEnvTy, rustc_mock, llvm_mock);

plug_env!(@dynamic, { &mut VIRTUAL_SHELL_ENV.lock() }, vfs_shell, lsp_opt);

// plug_process!(StandardProcess, rustc_mock, llvm_mock);

#[cfg(not(feature = "full-tools"))]
plug_random!(StandardRandom, rustc_mock, llvm_mock, vfs_shell, lsp_opt);

#[cfg(feature = "full-tools")]
plug_random!(StandardRandom, rustc_opt, llvm_opt, vfs_shell, lsp_opt);

#[cfg(not(feature = "full-tools"))]
plug_poll!(WaitPoll, rustc_mock, llvm_mock, vfs_shell, lsp_opt);

#[cfg(feature = "full-tools")]
plug_poll!(WaitPoll, rustc_opt, llvm_opt, vfs_shell, lsp_opt);

static THREAD_POOL: VirtualThreadPool<ThreadAccessor> = unsafe { VirtualThreadPool::new_const(8) };

#[cfg(not(feature = "full-tools"))]
plug_thread!({ &THREAD_POOL }, self, rustc_mock, vfs_shell, lsp_opt);

#[cfg(feature = "full-tools")]
plug_thread!({ &THREAD_POOL }, self, rustc_opt, vfs_shell, lsp_opt);

plug_clock!(StandardClock, vfs_shell, lsp_opt);
#[cfg(not(feature = "full-tools"))]
plug_clock!(StandardClock, rustc_mock);
#[cfg(not(feature = "full-tools"))]
plug_clock!(StandardClock, llvm_mock);

#[cfg(feature = "full-tools")]
plug_clock!(StandardClock, rustc_opt);
#[cfg(feature = "full-tools")]
plug_clock!(StandardClock, llvm_opt);

#[unsafe(no_mangle)]
pub extern "C" fn sysroot_start_fetch(vfs_shell_triple_ptr: i32, triple_len: i32) {
    let triple_data = vfs_shell::get_array(vfs_shell_triple_ptr as *const u8, triple_len as usize);
    crate::vfs::host::bridge::Downloader::sysroot_start_fetch(
        triple_data.as_ptr() as i32,
        triple_len,
    );
}

#[unsafe(no_mangle)]
pub extern "C" fn sysroot_get_next_file_meta(
    vfs_shell_name_len_ptr: i32,
    vfs_shell_data_len_ptr: i32,
) -> i32 {
    let mut name_len = 0i32;
    let mut data_len = 0i32;
    let has_next = crate::vfs::host::bridge::Downloader::sysroot_get_next_file_meta(
        &mut name_len as *mut _ as i32,
        &mut data_len as *mut _ as i32,
    );

    vfs_shell::memcpy(vfs_shell_name_len_ptr as *mut u8, &name_len.to_ne_bytes());
    vfs_shell::memcpy(vfs_shell_data_len_ptr as *mut u8, &data_len.to_ne_bytes());

    has_next
}

#[unsafe(no_mangle)]
pub extern "C" fn sysroot_read_file_name(vfs_shell_name_ptr: i32, name_len: i32) {
    let mut local_buf = vec![0u8; name_len as usize];
    crate::vfs::host::bridge::Downloader::sysroot_read_file_name(local_buf.as_mut_ptr() as i32);
    vfs_shell::memcpy(vfs_shell_name_ptr as *mut u8, local_buf.as_slice());
}

#[unsafe(no_mangle)]
pub extern "C" fn sysroot_read_file_chunk(vfs_shell_data_ptr: i32, chunk_len: i32) {
    let mut local_buf = vec![0u8; chunk_len as usize];
    crate::vfs::host::bridge::Downloader::sysroot_read_file_chunk(
        local_buf.as_mut_ptr() as i32,
        chunk_len,
    );
    vfs_shell::memcpy(vfs_shell_data_ptr as *mut u8, local_buf.as_slice());
}

#[unsafe(no_mangle)]
pub extern "C" fn terminal_write(session_id: u32, vfs_shell_data_ptr: i32, data_len: i32) {
    let data = vfs_shell::get_array(vfs_shell_data_ptr as *const u8, data_len as usize);
    crate::vfs::host::bridge::Terminal::terminal_write(session_id, data.as_ptr() as i32, data_len);
}
