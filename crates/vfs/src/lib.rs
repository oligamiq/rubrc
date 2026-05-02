use const_struct::*;
use parking_lot::Mutex;
use std::sync::LazyLock;
use wasi_virt_layer::{file::*, prelude::*, wrap_unreachable};

wit_bindgen::generate!({
    world: "init",
});

struct Wit;

impl Guest for Wit {
    fn init() {}
    fn main() {}

    fn flush_to_vfs(files: Vec<FileEntry>) {
        let root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);
        for f in files {
            let _ = VIRTUAL_FILE_SYSTEM.lfs.add_file(root, &f.path.replace("/", "_"), f.content);
        }
    }

    fn flush_from_vfs() -> Vec<FileEntry> { vec![] }

    fn run_command(args: Vec<String>) -> CommandRequest {
        if args.is_empty() { return CommandRequest::Handled; }
        let cmd = args[0].as_str();
        match cmd {
            "ls" | "lsr" => {
                set_lsr_args(&args);
                lsr::_reset();
                lsr::_start();
                lsr::_main();
                CommandRequest::Handled
            }
            "tree" | "tre" => {
                set_tre_args(&args);
                tre::_reset();
                tre::_start();
                tre::_main();
                CommandRequest::Handled
            }
            "rustc" => {
                #[cfg(feature = "full-tools")]
                {
                    set_rustc_opt_args(&args);
                    rustc_opt::_reset();
                    rustc_opt::_start();
                    rustc_opt::_main();
                }
                #[cfg(not(feature = "full-tools"))]
                {
                    set_rustc_mock_args(&args);
                    rustc_mock::_reset();
                    rustc_mock::_start();
                    rustc_mock::_main();
                }
                CommandRequest::Handled
            }
            "clang" | "llvm" => {
                #[cfg(feature = "full-tools")]
                {
                    set_llvm_opt_args(&args);
                    llvm_opt::_reset();
                    llvm_opt::_start();
                    llvm_opt::_main();
                }
                #[cfg(not(feature = "full-tools"))]
                {
                    set_llvm_mock_args(&args);
                    llvm_mock::_reset();
                    llvm_mock::_start();
                    llvm_mock::_main();
                }
                CommandRequest::Handled
            }
            "echo" => {
                println!("{}", args[1..].join(" "));
                CommandRequest::Handled
            }
            "download" => {
                CommandRequest::Download(args.get(1).cloned().unwrap_or_default())
            }
            _ => { CommandRequest::Handled }
        }
    }

    fn read_from_vfs(path: String) -> Result<Vec<u8>, String> {
        // Flat mapping for now as in flush_to_vfs
        let root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);
        let path_clean = path.replace("/", "_");
        // We don't have a direct "read" but we can try to find the node.
        // For now, return error to check build.
        Err(format!("File not found: {}", path_clean))
    }
}

export!(Wit);

type LFS = StandardDynamicLFS<DefaultStdIO>;
static LFS_ROOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub static VIRTUAL_FILE_SYSTEM: LazyLock<StandardDynamicFileSystem<LFS>> =
    LazyLock::new(|| {
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

#[cfg(not(feature = "full-tools"))]
plug_fs!(&*VIRTUAL_FILE_SYSTEM, lsr, tre, rustc_mock, llvm_mock);

#[const_struct]
const VIRTUAL_ENV: VirtualEnvEmbeddedState = VirtualEnvEmbeddedState {
    environ: &["RUST_MIN_STACK=16777216", "HOME=~/"],
};

#[cfg(not(feature = "full-tools"))]
plug_env!(@embedded, VirtualEnvTy, lsr, tre, rustc_mock, llvm_mock);

pub struct CustomProcess;
const SUCCESS_FLAG: i32 = 999;
impl wasi_virt_layer::process::ProcessExit for CustomProcess {
    fn proc_exit<Wasm: WasmAccess>(code: i32) {
        if code == 0 {
            match core::any::type_name::<Wasm>() {
                v if v == core::any::type_name::<lsr>() => WrapUnreachableLsr::set_flag(SUCCESS_FLAG),
                v if v == core::any::type_name::<tre>() => WrapUnreachableTre::set_flag(SUCCESS_FLAG),
                #[cfg(not(feature = "full-tools"))]
                v if v == core::any::type_name::<rustc_mock>() => WrapUnreachableRustcMock::set_flag(SUCCESS_FLAG),
                #[cfg(not(feature = "full-tools"))]
                v if v == core::any::type_name::<llvm_mock>() => WrapUnreachableLlvmMock::set_flag(SUCCESS_FLAG),
                _ => unreachable!(),
            }
        }
    }
}

#[cfg(not(feature = "full-tools"))]
plug_process!(CustomProcess, lsr, tre, rustc_mock, llvm_mock);

struct VirtualArgsState { args: Vec<String> }
impl<'a> VirtualArgs<'a> for VirtualArgsState {
    type Str = String;
    fn get_args(&mut self) -> &[Self::Str] { &self.args }
}

fn set_lsr_args(args: &[impl AsRef<str>]) { VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect(); }
fn set_tre_args(args: &[impl AsRef<str>]) { VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect(); }

#[cfg(not(feature = "full-tools"))]
fn set_rustc_mock_args(args: &[impl AsRef<str>]) { VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect(); }
#[cfg(not(feature = "full-tools"))]
fn set_llvm_mock_args(args: &[impl AsRef<str>]) { VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect(); }

static VIRTUAL_ARGS: std::sync::LazyLock<Mutex<VirtualArgsState>> = std::sync::LazyLock::new(|| {
    Mutex::new(VirtualArgsState { args: vec![] })
});

#[cfg(not(feature = "full-tools"))]
plug_args!(@dynamic, &mut VIRTUAL_ARGS.lock(), lsr, tre, rustc_mock, llvm_mock);

#[cfg(not(feature = "full-tools"))]
plug_random!(StandardRandom, tre, rustc_mock, llvm_mock);

#[cfg(target_os = "wasi")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn __wasip1_vfs_llvm_mock_fd_seek(
    _fd: u32, _offset: i64, _whence: u8, _new_offset: *mut u64,
) -> u16 { 76 }

struct UnreachableHandler;
impl wasi_virt_layer::wasi::wrap_unreachable::WrapUnreachable for UnreachableHandler {
    fn fix_main_raw_exit_code<Wasm: WasmAccess>(code: i32) -> i32 {
        if code == 0 || code == SUCCESS_FLAG { 0 } else { code }
    }
}
#[cfg(not(feature = "full-tools"))]
wrap_unreachable!(UnreachableHandler, lsr, tre, rustc_mock, llvm_mock);
