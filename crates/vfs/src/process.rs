use wasi_virt_layer::memory::WasmAccessName;
use wasi_virt_layer::prelude::*;
use wasi_virt_layer::process::ProcessExit;
use wasi_virt_layer::wasi::wrap_unreachable::WrapUnreachable;

use crate::lsp_opt;
use crate::vfs_shell;
#[cfg(not(feature = "full-tools"))]
use crate::{llvm_mock, rustc_mock};
#[cfg(feature = "full-tools")]
use crate::{llvm_opt, rustc_opt};

pub const SUCCESS_FLAG: i32 = 999;

pub struct CustomProcess;

impl ProcessExit for CustomProcess {
    fn proc_exit<Wasm: WasmAccess + WasmAccessName + 'static>(code: i32) {
        if code == 0 {
            match Wasm::NAME {
                #[cfg(not(feature = "full-tools"))]
                rustc_mock::NAME => WrapUnreachableRustcMock::set_flag(SUCCESS_FLAG),
                #[cfg(not(feature = "full-tools"))]
                llvm_mock::NAME => WrapUnreachableLlvmMock::set_flag(SUCCESS_FLAG),
                #[cfg(feature = "full-tools")]
                rustc_opt::NAME => WrapUnreachableRustcOpt::set_flag(SUCCESS_FLAG),
                #[cfg(feature = "full-tools")]
                llvm_opt::NAME => WrapUnreachableLlvmOpt::set_flag(SUCCESS_FLAG),
                vfs_shell::NAME => WrapUnreachableVfsShell::set_flag(SUCCESS_FLAG),
                lsp_opt::NAME => WrapUnreachableLspOpt::set_flag(SUCCESS_FLAG),
                _ => unreachable!(),
            }
        }
    }
}

#[cfg(not(feature = "full-tools"))]
wasi_virt_layer::plug_process!(CustomProcess, rustc_mock, llvm_mock, vfs_shell, lsp_opt);

#[cfg(feature = "full-tools")]
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

#[cfg(not(feature = "full-tools"))]
wasi_virt_layer::wrap_unreachable!(UnreachableHandler, rustc_mock, llvm_mock, vfs_shell, lsp_opt);

#[cfg(feature = "full-tools")]
wasi_virt_layer::wrap_unreachable!(UnreachableHandler, rustc_opt, llvm_opt, vfs_shell, lsp_opt);
