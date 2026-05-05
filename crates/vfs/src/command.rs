use parking_lot::Mutex;
use std::sync::LazyLock;
use wasi_virt_layer::prelude::*;
use wasi_virt_layer::memory::WasmAccessRaw;
use crate::{vfs_shell};
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

#[unsafe(no_mangle)]
pub extern "C" fn vfs_set_args(ptr: *const u8, len: usize) {
    let s = unsafe { std::slice::from_raw_parts(ptr, len) };
    let s = String::from_utf8_lossy(s);
    let args: Vec<String> = s.split('\0').map(|s| s.to_string()).collect();
    VIRTUAL_ARGS.lock().args = args;
}

#[cfg(not(feature = "full-tools"))]
wasi_virt_layer::plug_args!(@dynamic, { &mut VIRTUAL_ARGS.lock() }, rustc_mock, llvm_mock, vfs_shell);

pub fn handle_command(args: Vec<String>) -> CommandRequest {
    if args.is_empty() {
        return CommandRequest::Handled;
    }
    let cmd = args[0].as_str();
    match cmd {
        "download" => CommandRequest::Download(args.get(1).cloned().unwrap_or_default()),
        _ => {
            set_vfs_shell_args(&args);
            vfs_shell::_reset();
            vfs_shell::_start();
            vfs_shell::_main_raw();
            CommandRequest::Handled
        }
    }
}