use parking_lot::Mutex;
use std::sync::LazyLock;
use wasi_virt_layer::prelude::*;
use crate::{lsr, tre};
#[cfg(not(feature = "full-tools"))]
use crate::{rustc_mock, llvm_mock};
use crate::CommandRequest;

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

pub fn set_lsr_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

pub fn set_tre_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

#[cfg(not(feature = "full-tools"))]
pub fn set_rustc_mock_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

#[cfg(not(feature = "full-tools"))]
pub fn set_llvm_mock_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

#[cfg(not(feature = "full-tools"))]
wasi_virt_layer::plug_args!(@dynamic, { &mut VIRTUAL_ARGS.lock() }, lsr, tre, rustc_mock, llvm_mock);

pub fn handle_command(args: Vec<String>) -> CommandRequest {
    if args.is_empty() {
        return CommandRequest::Handled;
    }
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
        "download" => CommandRequest::Download(args.get(1).cloned().unwrap_or_default()),
        _ => CommandRequest::Handled,
    }
}
