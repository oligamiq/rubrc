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

        // test print all help
        Self::run_command(vec!["ls".to_string(), "--help".to_string()]);
        Self::run_command(vec!["tree".to_string(), "--help".to_string()]);

        #[cfg(not(feature = "full-tools"))]
        {
            Self::run_command(vec!["rustc".to_string(), "--help".to_string()]);
            Self::run_command(vec!["clang".to_string(), "--help".to_string()]);
        }
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

    fn run_command(args: Vec<String>) -> CommandRequest {
        command::handle_command(args)
    }
}

export!(Wit);

type LFS = StandardDynamicLFS<DefaultStdIO>;
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
