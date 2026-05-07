use parking_lot::Mutex;
use std::sync::LazyLock;
use wasi_virt_layer::prelude::*;
use wasi_virt_layer::memory::WasmAccessRaw;
use crate::{vfs_shell};
#[cfg(not(feature = "full-tools"))]
use crate::{rustc_mock, llvm_mock};
// removed CommandRequest
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

#[cfg(not(feature = "full-tools"))]
pub fn set_rustc_mock_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

#[cfg(not(feature = "full-tools"))]
pub fn set_llvm_mock_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}

pub fn set_vfs_shell_args(args: &[impl AsRef<str>]) {
    VIRTUAL_ARGS.lock().args = args.iter().map(|s| s.as_ref().to_string()).collect();
}



#[cfg(not(feature = "full-tools"))]
wasi_virt_layer::plug_args!(@dynamic, { &mut VIRTUAL_ARGS.lock() }, rustc_mock, llvm_mock, vfs_shell);

pub fn handle_command(args: Vec<String>) {
    if args.is_empty() {
        return;
    }
    let cmd = args[0].as_str();
    match cmd {
        "download" => {
            println!("Download requested: {}", args.get(1).unwrap_or(&String::new()));
        }
        _ => {
            println!("Unknown command: {cmd}");
        }
    }
}
