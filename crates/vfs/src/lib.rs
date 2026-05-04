use const_struct::*;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::LazyLock;
use wasi_virt_layer::{
    file::*,
    memory::WasmAccessName,
    prelude::*,
    thread::VirtualThreadPool,
    wrap_unreachable,
};

wit_bindgen::generate!({
    world: "init",
});

struct Wit;

/// Shadow storage for TS↔Rust file synchronization.
/// Tracks all files synced via flush_to_vfs so they can be returned by flush_from_vfs.
static SYNC_STORAGE: LazyLock<Mutex<HashMap<String, Vec<u8>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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

    fn flush_to_vfs(files: Vec<FileEntry>) {
        let root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);
        let mut storage = SYNC_STORAGE.lock();

        for f in files {
            // Store in shadow storage for later retrieval
            storage.insert(f.path.clone(), f.content.clone());

            // Create directory hierarchy and add file to VFS
            let path = f.path.trim_start_matches('/');
            let parts: Vec<&str> = path.split('/').collect();

            if parts.len() <= 1 {
                // File at root level
                let name = if parts.is_empty() { &f.path } else { parts[0] };
                let _ = VIRTUAL_FILE_SYSTEM.lfs.add_file(root, name, f.content);
            } else {
                // Create intermediate directories, then add the file
                let mut current_parent = root;
                for dir_name in &parts[..parts.len() - 1] {
                    current_parent = VIRTUAL_FILE_SYSTEM.lfs.add_dir(current_parent, dir_name)
                        .unwrap_or(current_parent);
                }
                let file_name = parts[parts.len() - 1];
                let _ = VIRTUAL_FILE_SYSTEM
                    .lfs
                    .add_file(current_parent, file_name, f.content);
            }
        }
    }

    fn flush_from_vfs() -> Vec<FileEntry> {
        let storage = SYNC_STORAGE.lock();
        storage
            .iter()
            .map(|(path, content)| FileEntry {
                path: path.clone(),
                content: content.clone(),
            })
            .collect()
    }

    fn run_command(args: Vec<String>) -> CommandRequest {
        command::handle_command(args)
    }

    fn read_from_vfs(path: String) -> Result<Vec<u8>, String> {
        let storage = SYNC_STORAGE.lock();
        storage
            .get(&path)
            .cloned()
            .ok_or_else(|| format!("File not found: {}", path))
    }
}

export!(Wit);

type LFS = StandardDynamicLFS<DefaultStdIO>;
static LFS_ROOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub mod process;
pub mod command;

pub static VIRTUAL_FILE_SYSTEM: LazyLock<StandardDynamicFileSystem<LFS>> = LazyLock::new(|| {
    let lfs = StandardDynamicLFS::new();
    let root_inode = lfs.add_preopen(".");
    LFS_ROOT.store(root_inode, std::sync::atomic::Ordering::SeqCst);
    let vfs = StandardDynamicFileSystem::new(lfs);
    vfs.add_fd(root_inode, !0, !0);
    vfs
});

import_wasm!(lsr);
import_wasm!(tre);

#[cfg(not(feature = "full-tools"))]
import_wasm!(rustc_mock);
#[cfg(not(feature = "full-tools"))]
import_wasm!(llvm_mock);

#[cfg(feature = "full-tools")]
import_wasm!(rustc_opt);
#[cfg(feature = "full-tools")]
import_wasm!(llvm_opt);

#[cfg(not(feature = "full-tools"))]
plug_fs!(&*VIRTUAL_FILE_SYSTEM, lsr, tre, rustc_mock, llvm_mock);

#[cfg(feature = "full-tools")]
plug_fs!(&*VIRTUAL_FILE_SYSTEM, lsr, tre, rustc_opt, llvm_opt);

#[const_struct]
const VIRTUAL_ENV: VirtualEnvEmbeddedState = VirtualEnvEmbeddedState {
    // environ: &["RUST_MIN_STACK=16777216", "HOME=~/"],
    environ: &["HOME=~/"],
};

#[cfg(not(feature = "full-tools"))]
plug_env!(@embedded, VirtualEnvTy, lsr, tre, rustc_mock, llvm_mock);

// plug_process!(StandardProcess, lsr, tre, rustc_mock, llvm_mock);


#[cfg(not(feature = "full-tools"))]
plug_random!(StandardRandom, tre, rustc_mock, llvm_mock);

static THREAD_POOL: VirtualThreadPool<ThreadAccessor> =
    unsafe { VirtualThreadPool::new_const(1) };

#[cfg(not(feature = "full-tools"))]
plug_thread!({ &THREAD_POOL }, self, rustc_mock);

#[cfg(feature = "full-tools")]
plug_thread!({ &THREAD_POOL }, self, rustc_opt);
