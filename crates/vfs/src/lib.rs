use const_struct::*;
use parking_lot::Mutex;
use std::sync::LazyLock;
use wasi_virt_layer::{
    file::*,
    memory::WasmAccessName,
    prelude::*,
    thread::{DirectThreadPool, VirtualThreadPool},
    wrap_unreachable,
};

wit_bindgen::generate!({
    world: "init",
});

struct Wit;

impl Guest for Wit {
    fn init() {}
    fn main() {
        // unsafe { THREAD_POOL.init() };
        // THREAD_POOL.set_capacity(4);
        // THREAD_POOL.flush_capacity().wait();

        // test print all help
        // Self::run_command(vec!["ls".to_string(), "--help".to_string()]);
        // Self::run_command(vec!["tree".to_string(), "--help".to_string()]);

        // #[cfg(not(feature = "full-tools"))]
        // {
        //     Self::run_command(vec!["rustc".to_string(), "--help".to_string()]);
        //     Self::run_command(vec!["clang".to_string(), "--help".to_string()]);
        // }

        rustc_mock::_reset();
        rustc_mock::_start();
        rustc_mock::_main();
    }

    fn flush_to_vfs(files: Vec<FileEntry>) {
        let root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);
        for f in files {
            let _ = VIRTUAL_FILE_SYSTEM
                .lfs
                .add_file(root, &f.path.replace("/", "_"), f.content);
        }
    }

    fn flush_from_vfs() -> Vec<FileEntry> {
        vec![]
    }

    fn run_command(args: Vec<String>) -> CommandRequest {
        if args.is_empty() {
            return CommandRequest::Handled;
        }
        let cmd = args[0].as_str();
        match cmd {
            // "ls" | "lsr" => {
            //     set_lsr_args(&args);
            //     lsr::_reset();
            //     lsr::_start();
            //     lsr::_main();
            //     CommandRequest::Handled
            // }
            // "tree" | "tre" => {
            //     set_tre_args(&args);
            //     tre::_reset();
            //     tre::_start();
            //     tre::_main();
            //     CommandRequest::Handled
            // }
            // "rustc" => {
            //     #[cfg(not(feature = "full-tools"))]
            //     {
            //         set_rustc_mock_args(&args);
            //         rustc_mock::_reset();
            //         rustc_mock::_start();
            //         rustc_mock::_main();
            //     }
            //     CommandRequest::Handled
            // }
            // "clang" | "llvm" => {
            //     #[cfg(not(feature = "full-tools"))]
            //     {
            //         set_llvm_mock_args(&args);
            //         llvm_mock::_reset();
            //         llvm_mock::_start();
            //         llvm_mock::_main();
            //     }
            //     CommandRequest::Handled
            // }
            // "echo" => {
            //     println!("{}", args[1..].join(" "));
            //     CommandRequest::Handled
            // }
            // "download" => CommandRequest::Download(args.get(1).cloned().unwrap_or_default()),
            _ => CommandRequest::Handled,
        }
    }

    fn read_from_vfs(path: String) -> Result<Vec<u8>, String> {
        let _root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);
        let path_clean = path.replace("/", "_");
        Err(format!("File not found: {}", path_clean))
    }
}

export!(Wit);

type LFS = StandardDynamicLFS<DefaultStdIO>;
static LFS_ROOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

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

#[cfg(not(feature = "full-tools"))]
plug_fs!(&*VIRTUAL_FILE_SYSTEM, self, lsr, tre, rustc_mock, llvm_mock);

#[const_struct]
const VIRTUAL_ENV: VirtualEnvEmbeddedState = VirtualEnvEmbeddedState {
    // environ: &["RUST_MIN_STACK=16777216", "HOME=~/"],
    environ: &["HOME=~/"],
};

#[cfg(not(feature = "full-tools"))]
plug_env!(@embedded, VirtualEnvTy, lsr, tre, rustc_mock, llvm_mock);

