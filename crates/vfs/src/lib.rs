// wasi_virt_layer build -p vfs page/src/wasm/lsr.wasm page/src/wasm/tre.wasm crates/vfs/llvm_opt.wasm crates/vfs/rustc_opt.wasm

use const_struct::*;
use parking_lot::Mutex;
use std::sync::LazyLock;
use wasi_virt_layer::{file::*, memory::WasmAccessName, prelude::*, wrap_unreachable};

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
            // Replace / with _ for now to keep it flat (can implement proper tree if needed later)
            let _ = VIRTUAL_FILE_SYSTEM.lfs.add_file(root, &f.path.replace("/", "_"), f.content);
        }
    }

    fn flush_from_vfs() -> Vec<FileEntry> {
        // Returning empty for now to check compile
        vec![]
    }

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
                set_rustc_opt_args(&args);
                rustc_opt::_reset();
                rustc_opt::_start();
                rustc_opt::_main();
                CommandRequest::Handled
            }
            "clang" | "llvm" => {
                set_llvm_opt_args(&args);
                llvm_opt::_reset();
                llvm_opt::_start();
                llvm_opt::_main();
                CommandRequest::Handled
            }
            "echo" => {
                println!("{}", args[1..].join(" "));
                CommandRequest::Handled
            }
            "download" => {
                CommandRequest::Download(args.get(1).cloned().unwrap_unwrap_or_default())
            }
            _ => {
                if cmd.contains('/') {
                    CommandRequest::ExecFile((cmd.to_string(), args[1..].to_vec()))
                } else {
                    CommandRequest::NotFound(cmd.to_string())
                }
            }
        }
    }
}

trait UnwrapOrDefault { fn unwrap_unwrap_or_default(self) -> String; }
impl UnwrapOrDefault for Option<String> { fn unwrap_unwrap_or_default(self) -> String { self.unwrap_or_default() } }

export!(Wit);

type LFS = StandardDynamicLFS<DefaultStdIO>;

static LFS_ROOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub static VIRTUAL_FILE_SYSTEM: LazyLock<StandardDynamicFileSystem<LFS>> =
    LazyLock::new(|| {
        let lfs = StandardDynamicLFS::new(); // Inode 0 is root "."
        let root_inode = lfs.add_preopen(".");
        LFS_ROOT.store(root_inode, std::sync::atomic::Ordering::SeqCst);
        let vfs = StandardDynamicFileSystem::new(lfs);
        vfs.add_fd(root_inode, !0, !0);
        vfs
    });

import_wasm!(lsr);
import_wasm!(tre);
import_wasm!(rustc_opt);
import_wasm!(llvm_opt);

plug_fs!(&*VIRTUAL_FILE_SYSTEM, lsr, tre, rustc_opt, llvm_opt);

#[const_struct]
const VIRTUAL_ENV: VirtualEnvEmbeddedState = VirtualEnvEmbeddedState {
    environ: &["RUST_MIN_STACK=16777216", "HOME=~/"],
};
plug_env!(@embedded, VirtualEnvTy, lsr, tre, rustc_opt, llvm_opt);

pub struct CustomProcess;

const SUCCESS_FLAG: i32 = 999;
impl wasi_virt_layer::process::ProcessExit for CustomProcess {
    fn proc_exit<Wasm: WasmAccess + WasmAccessName + 'static>(code: i32) {
        if code == 0 {
            match Wasm::NAME {
                lsr::NAME => WrapUnreachableLsr::set_flag(SUCCESS_FLAG),
                tre::NAME => WrapUnreachableTre::set_flag(SUCCESS_FLAG),
                rustc_opt::NAME => WrapUnreachableRustcOpt::set_flag(SUCCESS_FLAG),
                llvm_opt::NAME => WrapUnreachableLlvmOpt::set_flag(SUCCESS_FLAG),
                _ => unreachable!(),
            }
        } else {
            eprintln!("Process exited with error code {code}.");
        }
    }
}

plug_process!(CustomProcess, lsr, tre, rustc_opt, llvm_opt);

struct VirtualArgsState {
    args: Vec<String>,
}
impl<'a> VirtualArgs<'a> for VirtualArgsState {
    type Str = String;
    fn get_args(&mut self) -> &[Self::Str] {
        &self.args
    }
}

fn set_lsr_args(args: &[impl AsRef<str>]) { VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect(); }
fn set_tre_args(args: &[impl AsRef<str>]) { VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect(); }
fn set_rustc_opt_args(args: &[impl AsRef<str>]) { VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect(); }
fn set_llvm_opt_args(args: &[impl AsRef<str>]) { VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect(); }

static VIRTUAL_ARGS: std::sync::LazyLock<Mutex<VirtualArgsState>> = std::sync::LazyLock::new(|| {
    Mutex::new(VirtualArgsState { args: vec![] })
});

plug_args!(@dynamic, &mut VIRTUAL_ARGS.lock(), lsr, tre, rustc_opt, llvm_opt);

plug_random!(StandardRandom, tre, rustc_opt, llvm_opt);

struct UnreachableHandler;
impl wasi_virt_layer::wasi::wrap_unreachable::WrapUnreachable for UnreachableHandler {
    fn fix_main_raw_exit_code<Wasm: WasmAccess + WasmAccessName + 'static>(code: i32) -> i32 {
        if code == 0 || code == SUCCESS_FLAG { 0 } else { code }
    }
}
wrap_unreachable!(UnreachableHandler, lsr, tre, rustc_opt, llvm_opt);
