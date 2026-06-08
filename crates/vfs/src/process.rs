use wasi_virt_layer::memory::WasmAccessName;
use wasi_virt_layer::prelude::*;
use wasi_virt_layer::process::ProcessExit;
use wasi_virt_layer::wasi::wrap_unreachable::WrapUnreachable;

use crate::lsp_opt;
use crate::rustc_opt;
use crate::llvm_opt;
use crate::vfs_shell;

pub const SUCCESS_FLAG: i32 = 999;

pub struct CustomProcess;

impl ProcessExit for CustomProcess {
    fn proc_exit<Wasm: WasmAccess + WasmAccessName + 'static>(code: i32) {
        if code == 0 {
            match Wasm::NAME {
                rustc_opt::NAME => WrapUnreachableRustcOpt::set_flag(SUCCESS_FLAG),
                llvm_opt::NAME => WrapUnreachableLlvmOpt::set_flag(SUCCESS_FLAG),
                vfs_shell::NAME => WrapUnreachableVfsShell::set_flag(SUCCESS_FLAG),
                lsp_opt::NAME => WrapUnreachableLspOpt::set_flag(SUCCESS_FLAG),
                _ => unreachable!(),
            }
        }
    }
}

wasi_virt_layer::plug_process!(CustomProcess, rustc_opt, llvm_opt, vfs_shell, lsp_opt);

pub struct UnreachableHandler;

impl WrapUnreachable for UnreachableHandler {
    fn fix_main_raw_exit_code<Wasm: WasmAccess + WasmAccessName + 'static>(code: i32) -> i32 {
        if code == 0 || code == SUCCESS_FLAG {
            0
        } else {
            code
        }
    }
}

wasi_virt_layer::wrap_unreachable!(UnreachableHandler, rustc_opt, llvm_opt, vfs_shell, lsp_opt);