// pub struct CustomProcess;
// const SUCCESS_FLAG: i32 = 999;
// impl wasi_virt_layer::process::ProcessExit for CustomProcess {
//     fn proc_exit<Wasm: WasmAccess + WasmAccessName + 'static>(code: i32) {
//         if code == 0 {
//             match core::any::type_name::<Wasm>() {
//                 v if v == core::any::type_name::<lsr>() => {
//                     WrapUnreachableLsr::set_flag(SUCCESS_FLAG)
//                 }
//                 v if v == core::any::type_name::<tre>() => {
//                     WrapUnreachableTre::set_flag(SUCCESS_FLAG)
//                 }
//                 #[cfg(not(feature = "full-tools"))]
//                 v if v == core::any::type_name::<rustc_mock>() => {
//                     WrapUnreachableRustcMock::set_flag(SUCCESS_FLAG)
//                 }
//                 #[cfg(not(feature = "full-tools"))]
//                 v if v == core::any::type_name::<llvm_mock>() => {
//                     WrapUnreachableLlvmMock::set_flag(SUCCESS_FLAG)
//                 }
//                 _ => unreachable!(),
//             }
//         }
//     }
// }

// #[cfg(not(feature = "full-tools"))]
// plug_process!(CustomProcess, lsr, tre, rustc_mock, llvm_mock);
plug_process!(StandardProcess, lsr, tre, rustc_mock, llvm_mock);

// struct VirtualArgsState {
//     args: Vec<String>,
// }
// impl<'a> VirtualArgs<'a> for VirtualArgsState {
//     type Str = String;
//     fn get_args(&mut self) -> &[Self::Str] {
//         &self.args
//     }
// }

// fn set_lsr_args(args: &[impl AsRef<str>]) {
//     VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
// }
// fn set_tre_args(args: &[impl AsRef<str>]) {
//     VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
// }

// #[cfg(not(feature = "full-tools"))]
// fn set_rustc_mock_args(args: &[impl AsRef<str>]) {
//     VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
// }
// #[cfg(not(feature = "full-tools"))]
// fn set_llvm_mock_args(args: &[impl AsRef<str>]) {
//     VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
// }

// static VIRTUAL_ARGS: std::sync::LazyLock<Mutex<VirtualArgsState>> =
//     std::sync::LazyLock::new(|| Mutex::new(VirtualArgsState { args: vec![] }));

// #[cfg(not(feature = "full-tools"))]
// plug_args!(@dynamic, &mut VIRTUAL_ARGS.lock(), lsr, tre, rustc_mock, llvm_mock);

#[const_struct]
const ARGS: VirtualArgsEmbeddedState = VirtualArgsEmbeddedState { args: &[] };

plug_args!(@embedded, ArgsTy, lsr, tre, rustc_mock, llvm_mock);

#[cfg(not(feature = "full-tools"))]
plug_random!(StandardRandom, tre, rustc_mock, llvm_mock);

// static THREAD_POOL: VirtualThreadPool<ThreadAccessor> =
//     unsafe { VirtualThreadPool::new_const(4) };

// plug_thread!({ &THREAD_POOL }, self, rustc_mock);

static DIRECT_THREAD_POOL: DirectThreadPool<ThreadAccessor> = DirectThreadPool::new_const();
plug_thread!({ &DIRECT_THREAD_POOL }, self, rustc_mock);

// struct UnreachableHandler;
// impl wasi_virt_layer::wasi::wrap_unreachable::WrapUnreachable for UnreachableHandler {
//     fn fix_main_raw_exit_code<Wasm: WasmAccess + WasmAccessName + 'static>(code: i32) -> i32 {
//         if code == 0 || code == SUCCESS_FLAG {
//             0
//         } else {
//             code
//         }
//     }
// }

// #[cfg(not(feature = "full-tools"))]
// wrap_unreachable!(UnreachableHandler, lsr, tre, rustc_mock, llvm_mock);
