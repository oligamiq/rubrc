use const_struct::*;
use wasi_virt_layer::{
    file::*,
    prelude::*,
    thread::VirtualThreadPool,
};
use std::path::{Path, PathBuf};

wit_bindgen::generate!({
    world: "init",
});

struct Wit;

impl Guest for Wit {
    fn init() {}
    fn main() {
        unsafe { THREAD_POOL.init() };
        THREAD_POOL.set_capacity(2);
        THREAD_POOL.flush_capacity().wait();

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
                        let vfs_child = VIRTUAL_FILE_SYSTEM.lfs.add_dir(vfs_parent, &name)
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
                    if name == "." || name == ".." { continue; }
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

    fn input_char(c: u32) {
        unsafe { crate::shell::vfs_shell_input_char(c) };
    }
}

export!(Wit);

#[derive(Debug)]
pub struct ShellVirtualStdIO;

impl wasi_virt_layer::wasi::file::stdio::StdIO for ShellVirtualStdIO {
    fn write(buf: &[u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        let id = crate::shell::CURRENT_CONTEXT_ID.with(|id| id.get()).unwrap_or(0);
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
            wasi_virt_layer::wasi::file::stdio::DefaultStdIO::write(buf)
        }
    }
    fn ewrite(buf: &[u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        let id = crate::shell::CURRENT_CONTEXT_ID.with(|id| id.get()).unwrap_or(0);
        if id != 0 {
            let len = buf.len() as u32;
            let shell_ptr = unsafe { crate::shell::vfs_shell_alloc_buf(len) };
            vfs_shell::memcpy(shell_ptr as *mut u8, buf);
            let written = unsafe { crate::shell::vfs_shell_write_stderr(id, shell_ptr, len) };
            unsafe { crate::shell::vfs_shell_free_buf(shell_ptr, len) };
            Ok(written as usize)
        } else {
            wasi_virt_layer::wasi::file::stdio::DefaultStdIO::ewrite(buf)
        }
    }
    fn read(buf: &mut [u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        wasi_virt_layer::wasi::file::stdio::DefaultStdIO::read(buf)
    }
}

type LFS = StandardDynamicLFS<ShellVirtualStdIO>;
static LFS_ROOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub mod process;
pub mod command;
pub mod shell;

pub static VIRTUAL_FILE_SYSTEM: std::sync::LazyLock<StandardDynamicFileSystem<LFS>> = std::sync::LazyLock::new(|| {
    let lfs = StandardDynamicLFS::new();
    let root_inode = lfs.add_preopen(".");
    LFS_ROOT.store(root_inode, std::sync::atomic::Ordering::SeqCst);
    let vfs = StandardDynamicFileSystem::new(lfs);
    vfs.add_fd(root_inode, !0, !0);
    vfs
});

import_wasm!(vfs_shell);

#[cfg(not(feature = "full-tools"))]
import_wasm!(rustc_mock);
#[cfg(not(feature = "full-tools"))]
import_wasm!(llvm_mock);

#[cfg(feature = "full-tools")]
import_wasm!(rustc_opt);
#[cfg(feature = "full-tools")]
import_wasm!(llvm_opt);

#[cfg(not(feature = "full-tools"))]
plug_fs!(&*VIRTUAL_FILE_SYSTEM, rustc_mock, llvm_mock, vfs_shell);

#[cfg(feature = "full-tools")]
plug_fs!(&*VIRTUAL_FILE_SYSTEM, rustc_opt, llvm_opt, vfs_shell);

#[const_struct]
const VIRTUAL_ENV: VirtualEnvEmbeddedState = VirtualEnvEmbeddedState {
    // environ: &["RUST_MIN_STACK=16777216", "HOME=~/"],
    environ: &["HOME=~/"],
};

#[cfg(not(feature = "full-tools"))]
plug_env!(@embedded, VirtualEnvTy, rustc_mock, llvm_mock, vfs_shell);

// plug_process!(StandardProcess, rustc_mock, llvm_mock);


#[cfg(not(feature = "full-tools"))]
plug_random!(StandardRandom, rustc_mock, llvm_mock, vfs_shell);

#[cfg(not(feature = "full-tools"))]
plug_poll!(DefaultPoll, rustc_mock, llvm_mock, vfs_shell);

#[cfg(feature = "full-tools")]
plug_poll!(DefaultPoll, rustc_opt, llvm_opt, vfs_shell);

static THREAD_POOL: VirtualThreadPool<ThreadAccessor> =
    unsafe { VirtualThreadPool::new_const(1) };

#[cfg(not(feature = "full-tools"))]
plug_thread!({ &THREAD_POOL }, self, rustc_mock, vfs_shell);

#[cfg(feature = "full-tools")]
plug_thread!({ &THREAD_POOL }, self, rustc_opt, vfs_shell);

plug_clock!(StandardClock, vfs_shell);
