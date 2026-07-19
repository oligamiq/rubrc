use const_struct::*;
use std::any::TypeId;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::ops::Deref;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use wasi_virt_layer::__private::wasip1::{self, Ciovec, Dircookie, Fd, Size};
use wasi_virt_layer::memory::{
    WasmAccessName, WasmPathAccess, WasmPathComponent, WasmPathComponentCommon,
};
use wasi_virt_layer::wasi::file::Wasip1LFSBase;
use wasi_virt_layer::{file::*, poll::*, prelude::*, thread::VirtualThreadPool};

mod filesystem_sync;
pub mod memory_manager;
use memory_manager::*;

wit_bindgen::generate!({
    world: "vfs-host",
});

const LSP_SESSION_ID: u32 = 0xFFFFFFFF;
const EVENT_TYPE_LSP: u32 = 6;
const EVENT_TYPE_WRITE_FILE: u32 = 7;
const EVENT_TYPE_DEBUG_FIXED_RUSTC: u32 = 1007;
const EVENT_TYPE_DEBUG_RESERVE_SELF: u32 = 1008;
const EVENT_TYPE_DEBUG_RESERVE_RUSTC: u32 = 1009;
pub static THREAD_SESSIONS: std::sync::LazyLock<dashmap::DashMap<std::thread::ThreadId, u32>> =
    std::sync::LazyLock::new(|| dashmap::DashMap::new());

static LSP_STDIN: std::sync::LazyLock<(parking_lot::Mutex<Vec<u8>>, parking_lot::Condvar)> =
    std::sync::LazyLock::new(|| {
        (
            parking_lot::Mutex::new(Vec::new()),
            parking_lot::Condvar::new(),
        )
    });

static DEBUG_TERMINAL_CAPTURE: AtomicBool = AtomicBool::new(false);
static DEBUG_TERMINAL_OUTPUT: std::sync::LazyLock<parking_lot::Mutex<Vec<u8>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(Vec::new()));

#[derive(Default)]
struct CargoOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Default)]
struct VirtualPipe {
    buffer: VecDeque<u8>,
    write_closed: bool,
}

impl VirtualPipe {
    fn closed_with(data: Vec<u8>) -> Self {
        Self {
            buffer: VecDeque::from(data),
            write_closed: true,
        }
    }

    fn read(&mut self, buf: &mut [u8]) -> usize {
        if self.buffer.is_empty() && !self.write_closed {
            return 0;
        }
        let len = std::cmp::min(buf.len(), self.buffer.len());
        for slot in &mut buf[..len] {
            *slot = self.buffer.pop_front().unwrap_or_default();
        }
        len
    }

    fn write(&mut self, buf: &[u8]) -> usize {
        self.buffer.extend(buf.iter().copied());
        buf.len()
    }

    fn drain(&mut self) -> Vec<u8> {
        self.buffer.drain(..).collect()
    }
}

struct ChildProcessStdio {
    owner: std::thread::ThreadId,
    cwd: Vec<u8>,
    stdin: VirtualPipe,
    stdout: VirtualPipe,
    stderr: VirtualPipe,
}

impl ChildProcessStdio {
    fn new(cwd: Vec<u8>, stdin: Vec<u8>) -> Self {
        Self {
            owner: std::thread::current().id(),
            cwd,
            stdin: VirtualPipe::closed_with(stdin),
            stdout: VirtualPipe::default(),
            stderr: VirtualPipe::default(),
        }
    }

    fn is_owner(&self) -> bool {
        self.owner == std::thread::current().id()
    }
}

static CHILD_PROCESS_STDIO: std::sync::LazyLock<parking_lot::Mutex<Option<ChildProcessStdio>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(None));

struct ChildProcessStdioGuard {
    previous: Option<ChildProcessStdio>,
    active: bool,
}

impl ChildProcessStdioGuard {
    fn new(cwd: Vec<u8>, stdin: Vec<u8>) -> Self {
        let previous = {
            let mut process = CHILD_PROCESS_STDIO.lock();
            process.replace(ChildProcessStdio::new(cwd, stdin))
        };
        Self {
            previous,
            active: true,
        }
    }

    fn finish(mut self) -> CargoOutput {
        let mut current = self.restore();
        if !current.cwd.is_empty() {
            debug_trace(&format!(
                "child-process:cwd {}",
                String::from_utf8_lossy(&current.cwd)
            ));
        }
        CargoOutput {
            stdout: current.stdout.drain(),
            stderr: current.stderr.drain(),
        }
    }

    fn restore(&mut self) -> ChildProcessStdio {
        let mut process = CHILD_PROCESS_STDIO.lock();
        let current = process
            .take()
            .unwrap_or_else(|| ChildProcessStdio::new(Vec::new(), Vec::new()));
        *process = self.previous.take();
        self.active = false;
        current
    }
}

impl Drop for ChildProcessStdioGuard {
    fn drop(&mut self) {
        if self.active {
            *CHILD_PROCESS_STDIO.lock() = self.previous.take();
        }
    }
}

fn with_child_process_stdio<T>(
    cwd: Vec<u8>,
    stdin: Vec<u8>,
    f: impl FnOnce() -> T,
) -> (T, CargoOutput) {
    let guard = ChildProcessStdioGuard::new(cwd, stdin);
    let result = f();
    (result, guard.finish())
}

thread_local! {
    static CARGO_OUTPUT: RefCell<Option<CargoOutput>> = const { RefCell::new(None) };
    static RUSTC_ACTIVE: Cell<bool> = const { Cell::new(false) };
}

pub(crate) static CARGO_RUN_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
pub(crate) static CARGO_EXIT_STATUS: AtomicI32 = AtomicI32::new(0);
pub(crate) static RUSTC_RUN_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
#[allow(dead_code)]
static RUSTC_STARTED: AtomicBool = AtomicBool::new(false);
pub(crate) static RUSTC_EXIT_STATUS: AtomicI32 = AtomicI32::new(0);

struct RustcInvocationState {
    previous_env: Vec<String>,
    previous_args: Vec<String>,
    previous_output: Option<CargoOutput>,
}

impl RustcInvocationState {
    fn new(env: Vec<String>, args: Vec<String>) -> Self {
        let previous_env = std::mem::replace(&mut VIRTUAL_SHELL_ENV.lock().env, env);
        let previous_args = std::mem::replace(&mut command::VIRTUAL_ARGS.lock().args, args);
        let previous_output =
            CARGO_OUTPUT.with(|output| output.replace(Some(CargoOutput::default())));
        Self {
            previous_env,
            previous_args,
            previous_output,
        }
    }
}

impl Drop for RustcInvocationState {
    fn drop(&mut self) {
        VIRTUAL_SHELL_ENV.lock().env = std::mem::take(&mut self.previous_env);
        command::VIRTUAL_ARGS.lock().args = std::mem::take(&mut self.previous_args);
        CARGO_OUTPUT.with(|output| {
            output.replace(self.previous_output.take());
        });
    }
}

fn run_rustc_invocation(
    env: Vec<String>,
    args: Vec<String>,
    cwd: Vec<u8>,
    stdin: Vec<u8>,
    run: impl FnOnce(),
) -> (CargoOutput, i32) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _invocation_state = RustcInvocationState::new(env, args);
        debug_trace("wasi-ext-spawn:run-rustc:enter");
        let ((), child_output) = with_child_process_stdio(cwd, stdin, run);
        let status = RUSTC_EXIT_STATUS.load(Ordering::SeqCst);
        debug_trace(&format!("wasi-ext-spawn:run-rustc:return status={status}"));
        (child_output, status)
    }));

    match result {
        Ok(result) => result,
        Err(payload) => {
            let message = if let Some(message) = payload.downcast_ref::<&str>() {
                *message
            } else if let Some(message) = payload.downcast_ref::<String>() {
                message.as_str()
            } else {
                "unknown panic payload"
            };
            debug_trace(&format!("wasi-ext-spawn:run-rustc:panic {message}"));
            (
                CargoOutput {
                    stdout: Vec::new(),
                    stderr: bounded_rustc_panic_error(message),
                },
                RUSTC_PANIC_STATUS,
            )
        }
    }
}

struct RustcActiveGuard;

impl Drop for RustcActiveGuard {
    fn drop(&mut self) {
        RUSTC_ACTIVE.with(|active| active.set(false));
    }
}

pub(crate) fn run_cargo() {
    CARGO_EXIT_STATUS.store(0, Ordering::SeqCst);
    MEMORY_MANAGER.ensure_once::<cargo_opt>(&CARGO_RESERVE_ONCE, CARGO_CONFIG);
    debug_trace(&format!(
        "cargo:memory:after-ensure pages={}",
        memory_size::<cargo_opt>()
    ));
    debug_trace("cargo:_reset:enter");
    cargo_opt::_reset();
    debug_trace(&format!(
        "cargo:memory:after-reset pages={}",
        memory_size::<cargo_opt>()
    ));
    debug_trace("cargo:_reset:return");
    debug_trace("cargo:_main:enter");
    cargo_opt::_main();
    debug_trace(&format!(
        "cargo:memory:after-main pages={}",
        memory_size::<cargo_opt>()
    ));
    debug_trace("cargo:_main:return");
}

pub(crate) fn run_rustc() {
    RUSTC_EXIT_STATUS.store(0, Ordering::SeqCst);
    if RUSTC_ACTIVE.with(|active| active.replace(true)) {
        debug_trace("rustc:already-running");
        RUSTC_EXIT_STATUS.store(127, Ordering::SeqCst);
        return;
    }
    let _active_guard = RustcActiveGuard;
    debug_trace(&format!(
        "rustc:memory:before-ensure pages={}",
        memory_size::<rustc_opt>()
    ));
    MEMORY_MANAGER.ensure_once::<rustc_opt>(&RUSTC_RESERVE_ONCE, RUSTC_CONFIG);
    debug_trace(&format!(
        "rustc:memory:after-ensure pages={}",
        memory_size::<rustc_opt>()
    ));
    debug_trace("rustc:_reset:enter");
    rustc_opt::_reset();
    debug_trace(&format!(
        "rustc:memory:after-reset pages={}",
        memory_size::<rustc_opt>()
    ));
    debug_trace("rustc:_reset:return");
    debug_trace("rustc:_main:enter");
    rustc_opt::_main();
    debug_trace(&format!(
        "rustc:memory:after-main pages={}",
        memory_size::<rustc_opt>()
    ));
    debug_trace("rustc:_main:return");
}

fn capture_cargo_output(stderr: bool, buf: &[u8]) -> bool {
    CARGO_OUTPUT.with(|output| {
        let mut output = output.borrow_mut();
        let Some(output) = output.as_mut() else {
            return false;
        };
        if stderr {
            output.stderr.extend_from_slice(buf);
        } else {
            output.stdout.extend_from_slice(buf);
        }
        true
    })
}

pub(crate) fn debug_trace(message: &str) {
    if DEBUG_TERMINAL_CAPTURE.load(Ordering::Relaxed) {
        let mut output = DEBUG_TERMINAL_OUTPUT.lock();
        output.extend_from_slice(b"\r\n[vfs-debug] ");
        output.extend_from_slice(message.as_bytes());
        output.extend_from_slice(b"\r\n");
    }
}

struct Wit;

impl Guest for Wit {
    fn init() {}
    fn main() {
        let threads = std::env::var("VFS_THREADS")
            .unwrap_or_else(|_| "8".to_string())
            .parse::<usize>()
            .unwrap_or(8);

        unsafe { THREAD_POOL.init() };

        for i in 1..=threads {
            println!("$$1");
            MEMORY_MANAGER.reserve_for_thread();
            println!("d = memory_reserved");

            println!("$$2");

            print!(
                "\x1b[2K\r\x1b[36mInitializing Thread Pool: {}/{} ...\x1b[0m",
                i, threads
            );

            println!("$$3");

            let _ = std::io::Write::flush(&mut std::io::stdout());

            println!("$$4");

            THREAD_POOL.set_capacity(i);

            println!("$$5");

            THREAD_POOL.flush_capacity().wait();

            println!("$$6");
        }
        eprintln!(
            "\x1b[2K\r\x1b[32mThread Pool Initialized ({} threads)\x1b[0m",
            threads
        );

        let root = initialized_lfs_root();
        if let Err(error) = filesystem_sync::import_host_authoritative(
            &VIRTUAL_FILE_SYSTEM.lfs,
            root,
            Path::new("/"),
            filesystem_sync::DEFAULT_SYNC_LIMITS,
        ) {
            eprintln!("failed to initialize VFS from host: {error}");
        }
        if let Err(error) = filesystem_sync::import_host_sysroot(
            &VIRTUAL_FILE_SYSTEM.lfs,
            root,
            Path::new("."),
            filesystem_sync::DEFAULT_SYNC_LIMITS,
        ) {
            eprintln!("failed to initialize VFS sysroot from host: {error}");
        }
        if let Err(error) = recover_child_process() {
            eprintln!("failed to recover child process: {error}");
            return;
        }

        vfs_shell::_reset();
        println!("###");
        MEMORY_MANAGER.ensure_once::<vfs_shell>(&VFS_SHELL_RESERVE_ONCE, VFS_SHELL_CONFIG);
        println!("###2");
        vfs_shell::_start();
        println!("###3");
        vfs_shell::_main();
        println!("###4");
    }

    fn flush_to_vfs() {
        let root = initialized_lfs_root();
        if let Err(error) = filesystem_sync::import_host_authoritative(
            &VIRTUAL_FILE_SYSTEM.lfs,
            root,
            Path::new("/"),
            filesystem_sync::DEFAULT_SYNC_LIMITS,
        ) {
            eprintln!("failed to flush host files to VFS: {error}");
        }
    }

    fn flush_from_vfs() {
        let root = initialized_lfs_root();
        if let Err(error) = filesystem_sync::sync_vfs_to_host(
            &VIRTUAL_FILE_SYSTEM.lfs,
            root,
            Path::new("."),
            filesystem_sync::DEFAULT_SYNC_LIMITS,
            &[],
        ) {
            eprintln!("failed to flush VFS files to host: {error}");
        }
    }

    fn dispatch(session_id: u32, event_type: u32, arg1: u32, arg2: u32) {
        if session_id == LSP_SESSION_ID {
            if LSP_START_ONCE.try_start() {
                MEMORY_MANAGER.reserve_for_thread();
                std::thread::spawn(move || {
                    crate::shell::vfs_set_current_session_id(LSP_SESSION_ID);
                    crate::command::set_lsp_opt_args(&["rust-analyzer"]);
                    MEMORY_MANAGER.ensure_once::<lsp_opt>(&LSP_RESERVE_ONCE, LSP_CONFIG);
                    lsp_opt::_start();
                });
            }
        }

        if event_type == 1 {
            let mut env = VIRTUAL_SHELL_ENV.lock();
            env.env
                .retain(|s| !s.starts_with("COLUMNS=") && !s.starts_with("LINES="));
            env.env.push(format!("COLUMNS={}", arg1));
            env.env.push(format!("LINES={}", arg2));
        } else if event_type == EVENT_TYPE_LSP {
            let ptr = arg1 as *const u8;
            let len = arg2 as usize;
            let data = unsafe { std::slice::from_raw_parts(ptr, len) };
            let (lock, cvar) = &*LSP_STDIN;
            let mut stdin = lock.lock();
            stdin.extend_from_slice(data);
            cvar.notify_all();
            return;
        } else if event_type == EVENT_TYPE_WRITE_FILE {
            let ptr = arg1 as *const u8;
            let len = arg2 as usize;
            let data = unsafe { std::slice::from_raw_parts(ptr, len) };
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(data) {
                if let (Some(path), Some(content)) =
                    (json["path"].as_str(), json["content"].as_str())
                {
                    let path = Path::new(path);
                    let mut current_vfs_parent =
                        LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);

                    if let Some(parent) = path.parent() {
                        for component in parent.components() {
                            if let std::path::Component::Normal(c) = component {
                                let name = c.to_string_lossy();
                                let mut existing_id = None;
                                if let Ok(entries) =
                                    VIRTUAL_FILE_SYSTEM.lfs.read_dir(current_vfs_parent)
                                {
                                    for (entry_name, id) in entries {
                                        if entry_name == name {
                                            existing_id = Some(id);
                                            break;
                                        }
                                    }
                                }
                                if let Some(id) = existing_id {
                                    current_vfs_parent = id;
                                } else {
                                    current_vfs_parent = VIRTUAL_FILE_SYSTEM
                                        .lfs
                                        .add_dir(current_vfs_parent, &name)
                                        .unwrap_or(current_vfs_parent);
                                }
                            }
                        }
                    }

                    if let Some(name) = path.file_name() {
                        let name_str = name.to_string_lossy();
                        let mut file_inode = None;
                        if let Ok(entries) = VIRTUAL_FILE_SYSTEM.lfs.read_dir(current_vfs_parent) {
                            for (entry_name, id) in entries {
                                if entry_name == name_str {
                                    file_inode = Some(id);
                                    break;
                                }
                            }
                        }

                        if let Some(id) = file_inode {
                            let _ = VIRTUAL_FILE_SYSTEM
                                .lfs
                                .write_file(id, content.as_bytes().to_vec());
                        } else {
                            let _ = VIRTUAL_FILE_SYSTEM.lfs.add_file(
                                current_vfs_parent,
                                &name_str,
                                content.as_bytes().to_vec(),
                            );
                        }
                    }
                }
            }
            return;
        } else if event_type == EVENT_TYPE_DEBUG_FIXED_RUSTC {
            let run_marker = arg1;
            crate::debug_trace(&format!("debug-rustc:enter run={run_marker}"));
            let fixed_args: &[&str] = &[
                "rustc",
                "/src/main.rs",
                "--sysroot",
                "/sysroot",
                "--target",
                "wasm32-wasip1",
                "-Ccodegen-units=1",
                "-Clinker-flavor=wasm-ld",
                "-Clinker=wasm-ld",
            ];
            std::thread::spawn(move || {
                let _tool_guard = crate::CARGO_RUN_LOCK.lock();
                let _rustc_guard = crate::RUSTC_RUN_LOCK.lock();
                crate::debug_trace(&format!(
                    "debug-rustc:memory:before-ensure pages={}",
                    crate::memory_size::<rustc_opt>()
                ));
                MEMORY_MANAGER.ensure_once::<rustc_opt>(&RUSTC_RESERVE_ONCE, RUSTC_CONFIG);
                crate::debug_trace(&format!(
                    "debug-rustc:memory:after-ensure pages={}",
                    crate::memory_size::<rustc_opt>()
                ));
                crate::command::set_rustc_opt_args(fixed_args);
                crate::shell::vfs_set_current_session_id(1);
                crate::run_rustc();
                crate::debug_trace(&format!("debug-rustc:return run={run_marker}"));
            })
            .join()
            .unwrap();
            return;
        } else if event_type == EVENT_TYPE_DEBUG_RESERVE_SELF {
            let count = arg1.max(1);
            let pages = arg2.max(1) as i32;
            let before = crate::memory_size_self();
            crate::debug_trace(&format!(
                "debug-reserve-self:enter count={count} pages={pages} before={before}"
            ));
            let mut last_result = 0;
            for _ in 0..count {
                last_result = crate::memory_reserve_self(pages);
            }
            let after = crate::memory_size_self();
            crate::debug_trace(&format!(
                "debug-reserve-self:return count={count} pages={pages} result={last_result} after={after}"
            ));
            return;
        } else if event_type == EVENT_TYPE_DEBUG_RESERVE_RUSTC {
            let count = arg1.max(1);
            let pages = arg2.max(1) as i32;
            let before = crate::memory_size::<rustc_opt>();
            crate::debug_trace(&format!(
                "debug-reserve-rustc:enter count={count} pages={pages} before={before}"
            ));
            let mut last_result = 0;
            for _ in 0..count {
                last_result = crate::memory_reserve::<rustc_opt>(pages);
            }
            let after = crate::memory_size::<rustc_opt>();
            crate::debug_trace(&format!(
                "debug-reserve-rustc:return count={count} pages={pages} result={last_result} after={after}"
            ));
            return;
        }
        unsafe { crate::shell::vfs_shell_dispatch(session_id, event_type, arg1, arg2) };
    }

    fn alloc_buf(len: u32) -> u32 {
        let layout = std::alloc::Layout::from_size_align(len as usize, 8).unwrap();
        let ptr = unsafe { std::alloc::alloc(layout) };
        ptr as u32
    }

    fn free_buf(ptr: u32, len: u32) {
        let layout = std::alloc::Layout::from_size_align(len as usize, 8).unwrap();
        unsafe { std::alloc::dealloc(ptr as *mut u8, layout) };
    }

    fn debug_set_terminal_capture(enabled: bool) {
        if enabled {
            DEBUG_TERMINAL_OUTPUT.lock().clear();
        }
        DEBUG_TERMINAL_CAPTURE.store(enabled, Ordering::SeqCst);
    }

    fn debug_terminal_output_len() -> u32 {
        DEBUG_TERMINAL_OUTPUT
            .try_lock()
            .map_or(0, |output| output.len() as u32)
    }

    fn debug_read_terminal_output(ptr: u32, len: u32) -> u32 {
        let Some(mut output) = DEBUG_TERMINAL_OUTPUT.try_lock() else {
            return 0;
        };
        let read_len = usize::min(output.len(), len as usize);
        if read_len != 0 {
            let destination = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, read_len) };
            destination.copy_from_slice(&output[..read_len]);
            output.drain(..read_len);
        }
        read_len as u32
    }
}

#[cfg(not(test))]
export!(Wit);

pub struct VirtualEnvState {
    pub env: Vec<String>,
}

impl<'a> VirtualEnv<'a> for VirtualEnvState {
    type Str = String;
    fn get_environ(&mut self) -> &[Self::Str] {
        &self.env
    }
}

const CARGO_BUILD_TARGET_ENV: &str = "CARGO_BUILD_TARGET=wasm32-wasip1";

pub static VIRTUAL_SHELL_ENV: std::sync::LazyLock<parking_lot::Mutex<VirtualEnvState>> =
    std::sync::LazyLock::new(|| {
        parking_lot::Mutex::new(VirtualEnvState {
            env: vec![
                "HOME=/".to_string(),
                "CARGO=/cargo".to_string(),
                "CARGO_INCREMENTAL=0".to_string(),
                CARGO_BUILD_TARGET_ENV.to_string(),
                // "RUST_SRC_PATH=/sysroot/lib/rustlib".to_string(),
                "SYSROOT=/sysroot".to_string(),
                "PATH=/bin".to_string(),
            ],
        })
    });

#[derive(Debug)]
pub struct ShellVirtualStdIO;

impl wasi_virt_layer::wasi::file::stdio::StdIO for ShellVirtualStdIO {
    fn write(buf: &[u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        {
            let mut process = CHILD_PROCESS_STDIO.lock();
            if let Some(process) = process.as_mut() {
                if process.is_owner() {
                    return Ok(process.stdout.write(buf));
                }
            }
        }

        if capture_cargo_output(false, buf) {
            return Ok(buf.len());
        }

        let id = crate::shell::CURRENT_CONTEXT_ID
            .with(|id| id.get())
            .unwrap_or(0);
        if id != 0 {
            let len = buf.len() as u32;
            // 1. Allocate buffer in vfs-shell's memory
            let shell_ptr = unsafe { crate::shell::vfs_shell_alloc_buf(len) };
            // 2. Copy our data into vfs-shell's memory via cross-Wasm memcpy
            vfs_shell::memcpy(shell_ptr as *mut u8, buf);
            // 3. Tell vfs-shell to write from its own memory (scalar-only call)
            let written = unsafe { crate::shell::vfs_shell_write_stdout(id, shell_ptr, len) };
            // 4. Free the buffer in vfs-shell's memory
            unsafe { crate::shell::vfs_shell_free_buf(shell_ptr, len) };
            Ok(written as usize)
        } else {
            let session_id = crate::shell::CURRENT_SESSION_ID.with(|id| id.get());
            if session_id == LSP_SESSION_ID || session_id != 0 {
                crate::vfs::host::bridge::Terminal::terminal_write(
                    session_id,
                    buf.as_ptr() as i32,
                    buf.len() as i32,
                );
                Ok(buf.len())
            } else {
                let mut is_lsp = false;
                let current_thread = std::thread::current().id();

                if buf.starts_with(b"Content-Length: ") || buf.starts_with(b"{\"jsonrpc\"") {
                    crate::THREAD_SESSIONS.insert(current_thread, LSP_SESSION_ID);
                }

                if let Some(sid) = crate::THREAD_SESSIONS.get(&current_thread) {
                    if *sid == LSP_SESSION_ID {
                        is_lsp = true;
                    }
                }

                if is_lsp {
                    crate::vfs::host::bridge::Terminal::terminal_write(
                        LSP_SESSION_ID,
                        buf.as_ptr() as i32,
                        buf.len() as i32,
                    );
                    Ok(buf.len())
                } else {
                    wasi_virt_layer::wasi::file::stdio::DefaultStdIO::write(buf)
                }
            }
        }
    }
    fn ewrite(buf: &[u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        {
            let mut process = CHILD_PROCESS_STDIO.lock();
            if let Some(process) = process.as_mut() {
                if process.is_owner() {
                    return Ok(process.stderr.write(buf));
                }
            }
        }

        if capture_cargo_output(true, buf) {
            return Ok(buf.len());
        }

        let id = crate::shell::CURRENT_CONTEXT_ID
            .with(|id| id.get())
            .unwrap_or(0);
        if id != 0 {
            let len = buf.len() as u32;
            let shell_ptr = unsafe { crate::shell::vfs_shell_alloc_buf(len) };
            vfs_shell::memcpy(shell_ptr as *mut u8, buf);
            let written = unsafe { crate::shell::vfs_shell_write_stderr(id, shell_ptr, len) };
            unsafe { crate::shell::vfs_shell_free_buf(shell_ptr, len) };
            Ok(written as usize)
        } else {
            let session_id = crate::shell::CURRENT_SESSION_ID.with(|id| id.get());
            if session_id == LSP_SESSION_ID || session_id != 0 {
                crate::vfs::host::bridge::Terminal::terminal_write(
                    session_id,
                    buf.as_ptr() as i32,
                    buf.len() as i32,
                );
                Ok(buf.len())
            } else {
                wasi_virt_layer::wasi::file::stdio::DefaultStdIO::ewrite(buf)
            }
        }
    }
    fn read(buf: &mut [u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
        {
            let mut process = CHILD_PROCESS_STDIO.lock();
            if let Some(process) = process.as_mut() {
                if process.is_owner() {
                    return Ok(process.stdin.read(buf));
                }
            }
        }

        let session_id = crate::shell::CURRENT_SESSION_ID.with(|id| id.get());
        if session_id == LSP_SESSION_ID || (session_id == 0 && LSP_START_ONCE.is_started()) {
            let (lock, cvar) = &*LSP_STDIN;
            let mut stdin = lock.lock();
            while stdin.is_empty() {
                cvar.wait(&mut stdin);
            }
            let len = std::cmp::min(buf.len(), stdin.len());
            buf[..len].copy_from_slice(&stdin[..len]);
            stdin.drain(..len);
            Ok(len)
        } else {
            wasi_virt_layer::wasi::file::stdio::DefaultStdIO::read(buf)
        }
    }
}

type LFS = StandardDynamicLFS<ShellVirtualStdIO>;

#[derive(Debug)]
struct TargetCwdEntry {
    target_name: &'static str,
    cwd_fd: Fd,
    root_path_hints: Vec<Vec<String>>,
}

#[derive(Debug)]
pub struct CwdAwareFileSystem<F> {
    inner: F,
    root_inode: InodeId,
    root_fd: Fd,
    target_cwds: parking_lot::RwLock<HashMap<TypeId, TargetCwdEntry>>,
    fd_allocation: parking_lot::Mutex<()>,
    append_write: parking_lot::Mutex<()>,
}

impl<F> CwdAwareFileSystem<F> {
    fn new(inner: F, root_inode: InodeId, root_fd: Fd) -> Self {
        Self {
            inner,
            root_inode,
            root_fd,
            target_cwds: parking_lot::RwLock::new(HashMap::new()),
            fd_allocation: parking_lot::Mutex::new(()),
            append_write: parking_lot::Mutex::new(()),
        }
    }
}

impl<F> Deref for CwdAwareFileSystem<F> {
    type Target = F;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

pub struct TargetCwdGuard<'a, F> {
    fs: &'a CwdAwareFileSystem<F>,
    target_id: Option<TypeId>,
    cwd_fd: Option<Fd>,
    remove_fd: fn(&F, Fd),
}

impl<F> Drop for TargetCwdGuard<'_, F> {
    fn drop(&mut self) {
        let Some(target_id) = self.target_id.take() else {
            return;
        };
        let cwd_fd = self.cwd_fd.take().expect("active cwd guard has an fd");
        let mut target_cwds = self.fs.target_cwds.write();
        let entry = target_cwds
            .remove(&target_id)
            .expect("active cwd guard has a target mapping");
        assert_eq!(
            entry.cwd_fd, cwd_fd,
            "cwd descriptor changed for target {}",
            entry.target_name
        );
        (self.remove_fd)(&self.fs.inner, cwd_fd);
    }
}

fn remove_dynamic_fd(inner: &StandardDynamicFileSystem<LFS>, fd: Fd) {
    inner.remove_fd(fd);
}

impl CwdAwareFileSystem<StandardDynamicFileSystem<LFS>> {
    pub fn enter_target_cwd<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        cwd: &[u8],
        root_path_hints: Vec<Vec<String>>,
    ) -> Result<TargetCwdGuard<'_, StandardDynamicFileSystem<LFS>>, String> {
        if cwd.is_empty() {
            return Ok(TargetCwdGuard {
                fs: self,
                target_id: None,
                cwd_fd: None,
                remove_fd: remove_dynamic_fd,
            });
        }
        let cwd = std::str::from_utf8(cwd).map_err(|_| "cwd is not valid UTF-8".to_string())?;

        let mut components = Vec::new();
        for component in Path::new(cwd).components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(component) => components.push(
                    component
                        .to_str()
                        .ok_or_else(|| "cwd component is not valid UTF-8".to_string())?
                        .to_string(),
                ),
                Component::ParentDir => {
                    components
                        .pop()
                        .ok_or_else(|| "cwd escapes the filesystem root".to_string())?;
                }
                Component::Prefix(_) => return Err("cwd contains a path prefix".to_string()),
            }
        }

        let target_id = TypeId::of::<Wasm>();
        let mut target_cwds = self.target_cwds.write();
        if target_cwds.contains_key(&target_id) {
            return Err(format!("target {} already has an active cwd", Wasm::NAME));
        }

        let mut inode = self.root_inode;
        for component in &components {
            let entries = self
                .lfs
                .read_dir(inode)
                .map_err(|_| format!("cannot read cwd component {component}"))?;
            let child = entries
                .into_iter()
                .find_map(|(name, inode)| (name == component.as_str()).then_some(inode))
                .ok_or_else(|| format!("cwd component does not exist: {component}"))?;
            let metadata = self
                .lfs
                .metadata(child)
                .map_err(|_| format!("cannot inspect cwd component {component}"))?;
            if metadata.filetype == wasip1::FILETYPE_SYMBOLIC_LINK {
                return Err(format!("cwd component is a symbolic link: {component}"));
            }
            if metadata.filetype != wasip1::FILETYPE_DIRECTORY {
                return Err(format!("cwd component is not a directory: {component}"));
            }
            inode = child;
        }

        if inode == self.root_inode {
            return Ok(TargetCwdGuard {
                fs: self,
                target_id: None,
                cwd_fd: None,
                remove_fd: remove_dynamic_fd,
            });
        }

        let _allocation = self.fd_allocation.lock();
        self.prepare_fd_allocation()
            .map_err(|()| "file descriptor table exhausted".to_string())?;
        let cwd_fd = self.add_fd(inode, !0, !0);
        target_cwds.insert(
            target_id,
            TargetCwdEntry {
                target_name: Wasm::NAME,
                cwd_fd,
                root_path_hints,
            },
        );
        Ok(TargetCwdGuard {
            fs: self,
            target_id: Some(target_id),
            cwd_fd: Some(cwd_fd),
            remove_fd: remove_dynamic_fd,
        })
    }

    fn prepare_fd_allocation(&self) -> Result<(), ()> {
        let mut next_fd = self.inner.next_fd.load(Ordering::SeqCst);
        while next_fd != u32::MAX && self.inner.fd_map.contains_key(&next_fd) {
            next_fd += 1;
        }
        self.inner.next_fd.store(next_fd, Ordering::SeqCst);
        (next_fd != u32::MAX).then_some(()).ok_or(())
    }

    fn routed_fd<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        target_cwds: &parking_lot::RwLockReadGuard<'_, HashMap<TypeId, TargetCwdEntry>>,
        fd: Fd,
        path_ptr: *const u8,
        path_len: usize,
    ) -> Fd {
        if fd != self.root_fd {
            return fd;
        }
        let Some(entry) = target_cwds.get(&TypeId::of::<Wasm>()) else {
            return fd;
        };
        let mut path_components = WasmPathAccess::<Wasm>::new(path_ptr, path_len).components();
        let Some(first_component) = path_components.next() else {
            return fd;
        };
        if matches!(first_component, WasmPathComponent::RootDir) {
            return fd;
        }
        let mut normalized_path = Vec::new();
        for component in std::iter::once(first_component).chain(path_components) {
            if component.as_cur_dir() {
                continue;
            }
            if component.as_parent_dir() {
                if normalized_path.pop().is_none() {
                    return entry.cwd_fd;
                }
                continue;
            }
            let Some(normal) = component.as_normal() else {
                return entry.cwd_fd;
            };
            normalized_path.push(normal.into_iter().collect::<Vec<_>>());
        }
        if entry.root_path_hints.iter().any(|hint| {
            hint.len() <= normalized_path.len()
                && hint
                    .iter()
                    .zip(&normalized_path)
                    .all(|(hint, component)| hint.as_bytes() == component)
        }) {
            fd
        } else {
            entry.cwd_fd
        }
    }

    fn is_protected_fd(
        &self,
        target_cwds: &parking_lot::RwLockReadGuard<'_, HashMap<TypeId, TargetCwdEntry>>,
        fd: Fd,
    ) -> bool {
        fd == self.root_fd || target_cwds.values().any(|entry| entry.cwd_fd == fd)
    }
}

impl Wasip1FileSystem for CwdAwareFileSystem<StandardDynamicFileSystem<LFS>> {
    fn fd_write_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        iovs_ptr: *const Ciovec,
        iovs_len: usize,
        nwritten: *mut Size,
    ) -> wasip1::Errno {
        if fd <= 2 {
            return self
                .inner
                .fd_write_raw::<Wasm>(fd, iovs_ptr, iovs_len, nwritten);
        }

        let Some(mut entry) = self.inner.fd_map.get_mut(&fd) else {
            return wasip1::ERRNO_BADF;
        };
        let open_fd = entry.value_mut();
        let inode = *open_fd.inode_id();
        let append = open_fd.fd_flags() & wasip1::FDFLAGS_APPEND != 0;
        // The only lock order is descriptor entry, then append_write.
        let _append_write = append.then(|| self.append_write.lock());
        let mut cursor = if append {
            match self.inner.lfs.fd_filestat_get_raw::<Wasm>(&inode) {
                Ok(stat) => stat.size as usize,
                Err(error) => return error,
            }
        } else {
            open_fd.cursor()
        };
        let mut written = 0;
        for iov in Wasm::as_array(iovs_ptr, iovs_len) {
            match self
                .inner
                .lfs
                .fd_pwrite_raw::<Wasm>(&inode, iov.buf, iov.buf_len, cursor)
            {
                Ok(count) => {
                    written += count;
                    cursor += count;
                }
                Err(error) => return error,
            }
        }
        open_fd.set_cursor(cursor);
        Wasm::store_le(nwritten, written as Size);
        wasip1::ERRNO_SUCCESS
    }

    fn fd_pwrite_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        iovs_ptr: *const Ciovec,
        iovs_len: usize,
        offset: u64,
        nwritten: *mut Size,
    ) -> wasip1::Errno {
        self.inner
            .fd_pwrite_raw::<Wasm>(fd, iovs_ptr, iovs_len, offset, nwritten)
    }

    fn fd_advise_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        offset: u64,
        len: u64,
        advice: wasip1::Advice,
    ) -> wasip1::Errno {
        self.inner.fd_advise_raw::<Wasm>(fd, offset, len, advice)
    }

    fn fd_allocate_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        offset: u64,
        len: u64,
    ) -> wasip1::Errno {
        self.inner.fd_allocate_raw::<Wasm>(fd, offset, len)
    }

    fn fd_datasync_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
    ) -> wasip1::Errno {
        self.inner.fd_datasync_raw::<Wasm>(fd)
    }

    fn fd_sync_raw<Wasm: WasmAccess + WasmAccessName + 'static>(&self, fd: Fd) -> wasip1::Errno {
        self.inner.fd_sync_raw::<Wasm>(fd)
    }

    fn fd_tell_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        offset_ret: *mut u64,
    ) -> wasip1::Errno {
        self.inner.fd_tell_raw::<Wasm>(fd, offset_ret)
    }

    fn fd_fdstat_set_flags_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        flags: wasip1::Fdflags,
    ) -> wasip1::Errno {
        self.inner.fd_fdstat_set_flags_raw::<Wasm>(fd, flags)
    }

    fn fd_fdstat_set_rights_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        fs_rights_base: wasip1::Rights,
        fs_rights_inheriting: wasip1::Rights,
    ) -> wasip1::Errno {
        self.inner
            .fd_fdstat_set_rights_raw::<Wasm>(fd, fs_rights_base, fs_rights_inheriting)
    }

    fn fd_filestat_set_size_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        size: u64,
    ) -> wasip1::Errno {
        self.inner.fd_filestat_set_size_raw::<Wasm>(fd, size)
    }

    fn fd_filestat_set_times_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        atim: wasip1::Timestamp,
        mtim: wasip1::Timestamp,
        fst_flags: wasip1::Fstflags,
    ) -> wasip1::Errno {
        self.inner
            .fd_filestat_set_times_raw::<Wasm>(fd, atim, mtim, fst_flags)
    }

    fn path_filestat_set_times_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        flags: wasip1::Lookupflags,
        path_ptr: *const u8,
        path_len: usize,
        atim: wasip1::Timestamp,
        mtim: wasip1::Timestamp,
        fst_flags: wasip1::Fstflags,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let fd = self.routed_fd::<Wasm>(&target_cwds, fd, path_ptr, path_len);
        self.inner.path_filestat_set_times_raw::<Wasm>(
            fd, flags, path_ptr, path_len, atim, mtim, fst_flags,
        )
    }

    fn path_symlink_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        old_path_ptr: *const u8,
        old_path_len: usize,
        fd: Fd,
        new_path_ptr: *const u8,
        new_path_len: usize,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let fd = self.routed_fd::<Wasm>(&target_cwds, fd, new_path_ptr, new_path_len);
        self.inner.path_symlink_raw::<Wasm>(
            old_path_ptr,
            old_path_len,
            fd,
            new_path_ptr,
            new_path_len,
        )
    }

    fn fd_renumber_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        to: Fd,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let _allocation = self.fd_allocation.lock();
        if self.is_protected_fd(&target_cwds, fd) || self.is_protected_fd(&target_cwds, to) {
            return wasip1::ERRNO_NOTCAPABLE;
        }
        if to == u32::MAX {
            return wasip1::ERRNO_MFILE;
        }
        self.inner.fd_renumber_raw::<Wasm>(fd, to)
    }

    fn fd_readdir_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        buf: *mut u8,
        buf_len: usize,
        cookie: Dircookie,
        nread: *mut Size,
    ) -> wasip1::Errno {
        self.inner
            .fd_readdir_raw::<Wasm>(fd, buf, buf_len, cookie, nread)
    }

    fn path_filestat_get_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        flags: wasip1::Lookupflags,
        path_ptr: *const u8,
        path_len: usize,
        filestat: *mut wasip1::Filestat,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let fd = self.routed_fd::<Wasm>(&target_cwds, fd, path_ptr, path_len);
        self.inner
            .path_filestat_get_raw::<Wasm>(fd, flags, path_ptr, path_len, filestat)
    }

    fn fd_prestat_get_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        prestat: *mut wasip1::Prestat,
    ) -> wasip1::Errno {
        self.inner.fd_prestat_get_raw::<Wasm>(fd, prestat)
    }

    fn fd_prestat_dir_name_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        dir_path_ptr: *mut u8,
        dir_path_len: usize,
    ) -> wasip1::Errno {
        self.inner
            .fd_prestat_dir_name_raw::<Wasm>(fd, dir_path_ptr, dir_path_len)
    }

    fn fd_close_raw<Wasm: WasmAccess + WasmAccessName + 'static>(&self, fd: Fd) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        if self.is_protected_fd(&target_cwds, fd) {
            return wasip1::ERRNO_NOTCAPABLE;
        }
        self.inner.fd_close_raw::<Wasm>(fd)
    }

    fn fd_filestat_get_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        filestat: *mut wasip1::Filestat,
    ) -> wasip1::Errno {
        self.inner.fd_filestat_get_raw::<Wasm>(fd, filestat)
    }

    fn fd_fdstat_get_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        fdstat: *mut wasip1::Fdstat,
    ) -> wasip1::Errno {
        self.inner.fd_fdstat_get_raw::<Wasm>(fd, fdstat)
    }

    fn fd_read_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        iovs_ptr: *const Ciovec,
        iovs_len: usize,
        nread: *mut Size,
    ) -> wasip1::Errno {
        self.inner
            .fd_read_raw::<Wasm>(fd, iovs_ptr, iovs_len, nread)
    }

    fn fd_pread_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        iovs_ptr: *const Ciovec,
        iovs_len: usize,
        offset: u64,
        nread: *mut Size,
    ) -> wasip1::Errno {
        self.inner
            .fd_pread_raw::<Wasm>(fd, iovs_ptr, iovs_len, offset, nread)
    }

    fn fd_seek_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        offset: i64,
        whence: wasip1::Whence,
        new_offset_ptr: *mut i64,
    ) -> wasip1::Errno {
        self.inner
            .fd_seek_raw::<Wasm>(fd, offset, whence, new_offset_ptr)
    }

    fn path_open_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        dir_fd: Fd,
        dir_flags: wasip1::Fdflags,
        path_ptr: *const u8,
        path_len: usize,
        o_flags: wasip1::Oflags,
        fs_rights_base: wasip1::Rights,
        fs_rights_inheriting: wasip1::Rights,
        fd_flags: wasip1::Fdflags,
        fd_ret: *mut wasip1::Fd,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let _allocation = self.fd_allocation.lock();
        if self.prepare_fd_allocation().is_err() {
            return wasip1::ERRNO_MFILE;
        }
        let dir_fd = self.routed_fd::<Wasm>(&target_cwds, dir_fd, path_ptr, path_len);
        let result = self.inner.path_open_raw::<Wasm>(
            dir_fd,
            dir_flags,
            path_ptr,
            path_len,
            o_flags,
            fs_rights_base,
            fs_rights_inheriting,
            fd_flags,
            fd_ret,
        );
        if result == wasip1::ERRNO_SUCCESS {
            let fd = Wasm::load_le(fd_ret);
            if let Some(mut entry) = self.inner.fd_map.get_mut(&fd) {
                entry.value_mut().set_fd_flags(fd_flags);
            }
        }
        result
    }

    fn path_readlink_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        path_ptr: *const u8,
        path_len: usize,
        buf: *mut u8,
        buf_len: usize,
        buf_nread: *mut Size,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let fd = self.routed_fd::<Wasm>(&target_cwds, fd, path_ptr, path_len);
        self.inner
            .path_readlink_raw::<Wasm>(fd, path_ptr, path_len, buf, buf_len, buf_nread)
    }

    fn path_create_directory_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        path_ptr: *const u8,
        path_len: usize,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let fd = self.routed_fd::<Wasm>(&target_cwds, fd, path_ptr, path_len);
        self.inner
            .path_create_directory_raw::<Wasm>(fd, path_ptr, path_len)
    }

    fn path_link_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        old_fd: Fd,
        old_flags: wasip1::Lookupflags,
        old_path_ptr: *const u8,
        old_path_len: usize,
        new_fd: Fd,
        new_path_ptr: *const u8,
        new_path_len: usize,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let old_fd = self.routed_fd::<Wasm>(&target_cwds, old_fd, old_path_ptr, old_path_len);
        let new_fd = self.routed_fd::<Wasm>(&target_cwds, new_fd, new_path_ptr, new_path_len);
        self.inner.path_link_raw::<Wasm>(
            old_fd,
            old_flags,
            old_path_ptr,
            old_path_len,
            new_fd,
            new_path_ptr,
            new_path_len,
        )
    }

    fn path_remove_directory_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        path_ptr: *const u8,
        path_len: usize,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let fd = self.routed_fd::<Wasm>(&target_cwds, fd, path_ptr, path_len);
        self.inner
            .path_remove_directory_raw::<Wasm>(fd, path_ptr, path_len)
    }

    fn path_rename_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        old_fd: Fd,
        old_path_ptr: *const u8,
        old_path_len: usize,
        new_fd: Fd,
        new_path_ptr: *const u8,
        new_path_len: usize,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let old_fd = self.routed_fd::<Wasm>(&target_cwds, old_fd, old_path_ptr, old_path_len);
        let new_fd = self.routed_fd::<Wasm>(&target_cwds, new_fd, new_path_ptr, new_path_len);
        self.inner.path_rename_raw::<Wasm>(
            old_fd,
            old_path_ptr,
            old_path_len,
            new_fd,
            new_path_ptr,
            new_path_len,
        )
    }

    fn path_unlink_file_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
        &self,
        fd: Fd,
        path_ptr: *const u8,
        path_len: usize,
    ) -> wasip1::Errno {
        let target_cwds = self.target_cwds.read();
        let fd = self.routed_fd::<Wasm>(&target_cwds, fd, path_ptr, path_len);
        self.inner
            .path_unlink_file_raw::<Wasm>(fd, path_ptr, path_len)
    }
}

pub(crate) static LFS_ROOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn initialized_lfs_root() -> usize {
    std::sync::LazyLock::force(&VIRTUAL_FILE_SYSTEM);
    LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed)
}

pub mod command;
pub mod process;
pub mod shell;

pub static VIRTUAL_FILE_SYSTEM: std::sync::LazyLock<
    CwdAwareFileSystem<StandardDynamicFileSystem<LFS>>,
> = std::sync::LazyLock::new(|| {
    let lfs = StandardDynamicLFS::new();
    let root_inode = lfs.add_preopen(".");
    if let Ok(bin_inode) = lfs.add_dir(root_inode, "bin") {
        let _ = lfs.add_file(bin_inode, "cargo", b"#!/bin/sh\nexit 0\n".to_vec());
    }
    LFS_ROOT.store(root_inode, std::sync::atomic::Ordering::SeqCst);
    let vfs = StandardDynamicFileSystem::new(lfs);
    let root_fd = vfs.add_fd(root_inode, !0, !0);
    CwdAwareFileSystem::new(vfs, root_inode, root_fd)
});

import_wasm!(vfs_shell);
import_wasm!(lsp_opt);
import_wasm!(rustc_opt);
import_wasm!(llvm_opt);
import_wasm!(cargo_opt);
wasi_virt_layer::own_memory!(vfs_shell, lsp_opt, rustc_opt, llvm_opt, cargo_opt);

plug_fs!(
    &*VIRTUAL_FILE_SYSTEM,
    rustc_opt,
    llvm_opt,
    vfs_shell,
    lsp_opt,
    cargo_opt
);

#[const_struct]
const VIRTUAL_ENV: VirtualEnvEmbeddedState = VirtualEnvEmbeddedState {
    // environ: &["RUST_MIN_STACK=16777216", "HOME=~/"],
    environ: &[
        "HOME=~/",
        "CARGO_INCREMENTAL=0",
        CARGO_BUILD_TARGET_ENV,
        "PATH=/bin",
    ],
};

plug_env!(
    @dynamic,
    { &mut VIRTUAL_SHELL_ENV.lock() },
    vfs_shell,
    lsp_opt,
    rustc_opt,
    llvm_opt,
    cargo_opt
);

// plug_process!(StandardProcess, rustc_mock, llvm_mock);

plug_random!(
    StandardRandom,
    rustc_opt,
    llvm_opt,
    vfs_shell,
    lsp_opt,
    cargo_opt
);

plug_poll!(WaitPoll, rustc_opt, llvm_opt, vfs_shell, lsp_opt, cargo_opt);

static THREAD_POOL: VirtualThreadPool<ThreadAccessor> = unsafe { VirtualThreadPool::new_const(8) };

plug_thread!(
    { &THREAD_POOL },
    self,
    cargo_opt,
    rustc_opt,
    vfs_shell,
    lsp_opt,
    llvm_opt
);

plug_clock!(StandardClock, vfs_shell, lsp_opt, cargo_opt);
plug_clock!(StandardClock, rustc_opt);
plug_clock!(StandardClock, llvm_opt);

#[unsafe(no_mangle)]
pub extern "C" fn __wasip1_vfs_cargo_opt_sock_accept(
    _fd: i32,
    _fdflags: i32,
    _socket_fd_ptr: i32,
) -> i32 {
    52
}

#[unsafe(no_mangle)]
pub extern "C" fn __wasip1_vfs_cargo_opt_sock_shutdown(_fd: i32, _how: i32) -> i32 {
    52
}

#[unsafe(no_mangle)]
pub extern "C" fn wasi_ext_fetch(
    method_ptr: i32,
    method_len: i32,
    url_ptr: i32,
    url_len: i32,
    headers_ptr: i32,
    headers_len: i32,
    body_ptr: i32,
    body_len: i32,
    out_status: i32,
    out_resp_ptr: i32,
    out_resp_len: i32,
) -> i32 {
    use crate::vfs::host::bridge::Http;

    const MAX_CHUNK_SIZE: usize = 16 * 1024;

    if method_len < 0
        || url_len < 0
        || headers_len < 0
        || body_len < 0
        || (method_len > 0 && method_ptr == 0)
        || (url_len > 0 && url_ptr == 0)
        || (headers_len > 0 && headers_ptr == 0)
        || (body_len > 0 && body_ptr == 0)
        || out_status == 0
        || out_resp_ptr == 0
        || out_resp_len == 0
    {
        return 1;
    }

    let copy_request = |ptr: i32, len: i32| {
        if len == 0 {
            Box::<[u8]>::default()
        } else {
            cargo_opt::get_array(ptr as *const u8, len as usize)
        }
    };
    let method = copy_request(method_ptr, method_len);
    let url = copy_request(url_ptr, url_len);
    let headers = copy_request(headers_ptr, headers_len);
    let body = copy_request(body_ptr, body_len);

    let mut request_id = 0u32;
    let mut status = 0u32;
    let mut response_headers_len = 0u32;
    let mut response_body_len = 0u32;
    let mut response_error_len = 0u32;
    let start_result = Http::request_start(
        method.as_ptr() as i32,
        method.len() as i32,
        url.as_ptr() as i32,
        url.len() as i32,
        headers.as_ptr() as i32,
        headers.len() as i32,
        body.as_ptr() as i32,
        body.len() as i32,
        (&mut request_id as *mut u32) as i32,
        (&mut status as *mut u32) as i32,
        (&mut response_headers_len as *mut u32) as i32,
        (&mut response_body_len as *mut u32) as i32,
        (&mut response_error_len as *mut u32) as i32,
    );

    struct ResponseGuard {
        request_id: u32,
        active: bool,
    }

    impl ResponseGuard {
        fn finish(mut self) -> i32 {
            self.active = false;
            Http::response_end(self.request_id)
        }
    }

    impl Drop for ResponseGuard {
        fn drop(&mut self) {
            if self.active {
                let _ = Http::response_end(self.request_id);
            }
        }
    }

    if start_result != 0 {
        return 1;
    }
    let response_guard = ResponseGuard {
        request_id,
        active: true,
    };

    let allocate_buffer = |length: u32| -> Option<Vec<u8>> {
        let length = usize::try_from(length).ok()?;
        let mut buffer = Vec::new();
        buffer.try_reserve_exact(length).ok()?;
        buffer.resize(length, 0);
        Some(buffer)
    };
    let Some(mut response_headers) = allocate_buffer(response_headers_len) else {
        return 1;
    };
    let Some(mut response_body) = allocate_buffer(response_body_len) else {
        return 1;
    };
    let Some(mut response_error) = allocate_buffer(response_error_len) else {
        return 1;
    };

    let mut offset = 0usize;
    while offset < response_headers.len() {
        let chunk_len = MAX_CHUNK_SIZE.min(response_headers.len() - offset);
        let result = Http::response_read_headers(
            request_id,
            response_headers[offset..].as_mut_ptr() as i32,
            chunk_len as i32,
        );
        if result != 0 {
            return 1;
        }
        offset += chunk_len;
    }

    offset = 0;
    while offset < response_body.len() {
        let chunk_len = MAX_CHUNK_SIZE.min(response_body.len() - offset);
        let result = Http::response_read_body(
            request_id,
            response_body[offset..].as_mut_ptr() as i32,
            chunk_len as i32,
        );
        if result != 0 {
            return 1;
        }
        offset += chunk_len;
    }

    offset = 0;
    while offset < response_error.len() {
        let chunk_len = MAX_CHUNK_SIZE.min(response_error.len() - offset);
        let result = Http::response_read_error(
            request_id,
            response_error[offset..].as_mut_ptr() as i32,
            chunk_len as i32,
        );
        if result != 0 {
            return 1;
        }
        offset += chunk_len;
    }

    if response_guard.finish() != 0 || !response_error.is_empty() || status > u16::MAX as u32 {
        return 1;
    }

    let Some(response) = format_http_response(status, &response_headers, &response_body) else {
        return 1;
    };

    let Ok(response_len) = u32::try_from(response.len()) else {
        return 1;
    };
    let cargo_response_ptr = unsafe { wasi_ext_allocate(response.len()) };
    if cargo_response_ptr.is_null() {
        return 1;
    }
    cargo_opt::memcpy(cargo_response_ptr, &response);
    cargo_opt::memcpy(out_status as *mut u8, &(status as u16).to_ne_bytes());
    cargo_opt::memcpy(
        out_resp_ptr as *mut u8,
        &(cargo_response_ptr as u32).to_ne_bytes(),
    );
    cargo_opt::memcpy(out_resp_len as *mut u8, &response_len.to_ne_bytes());
    0
}

fn format_http_response(status: u32, headers: &[u8], body: &[u8]) -> Option<Vec<u8>> {
    let status_line = status.to_string();
    let separator_len = if !headers.is_empty() && !headers.ends_with(b"\n") {
        3
    } else {
        2
    };
    let response_capacity = status_line
        .len()
        .checked_add(headers.len())?
        .checked_add(body.len())?
        .checked_add(separator_len)?;
    let mut response = Vec::new();
    response.try_reserve_exact(response_capacity).ok()?;
    response.extend_from_slice(status_line.as_bytes());
    response.push(b'\n');
    response.extend_from_slice(headers);
    if !headers.is_empty() && !headers.ends_with(b"\n") {
        response.push(b'\n');
    }
    response.push(b'\n');
    response.extend_from_slice(body);
    Some(response)
}

#[unsafe(no_mangle)]
pub extern "C" fn wasi_ext_git_clone(
    _url_ptr: i32,
    _url_len: i32,
    _dest_ptr: i32,
    _dest_len: i32,
) -> i32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn wasi_ext_git_fetch(_path_ptr: i32, _path_len: i32) -> i32 {
    1
}

fn normalize_root_path_hint(path: &str) -> Option<Vec<String>> {
    let mut components = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(component) => components.push(component.to_str()?.to_string()),
            Component::ParentDir => {
                components.pop()?;
            }
            Component::Prefix(_) => return None,
        }
    }
    (!components.is_empty()).then_some(components)
}

fn rustc_root_path_hints(argv: &[String]) -> Vec<Vec<String>> {
    let mut hints = Vec::new();
    let mut next_is_emit_value = false;
    for argument in argv {
        let bytes = argument.as_bytes();
        let comma_delimited = next_is_emit_value || argument.starts_with("--emit=");
        next_is_emit_value = argument == "--emit";
        let mut offset = 0;
        while let Some(relative_start) = bytes[offset..].iter().position(|byte| *byte == b'/') {
            let start = offset + relative_start;
            if start != 0 && !matches!(bytes[start - 1], b'=' | b'@') {
                offset = start + 1;
                continue;
            }
            let end = if comma_delimited {
                bytes[start..]
                    .iter()
                    .position(|byte| *byte == b',')
                    .map_or(bytes.len(), |end| start + end)
            } else {
                bytes.len()
            };
            if let Some(hint) = normalize_root_path_hint(&argument[start..end])
                && !hints.contains(&hint)
            {
                hints.push(hint);
            }
            if end == bytes.len() {
                break;
            }
            offset = end + 1;
        }
    }
    hints
}

#[unsafe(no_mangle)]
pub extern "C" fn wasi_ext_spawn(
    program_ptr: i32,
    program_len: i32,
    spawn_mode: i32,
    args_ptr: i32,
    args_len: i32,
    env_ptr: i32,
    env_len: i32,
    cwd_ptr: i32,
    cwd_len: i32,
    stdin_ptr: i32,
    stdin_len: i32,
    out_exit_code: i32,
    out_stdout_ptr: i32,
    out_stdout_len: i32,
    out_stderr_ptr: i32,
    out_stderr_len: i32,
) -> i32 {
    if RUSTC_ACTIVE.with(|active| active.get()) {
        return 1;
    }

    let program = cargo_opt::get_array(program_ptr as *const u8, program_len as usize);
    let program = String::from_utf8_lossy(&program).into_owned();
    let args = cargo_opt::get_array(args_ptr as *const u8, args_len as usize);
    let env = cargo_opt::get_array(env_ptr as *const u8, env_len as usize);
    let cwd = cargo_opt::get_array(cwd_ptr as *const u8, cwd_len as usize);
    let stdin = cargo_opt::get_array(stdin_ptr as *const u8, stdin_len as usize).to_vec();
    crate::debug_trace(&format!(
        "wasi-ext-spawn:enter program={program} args_len={args_len} env_len={env_len} cwd_len={cwd_len}"
    ));

    let mut argv = vec![program.clone()];
    argv.extend(
        args.split(|byte| *byte == 0)
            .filter(|arg| !arg.is_empty())
            .map(|arg| String::from_utf8_lossy(arg).into_owned()),
    );

    let program_name = Path::new(&program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&program);
    crate::debug_trace(&format!("wasi-ext-spawn:program-name {program_name}"));
    if program_name != "rustc" {
        if spawn_mode == WASI_SPAWN_REPLACE
            && Path::new(&program).extension() == Some(OsStr::new("wasm"))
        {
            let (stderr, status) = run_wasi_child(&program, &args, &env, &cwd);
            write_cargo_owned_spawn_result(
                Vec::new(),
                stderr,
                status,
                out_exit_code,
                out_stdout_ptr,
                out_stdout_len,
                out_stderr_ptr,
                out_stderr_len,
            );
            crate::debug_trace(&format!("wasi-ext-spawn:return status={status}"));
            return 0;
        }
        let message = format!("unsupported child process: {program}");
        crate::debug_trace(&format!("wasi-ext-spawn:unsupported {program}"));
        write_cargo_owned_spawn_result(
            Vec::new(),
            message.into_bytes(),
            127,
            out_exit_code,
            out_stdout_ptr,
            out_stdout_len,
            out_stderr_ptr,
            out_stderr_len,
        );
        return 0;
    }

    let _rustc_guard = RUSTC_RUN_LOCK.lock();

    let mut is_wasm32_target = true;
    let mut expect_target = false;
    for arg in &argv {
        if expect_target {
            is_wasm32_target = arg.contains("wasm32");
            expect_target = false;
        } else if arg == "--target" {
            expect_target = true;
        } else if arg.starts_with("--target=") {
            is_wasm32_target = arg.contains("wasm32");
        }
    }

    argv.push("--sysroot".to_string());
    argv.push("/sysroot".to_string());
    if is_wasm32_target {
        argv.push("-Clinker-flavor=wasm-ld".to_string());
        argv.push("-Clinker=wasm-ld".to_string());
    }
    let root_path_hints = rustc_root_path_hints(&argv);

    if !cwd.is_empty() {
        debug_trace(&format!(
            "wasi-ext-spawn:virtual-cwd {}",
            String::from_utf8_lossy(&cwd)
        ));
    }

    let cwd_guard = match VIRTUAL_FILE_SYSTEM.enter_target_cwd::<rustc_opt>(&cwd, root_path_hints) {
        Ok(guard) => guard,
        Err(error) => {
            let stderr = bounded_rustc_cwd_error(&cwd, &error);
            write_cargo_owned_spawn_result(
                Vec::new(),
                stderr,
                RUSTC_CWD_ERROR_STATUS,
                out_exit_code,
                out_stdout_ptr,
                out_stdout_len,
                out_stderr_ptr,
                out_stderr_len,
            );
            return 0;
        }
    };

    let rustc_env = env
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).into_owned())
        .collect();
    let (child_output, status) =
        run_rustc_invocation(rustc_env, argv, cwd.to_vec(), stdin, run_rustc);

    drop(cwd_guard);

    write_cargo_owned_spawn_result(
        child_output.stdout,
        child_output.stderr,
        status,
        out_exit_code,
        out_stdout_ptr,
        out_stdout_len,
        out_stderr_ptr,
        out_stderr_len,
    );
    crate::debug_trace(&format!("wasi-ext-spawn:return status={status}"));
    0
}

const WASI_SPAWN_REPLACE: i32 = 1;
const MAX_CHILD_MODULE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHILD_MODULE_CHUNK_BYTES: usize = 256 * 1024;
const MAX_CHILD_ERROR_BYTES: usize = 64 * 1024;
const RUSTC_CWD_ERROR_STATUS: i32 = 1;
const RUSTC_PANIC_STATUS: i32 = 101;
const CHILD_STATE_UPLOADING: u32 = 1;
const CHILD_STATE_RUNNING: u32 = 2;
const CHILD_STATE_COMPLETED: u32 = 3;

fn bounded_rustc_cwd_error(cwd: &[u8], error: &str) -> Vec<u8> {
    let mut stderr = format!(
        "failed to set virtual cwd `{}`: {error}",
        String::from_utf8_lossy(cwd),
    )
    .into_bytes();
    stderr.truncate(MAX_CHILD_ERROR_BYTES);
    stderr
}

fn bounded_rustc_panic_error(message: &str) -> Vec<u8> {
    let mut stderr = format!("embedded rustc panicked: {message}").into_bytes();
    stderr.truncate(MAX_CHILD_ERROR_BYTES);
    stderr
}

fn checked_child_module_size(size: u64) -> Result<usize, String> {
    let size = usize::try_from(size).map_err(|_| "child module exceeds 16 MiB".to_string())?;
    if size > MAX_CHILD_MODULE_BYTES {
        return Err("child module exceeds 16 MiB".to_string());
    }
    Ok(size)
}

fn decode_cargo_spawn_list(bytes: &[u8]) -> Result<Vec<String>, String> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let Some(bytes) = bytes.strip_suffix(&[0]) else {
        return Err("Cargo child list is missing its terminator".to_string());
    };
    let mut values = Vec::new();
    for bytes in bytes.split(|byte| *byte == 0) {
        if bytes.is_empty() {
            return Err("Cargo child list contains an empty string".to_string());
        }
        values.push(
            std::str::from_utf8(bytes)
                .map_err(|_| "Cargo child list is not valid UTF-8".to_string())?
                .to_string(),
        );
    }
    Ok(values)
}

fn encode_child_list(values: &[String]) -> Result<Vec<u8>, String> {
    if values.iter().any(String::is_empty) {
        return Err("Cargo child list contains an empty string".to_string());
    }
    Ok(values.join("\0").into_bytes())
}

fn resolve_child_program(program: &str, cwd: &[u8]) -> Result<PathBuf, String> {
    if program.is_empty() {
        return Err("child program is empty".to_string());
    }
    let cwd = std::str::from_utf8(cwd).map_err(|_| "child cwd is not valid UTF-8".to_string())?;
    let program = Path::new(program);
    let source = if program.is_absolute() {
        program.to_path_buf()
    } else {
        Path::new(cwd).join(program)
    };
    let mut resolved = PathBuf::new();
    for component in source.components() {
        match component {
            Component::Normal(component) => resolved.push(component),
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir | Component::RootDir => {}
            Component::Prefix(_) => {
                return Err("child program has an unsupported path prefix".to_string());
            }
        }
    }
    if resolved.as_os_str().is_empty() {
        return Err("child program resolves to the filesystem root".to_string());
    }
    Ok(resolved)
}

fn read_vfs_file(path: &Path) -> Result<Vec<u8>, String> {
    let mut inode = initialized_lfs_root();
    for component in path.components() {
        let Component::Normal(component) = component else {
            continue;
        };
        let name = component
            .to_str()
            .ok_or_else(|| "child program path is not valid UTF-8".to_string())?;
        inode = VIRTUAL_FILE_SYSTEM
            .lfs
            .read_dir(inode)
            .map_err(|_| {
                format!(
                    "failed to read child program directory `{}`",
                    path.display()
                )
            })?
            .into_iter()
            .find_map(|(entry_name, inode)| (entry_name == name).then_some(inode))
            .ok_or_else(|| format!("child program not found: {}", path.display()))?;
    }
    let stat =
        <LFS as Wasip1LFSBase>::fd_filestat_get_raw::<__self>(&VIRTUAL_FILE_SYSTEM.lfs, &inode)
            .map_err(|_| format!("failed to stat child program: {}", path.display()))?;
    let file_size = checked_child_module_size(stat.size)?;
    let mut bytes = vec![0; file_size];
    let bytes_read = <LFS as Wasip1LFSBase>::fd_pread_raw::<__self>(
        &VIRTUAL_FILE_SYSTEM.lfs,
        &inode,
        bytes.as_mut_ptr(),
        bytes.len(),
        0,
    )
    .map_err(|_| format!("failed to read child program: {}", path.display()))?;
    bytes.truncate(bytes_read);
    let final_stat =
        <LFS as Wasip1LFSBase>::fd_filestat_get_raw::<__self>(&VIRTUAL_FILE_SYSTEM.lfs, &inode)
            .map_err(|_| format!("failed to stat child program: {}", path.display()))?;
    if final_stat.size != stat.size || bytes.len() != file_size {
        return Err("child program changed while it was being read".to_string());
    }
    Ok(bytes)
}

fn bounded_child_error(message: impl AsRef<[u8]>) -> Vec<u8> {
    let mut message = message.as_ref().to_vec();
    message.truncate(MAX_CHILD_ERROR_BYTES);
    message
}

fn bounded_child_result(result: Result<(Vec<u8>, i32), String>) -> (Vec<u8>, i32) {
    match result {
        Ok(result) => result,
        Err(error) => (bounded_child_error(error), 126),
    }
}

struct RequestGuard<End>
where
    End: FnMut(u32) -> i32,
{
    request_id: u32,
    end: End,
    end_on_drop: bool,
}

impl<End> RequestGuard<End>
where
    End: FnMut(u32) -> i32,
{
    fn new(request_id: u32, end: End) -> Self {
        Self {
            request_id,
            end,
            end_on_drop: true,
        }
    }

    fn retain_on_drop(&mut self) {
        self.end_on_drop = false;
    }

    fn finish(mut self) -> Result<(), String> {
        self.end_on_drop = false;
        if (self.end)(self.request_id) != 0 {
            return Err("failed to end child process request".to_string());
        }
        Ok(())
    }
}

impl<End> Drop for RequestGuard<End>
where
    End: FnMut(u32) -> i32,
{
    fn drop(&mut self) {
        if self.end_on_drop {
            self.end_on_drop = false;
            let _ = (self.end)(self.request_id);
        }
    }
}

fn append_child_conflicts(stderr: &mut Vec<u8>, conflicts: &[PathBuf]) {
    if conflicts.is_empty() {
        return;
    }

    let mut diagnostic = b"warning: child filesystem synchronization conflicts; concurrent VFS edits were preserved:\n".to_vec();
    for path in conflicts {
        let line = format!("  {}\n", path.display());
        if diagnostic.len().saturating_add(line.len()) > MAX_CHILD_ERROR_BYTES {
            let omitted = b"  ... additional conflicts omitted\n";
            if diagnostic.len().saturating_add(omitted.len()) <= MAX_CHILD_ERROR_BYTES {
                diagnostic.extend_from_slice(omitted);
            }
            break;
        }
        diagnostic.extend_from_slice(line.as_bytes());
    }
    diagnostic.truncate(MAX_CHILD_ERROR_BYTES);

    if !stderr.is_empty() && !stderr.ends_with(b"\n") {
        diagnostic.insert(0, b'\n');
        diagnostic.truncate(MAX_CHILD_ERROR_BYTES);
    }
    let child_limit = MAX_CHILD_ERROR_BYTES - diagnostic.len();
    stderr.truncate(child_limit);
    stderr.extend_from_slice(&diagnostic);
}

fn finish_child_request<End, Sync>(
    request: RequestGuard<End>,
    mut stderr: Vec<u8>,
    status: i32,
    sync: Sync,
) -> Result<(Vec<u8>, i32), String>
where
    End: FnMut(u32) -> i32,
    Sync: FnOnce() -> Result<Vec<PathBuf>, String>,
{
    let conflicts = sync()?;
    if !conflicts.is_empty() {
        crate::debug_trace(&format!("child-process:filesystem-conflicts {conflicts:?}"));
        append_child_conflicts(&mut stderr, &conflicts);
    }
    request.finish()?;
    stderr.truncate(MAX_CHILD_ERROR_BYTES);
    Ok((stderr, status))
}

fn run_wasi_child(program: &str, args: &[u8], env: &[u8], cwd: &[u8]) -> (Vec<u8>, i32) {
    use crate::vfs::host::bridge::ChildProcess;

    let result = (|| -> Result<(Vec<u8>, i32), String> {
        let executable = resolve_child_program(program, cwd)?;
        let module = read_vfs_file(&executable)?;
        if module.len() > MAX_CHILD_MODULE_BYTES {
            return Err("child module exceeds 16 MiB".to_string());
        }

        let mut argv = vec![program.to_string()];
        argv.extend(decode_cargo_spawn_list(args)?);
        let env = decode_cargo_spawn_list(env)?;
        let argv_bytes = encode_child_list(&argv)?;
        let env_bytes = encode_child_list(&env)?;
        let cargo_target_dir = env
            .iter()
            .find_map(|entry| entry.strip_prefix("CARGO_TARGET_DIR="));
        let cargo_cwd =
            std::str::from_utf8(cwd).map_err(|_| "child cwd is not valid UTF-8".to_string())?;
        let exclusions = filesystem_sync::runtime_exclusions_from_child(
            cargo_target_dir.map(Path::new),
            Path::new(cargo_cwd),
            &executable,
        );
        let root = initialized_lfs_root();
        let baseline = filesystem_sync::sync_vfs_to_host(
            &VIRTUAL_FILE_SYSTEM.lfs,
            root,
            Path::new("/"),
            filesystem_sync::DEFAULT_SYNC_LIMITS,
            &exclusions,
        )
        .map_err(|error| format!("failed to prepare child filesystem: {error}"))?;

        let mut request_id = 0u32;
        if ChildProcess::request_start(
            argv_bytes.as_ptr() as i32,
            argv_bytes.len() as i32,
            env_bytes.as_ptr() as i32,
            env_bytes.len() as i32,
            module.len() as i32,
            (&mut request_id as *mut u32) as i32,
        ) != 0
        {
            return Err("failed to start child process request".to_string());
        }

        let mut request = RequestGuard::new(request_id, ChildProcess::request_end);

        for chunk in module.chunks(MAX_CHILD_MODULE_CHUNK_BYTES) {
            if ChildProcess::request_write(request_id, chunk.as_ptr() as i32, chunk.len() as i32)
                != 0
            {
                return Err("failed to upload child module".to_string());
            }
        }

        let mut status = 0u32;
        let mut error_len = 0u32;
        if ChildProcess::request_run(
            request_id,
            (&mut status as *mut u32) as i32,
            (&mut error_len as *mut u32) as i32,
        ) != 0
        {
            return Err("failed to run child process".to_string());
        }

        let graceful = error_len == 0;
        if graceful {
            request.retain_on_drop();
        }

        let error_len = usize::try_from(error_len)
            .map_err(|_| "child process error length is invalid".to_string())?;
        let mut child_error = if error_len > MAX_CHILD_ERROR_BYTES {
            bounded_child_error("child process error exceeds 64 KiB")
        } else {
            let mut error = vec![0; error_len];
            for chunk in error.chunks_mut(MAX_CHILD_ERROR_BYTES) {
                if ChildProcess::request_read_error(
                    request_id,
                    chunk.as_mut_ptr() as i32,
                    chunk.len() as i32,
                ) != 0
                {
                    return Err("failed to read child process error".to_string());
                }
            }
            error
        };

        if graceful {
            return finish_child_request(request, child_error, status as i32, || {
                filesystem_sync::sync_host_to_vfs(
                    &VIRTUAL_FILE_SYSTEM.lfs,
                    root,
                    Path::new("/"),
                    &baseline,
                    filesystem_sync::DEFAULT_SYNC_LIMITS,
                )
                .map_err(|error| format!("failed to import child filesystem: {error}"))
            });
        }
        request.finish()?;
        child_error.truncate(MAX_CHILD_ERROR_BYTES);
        Ok((child_error, status as i32))
    })();

    bounded_child_result(result)
}

fn recover_child_process_with<Recover, Import, End>(
    recover: Recover,
    import: Import,
    end: End,
) -> Result<(), String>
where
    Recover: FnOnce() -> Result<Option<(u32, u32)>, String>,
    Import: FnOnce() -> Result<(), String>,
    End: FnOnce(u32) -> Result<(), String>,
{
    let Some((request_id, state)) = recover()? else {
        return Ok(());
    };

    if should_import_recovered_child(state) {
        import()?;
    } else {
        crate::debug_trace(&format!("child-process:recovery-invalid-state {state}"));
    }
    end(request_id)
}

fn recover_child_process() -> Result<(), String> {
    use crate::vfs::host::bridge::ChildProcess;

    recover_child_process_with(
        || {
            let mut request_id = 0u32;
            let mut state = 0u32;
            let mut status = 0u32;
            let mut error_len = 0u32;
            if ChildProcess::request_recover(
                (&mut request_id as *mut u32) as i32,
                (&mut state as *mut u32) as i32,
                (&mut status as *mut u32) as i32,
                (&mut error_len as *mut u32) as i32,
            ) != 0
            {
                return Err("failed to recover child process request".to_string());
            }
            Ok((request_id != 0).then_some((request_id, state)))
        },
        || {
            let root = initialized_lfs_root();
            filesystem_sync::import_host_authoritative(
                &VIRTUAL_FILE_SYSTEM.lfs,
                root,
                Path::new("/"),
                filesystem_sync::DEFAULT_SYNC_LIMITS,
            )
            .map(|_| ())
            .map_err(|error| format!("failed to import recovered child filesystem: {error}"))
        },
        |request_id| {
            if ChildProcess::request_end(request_id) != 0 {
                return Err(format!(
                    "failed to end recovered child process request {request_id}"
                ));
            }
            Ok(())
        },
    )
}

fn should_import_recovered_child(state: u32) -> bool {
    matches!(
        state,
        CHILD_STATE_UPLOADING | CHILD_STATE_RUNNING | CHILD_STATE_COMPLETED
    )
}

#[cfg(target_os = "wasi")]
#[link(wasm_import_module = "wasip1_vfs_cargo_opt")]
unsafe extern "C" {
    fn wasi_ext_allocate(size: usize) -> *mut u8;
}

#[cfg(not(target_os = "wasi"))]
unsafe fn wasi_ext_allocate(size: usize) -> *mut u8 {
    allocate_cargo_owned(size)
}

#[cfg(not(target_os = "wasi"))]
fn allocate_cargo_owned(size: usize) -> *mut u8 {
    Box::into_raw(vec![0; size].into_boxed_slice()) as *mut u8
}

#[allow(clippy::too_many_arguments)]
fn write_cargo_owned_spawn_result(
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: i32,
    out_exit_code: i32,
    out_stdout_ptr: i32,
    out_stdout_len: i32,
    out_stderr_ptr: i32,
    out_stderr_len: i32,
) {
    fn copy_to_cargo(data: &[u8]) -> (i32, i32) {
        let ptr = unsafe { wasi_ext_allocate(data.len()) };
        cargo_opt::memcpy(ptr, data);
        (ptr as i32, data.len() as i32)
    }

    let (stdout_ptr, stdout_len) = copy_to_cargo(&stdout);
    let (stderr_ptr, stderr_len) = copy_to_cargo(&stderr);
    cargo_opt::memcpy(out_exit_code as *mut u8, &status.to_ne_bytes());
    cargo_opt::memcpy(out_stdout_ptr as *mut u8, &stdout_ptr.to_ne_bytes());
    cargo_opt::memcpy(out_stdout_len as *mut u8, &stdout_len.to_ne_bytes());
    cargo_opt::memcpy(out_stderr_ptr as *mut u8, &stderr_ptr.to_ne_bytes());
    cargo_opt::memcpy(out_stderr_len as *mut u8, &stderr_len.to_ne_bytes());
}

#[unsafe(no_mangle)]
pub extern "C" fn sysroot_start_fetch(vfs_shell_triple_ptr: i32, triple_len: i32) {
    let triple_data = vfs_shell::get_array(vfs_shell_triple_ptr as *const u8, triple_len as usize);
    crate::vfs::host::bridge::Downloader::sysroot_start_fetch(
        triple_data.as_ptr() as i32,
        triple_len,
    );
}

#[unsafe(no_mangle)]
pub extern "C" fn sysroot_get_next_file_meta(
    vfs_shell_name_len_ptr: i32,
    vfs_shell_data_len_ptr: i32,
) -> i32 {
    let mut name_len = 0i32;
    let mut data_len = 0i32;
    let has_next = crate::vfs::host::bridge::Downloader::sysroot_get_next_file_meta(
        &mut name_len as *mut _ as i32,
        &mut data_len as *mut _ as i32,
    );

    vfs_shell::memcpy(vfs_shell_name_len_ptr as *mut u8, &name_len.to_ne_bytes());
    vfs_shell::memcpy(vfs_shell_data_len_ptr as *mut u8, &data_len.to_ne_bytes());

    has_next
}

#[unsafe(no_mangle)]
pub extern "C" fn sysroot_read_file_name(vfs_shell_name_ptr: i32, name_len: i32) {
    let mut local_buf = vec![0u8; name_len as usize];
    crate::vfs::host::bridge::Downloader::sysroot_read_file_name(local_buf.as_mut_ptr() as i32);
    vfs_shell::memcpy(vfs_shell_name_ptr as *mut u8, local_buf.as_slice());
}

#[unsafe(no_mangle)]
pub extern "C" fn sysroot_read_file_chunk(vfs_shell_data_ptr: i32, chunk_len: i32) {
    let mut local_buf = vec![0u8; chunk_len as usize];
    crate::vfs::host::bridge::Downloader::sysroot_read_file_chunk(
        local_buf.as_mut_ptr() as i32,
        chunk_len,
    );
    vfs_shell::memcpy(vfs_shell_data_ptr as *mut u8, local_buf.as_slice());
}

#[unsafe(no_mangle)]
pub extern "C" fn terminal_write(session_id: u32, vfs_shell_data_ptr: i32, data_len: i32) {
    let data = vfs_shell::get_array(vfs_shell_data_ptr as *const u8, data_len as usize);
    if DEBUG_TERMINAL_CAPTURE.load(Ordering::Relaxed) {
        DEBUG_TERMINAL_OUTPUT.lock().extend_from_slice(&data);
        return;
    }
    crate::vfs::host::bridge::Terminal::terminal_write(session_id, data.as_ptr() as i32, data_len);
}

#[unsafe(no_mangle)]
pub extern "C" fn host_run_cargo(
    req_ptr: i32,
    req_len: i32,
    out_stdout_ptr: i32,
    out_stdout_len: i32,
    out_stderr_ptr: i32,
    out_stderr_len: i32,
    out_status: i32,
) -> i32 {
    let req_data = lsp_opt::get_array(req_ptr as *const u8, req_len as usize);
    let request: serde_json::Value = match serde_json::from_slice(&req_data) {
        Ok(request) => request,
        Err(error) => {
            let stderr = format!("invalid cargo request: {error}");
            write_cargo_result(
                Vec::new(),
                stderr.into_bytes(),
                1,
                out_stdout_ptr,
                out_stdout_len,
                out_stderr_ptr,
                out_stderr_len,
                out_status,
            );
            return 0;
        }
    };

    let Some(args) = request.get("args").and_then(serde_json::Value::as_array) else {
        write_cargo_result(
            Vec::new(),
            b"cargo request is missing args".to_vec(),
            1,
            out_stdout_ptr,
            out_stdout_len,
            out_stderr_ptr,
            out_stderr_len,
            out_status,
        );
        return 0;
    };
    let args = args
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();

    let _run_guard = CARGO_RUN_LOCK.lock();
    let old_env = {
        let mut env = VIRTUAL_SHELL_ENV.lock();
        let old = env.env.clone();
        if let Some(envs) = request.get("envs").and_then(serde_json::Value::as_object) {
            for (key, value) in envs {
                let Some(value) = value.as_str() else {
                    continue;
                };
                env.env
                    .retain(|entry| !entry.starts_with(&format!("{key}=")));
                env.env.push(format!("{key}={value}"));
            }
        }
        old
    };
    let old_cwd = std::env::current_dir().ok();
    if let Some(cwd) = request.get("cwd").and_then(serde_json::Value::as_str) {
        if let Err(error) = std::env::set_current_dir(cwd) {
            VIRTUAL_SHELL_ENV.lock().env = old_env;
            write_cargo_result(
                Vec::new(),
                format!("failed to set cwd `{cwd}`: {error}").into_bytes(),
                1,
                out_stdout_ptr,
                out_stdout_len,
                out_stderr_ptr,
                out_stderr_len,
                out_status,
            );
            return 0;
        }
    }

    command::set_cargo_opt_args(&args);
    CARGO_OUTPUT.with(|output| *output.borrow_mut() = Some(CargoOutput::default()));
    run_cargo();
    let output = CARGO_OUTPUT
        .with(|output| output.borrow_mut().take())
        .unwrap_or_default();
    let status = CARGO_EXIT_STATUS.load(Ordering::SeqCst);

    if let Some(old_cwd) = old_cwd {
        let _ = std::env::set_current_dir(old_cwd);
    }
    VIRTUAL_SHELL_ENV.lock().env = old_env;

    write_cargo_result(
        output.stdout,
        output.stderr,
        status,
        out_stdout_ptr,
        out_stdout_len,
        out_stderr_ptr,
        out_stderr_len,
        out_status,
    );
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn host_free_memory(ptr: i32, len: i32) {
    if ptr == 0 || len <= 0 {
        return;
    }
    let slice = std::ptr::slice_from_raw_parts_mut(ptr as *mut u8, len as usize);
    unsafe {
        drop(Box::from_raw(slice));
    }
}

#[allow(clippy::too_many_arguments)]
fn write_cargo_result(
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: i32,
    out_stdout_ptr: i32,
    out_stdout_len: i32,
    out_stderr_ptr: i32,
    out_stderr_len: i32,
    out_status: i32,
) {
    fn into_raw(data: Vec<u8>) -> (i32, i32) {
        if data.is_empty() {
            return (0, 0);
        }
        let data = data.into_boxed_slice();
        let len = data.len() as i32;
        let ptr = Box::into_raw(data) as *mut u8 as i32;
        (ptr, len)
    }

    let (stdout_ptr, stdout_len) = into_raw(stdout);
    let (stderr_ptr, stderr_len) = into_raw(stderr);
    lsp_opt::memcpy(out_stdout_ptr as *mut u8, &stdout_ptr.to_ne_bytes());
    lsp_opt::memcpy(out_stdout_len as *mut u8, &stdout_len.to_ne_bytes());
    lsp_opt::memcpy(out_stderr_ptr as *mut u8, &stderr_ptr.to_ne_bytes());
    lsp_opt::memcpy(out_stderr_len as *mut u8, &stderr_len.to_ne_bytes());
    lsp_opt::memcpy(out_status as *mut u8, &status.to_ne_bytes());
}

#[cfg(test)]
mod cwd_aware_fs_tests {
    use super::*;
    use std::sync::{Arc, Barrier, LazyLock, mpsc};
    use std::time::{Duration, Instant};
    use wasi_virt_layer::memory::{WasmAccessName, WasmAccessRaw};

    macro_rules! direct_memory_wasm {
        ($name:ident, $display_name:literal) => {
            #[derive(Debug)]
            struct $name;

            impl WasmAccessName for $name {
                const NAME: &'static str = $display_name;
            }

            impl WasmAccessRaw for $name {
                fn memcpy_raw(offset: *mut u8, src: *const u8, len: usize) {
                    unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
                }

                fn memcpy_to_raw(offset: *mut u8, src: *const u8, len: usize) {
                    unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
                }

                fn _main_raw() -> wasip1::Errno {
                    wasip1::ERRNO_SUCCESS
                }
                fn _reset_raw() {}
                fn _start_raw() {}

                fn memory_director_raw(ptr: isize) -> isize {
                    ptr
                }
            }
        };
    }

    direct_memory_wasm!(MappedWasm, "same-name");
    direct_memory_wasm!(SameNameWasm, "same-name");
    direct_memory_wasm!(UnmappedWasm, "unmapped");

    static APPEND_IOV_GATE: LazyLock<parking_lot::Mutex<Option<Arc<AppendIovGate>>>> =
        LazyLock::new(|| parking_lot::Mutex::new(None));

    #[derive(Debug)]
    struct AppendIovGate {
        state: parking_lot::Mutex<(usize, bool)>,
        ready: parking_lot::Condvar,
    }

    impl AppendIovGate {
        fn new() -> Self {
            Self {
                state: parking_lot::Mutex::new((0, false)),
                ready: parking_lot::Condvar::new(),
            }
        }

        fn wait(&self) {
            let mut state = self.state.lock();
            if state.1 {
                return;
            }
            state.0 += 1;
            if state.0 == 2 {
                state.1 = true;
                self.ready.notify_all();
                return;
            }

            let deadline = Instant::now() + Duration::from_millis(50);
            while !state.1 {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    state.1 = true;
                    self.ready.notify_all();
                    break;
                };
                self.ready.wait_for(&mut state, remaining);
            }
        }
    }

    #[derive(Debug)]
    struct AppendRaceWasm;

    impl WasmAccessName for AppendRaceWasm {
        const NAME: &'static str = "append-race";
    }

    impl WasmAccessRaw for AppendRaceWasm {
        fn memcpy_raw(offset: *mut u8, src: *const u8, len: usize) {
            unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
        }

        fn memcpy_to_raw(offset: *mut u8, src: *const u8, len: usize) {
            if len == std::mem::size_of::<Ciovec>() {
                let gate = APPEND_IOV_GATE.lock().clone();
                if let Some(gate) = gate {
                    gate.wait();
                }
            }
            unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
        }

        fn _main_raw() -> wasip1::Errno {
            wasip1::ERRNO_SUCCESS
        }
        fn _reset_raw() {}
        fn _start_raw() {}

        fn memory_director_raw(ptr: isize) -> isize {
            ptr
        }
    }

    type TestLfs = StandardDynamicLFS<ShellVirtualStdIO>;
    type TestFs = CwdAwareFileSystem<StandardDynamicFileSystem<TestLfs>>;

    struct Fixture {
        fs: TestFs,
        root_fd: Fd,
        explicit_fd: Fd,
    }

    fn fixture() -> Fixture {
        let lfs = TestLfs::new();
        let root = lfs.add_preopen(".");
        lfs.add_file(root, "shared.txt", b"root".to_vec()).unwrap();
        let cwd = lfs.add_dir(root, "cwd").unwrap();
        lfs.add_file(cwd, "shared.txt", b"cwd-value".to_vec())
            .unwrap();
        let nested_cwd = lfs.add_dir(cwd, "cwd").unwrap();
        lfs.add_file(nested_cwd, "shared.txt", b"nested-cwd".to_vec())
            .unwrap();
        let root_sysroot = lfs.add_dir(root, "sysroot").unwrap();
        lfs.add_file(root_sysroot, "shared.txt", b"root-sysroot".to_vec())
            .unwrap();
        let cwd_sysroot = lfs.add_dir(cwd, "sysroot").unwrap();
        lfs.add_file(cwd_sysroot, "shared.txt", b"cwd-sysroot".to_vec())
            .unwrap();
        lfs.add_dir(cwd, "source").unwrap();
        lfs.add_dir(cwd, "destination").unwrap();
        let explicit = lfs.add_dir(root, "explicit").unwrap();
        lfs.add_file(explicit, "shared.txt", b"explicit-value".to_vec())
            .unwrap();
        lfs.add_file(root, "plain-file", Vec::new()).unwrap();
        lfs.add_symlink(root, "symlink-to-cwd", "cwd").unwrap();

        let inner = StandardDynamicFileSystem::new(lfs);
        let root_fd = inner.add_fd(root, !0, !0);
        let explicit_fd = inner.add_fd(explicit, !0, !0);
        Fixture {
            fs: CwdAwareFileSystem::new(inner, root, root_fd),
            root_fd,
            explicit_fd,
        }
    }

    fn stat_size<Wasm: WasmAccess + WasmAccessName + 'static>(
        fs: &TestFs,
        fd: Fd,
        path: &[u8],
    ) -> u64 {
        let mut stat: wasip1::Filestat = unsafe { std::mem::zeroed() };
        assert_eq!(
            fs.path_filestat_get_raw::<Wasm>(
                fd,
                wasip1::LOOKUPFLAGS_SYMLINK_FOLLOW,
                path.as_ptr(),
                path.len(),
                &mut stat,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        stat.size
    }

    #[test]
    fn fd_write_overwrites_at_the_current_cursor() {
        let fixture = fixture();
        let path = b"cursor-write";
        let mut fd = 0;
        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                wasip1::OFLAGS_CREAT,
                !0,
                !0,
                0,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );

        let initial = b"abcdefgh";
        let initial_iov = Ciovec {
            buf: initial.as_ptr(),
            buf_len: initial.len(),
        };
        let mut nwritten = 0;
        assert_eq!(
            fixture
                .fs
                .fd_write_raw::<MappedWasm>(fd, &initial_iov, 1, &mut nwritten),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(nwritten, initial.len());

        let mut offset = 0;
        assert_eq!(
            fixture
                .fs
                .fd_seek_raw::<MappedWasm>(fd, 2, wasip1::WHENCE_SET, &mut offset),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(offset, 2);
        let patch_iovs = [
            Ciovec {
                buf: b"X".as_ptr(),
                buf_len: 1,
            },
            Ciovec {
                buf: b"Y".as_ptr(),
                buf_len: 1,
            },
        ];
        assert_eq!(
            fixture.fs.fd_write_raw::<MappedWasm>(
                fd,
                patch_iovs.as_ptr(),
                patch_iovs.len(),
                &mut nwritten,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(nwritten, 2);
        assert_eq!(
            fixture.fs.fd_close_raw::<MappedWasm>(fd),
            wasip1::ERRNO_SUCCESS,
        );

        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                0,
                !0,
                !0,
                0,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        let mut bytes = [0; 8];
        let read_iov = Ciovec {
            buf: bytes.as_mut_ptr(),
            buf_len: bytes.len(),
        };
        let mut nread = 0;
        assert_eq!(
            fixture
                .fs
                .fd_read_raw::<MappedWasm>(fd, &read_iov, 1, &mut nread),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(nread, bytes.len());
        assert_eq!(&bytes, b"abXYefgh");
        let inode = *fixture.fs.fd_map.get(&fd).unwrap().inode_id();
        assert_eq!(fixture.fs.lfs.read_file(inode).unwrap(), b"abXYefgh");
    }

    #[test]
    fn fd_write_zero_fills_when_cursor_is_past_eof() {
        let fixture = fixture();
        let path = b"sparse-cursor-write";
        let mut fd = 0;
        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                wasip1::OFLAGS_CREAT,
                !0,
                !0,
                0,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );

        let initial = b"ab";
        let initial_iov = Ciovec {
            buf: initial.as_ptr(),
            buf_len: initial.len(),
        };
        let mut nwritten = 0;
        assert_eq!(
            fixture
                .fs
                .fd_write_raw::<MappedWasm>(fd, &initial_iov, 1, &mut nwritten),
            wasip1::ERRNO_SUCCESS,
        );
        let mut offset = 0;
        assert_eq!(
            fixture
                .fs
                .fd_seek_raw::<MappedWasm>(fd, 5, wasip1::WHENCE_SET, &mut offset),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(offset, 5);
        let patch = b"XY";
        let patch_iov = Ciovec {
            buf: patch.as_ptr(),
            buf_len: patch.len(),
        };
        assert_eq!(
            fixture
                .fs
                .fd_write_raw::<MappedWasm>(fd, &patch_iov, 1, &mut nwritten),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(nwritten, patch.len());
        assert_eq!(
            fixture.fs.fd_close_raw::<MappedWasm>(fd),
            wasip1::ERRNO_SUCCESS,
        );

        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                0,
                !0,
                !0,
                0,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        let mut bytes = [0; 7];
        let read_iov = Ciovec {
            buf: bytes.as_mut_ptr(),
            buf_len: bytes.len(),
        };
        let mut nread = 0;
        assert_eq!(
            fixture
                .fs
                .fd_read_raw::<MappedWasm>(fd, &read_iov, 1, &mut nread),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(nread, bytes.len());
        assert_eq!(&bytes, b"ab\0\0\0XY");
        let inode = *fixture.fs.fd_map.get(&fd).unwrap().inode_id();
        assert_eq!(fixture.fs.lfs.read_file(inode).unwrap(), b"ab\0\0\0XY");
    }

    #[test]
    fn fd_write_appends_when_descriptor_has_append_flag() {
        let fixture = fixture();
        let path = b"append-cursor-write";
        let mut fd = 0;
        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                wasip1::OFLAGS_CREAT,
                !0,
                !0,
                0,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        let initial = b"abc";
        let initial_iov = Ciovec {
            buf: initial.as_ptr(),
            buf_len: initial.len(),
        };
        let mut nwritten = 0;
        assert_eq!(
            fixture
                .fs
                .fd_write_raw::<MappedWasm>(fd, &initial_iov, 1, &mut nwritten),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(
            fixture.fs.fd_close_raw::<MappedWasm>(fd),
            wasip1::ERRNO_SUCCESS,
        );

        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                0,
                !0,
                !0,
                wasip1::FDFLAGS_APPEND,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        let mut offset = 0;
        assert_eq!(
            fixture
                .fs
                .fd_seek_raw::<MappedWasm>(fd, 0, wasip1::WHENCE_SET, &mut offset),
            wasip1::ERRNO_SUCCESS,
        );
        let patch = b"XY";
        let patch_iov = Ciovec {
            buf: patch.as_ptr(),
            buf_len: patch.len(),
        };
        assert_eq!(
            fixture
                .fs
                .fd_write_raw::<MappedWasm>(fd, &patch_iov, 1, &mut nwritten),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(nwritten, patch.len());
        assert_eq!(
            fixture.fs.fd_close_raw::<MappedWasm>(fd),
            wasip1::ERRNO_SUCCESS,
        );

        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                0,
                !0,
                !0,
                0,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        let mut bytes = [0; 5];
        let read_iov = Ciovec {
            buf: bytes.as_mut_ptr(),
            buf_len: bytes.len(),
        };
        let mut nread = 0;
        assert_eq!(
            fixture
                .fs
                .fd_read_raw::<MappedWasm>(fd, &read_iov, 1, &mut nread),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(&bytes, b"abcXY");
        assert_eq!(nread, bytes.len());
        let inode = *fixture.fs.fd_map.get(&fd).unwrap().inode_id();
        assert_eq!(fixture.fs.lfs.read_file(inode).unwrap(), b"abcXY");
    }

    #[test]
    fn fd_write_serializes_append_across_descriptors() {
        const PREFIX: &[u8] = b"base\n";
        const FIRST_RECORD: &[u8] = b"AAAA\n";
        const SECOND_RECORD: &[u8] = b"BBBB\n";
        const WRITE_COUNT: usize = 16;

        let fixture = fixture();
        let path = b"concurrent-append-write";
        let mut fd = 0;
        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                wasip1::OFLAGS_CREAT,
                !0,
                !0,
                0,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        let prefix_iov = Ciovec {
            buf: PREFIX.as_ptr(),
            buf_len: PREFIX.len(),
        };
        let mut nwritten = 0;
        assert_eq!(
            fixture
                .fs
                .fd_write_raw::<MappedWasm>(fd, &prefix_iov, 1, &mut nwritten),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(
            fixture.fs.fd_close_raw::<MappedWasm>(fd),
            wasip1::ERRNO_SUCCESS,
        );

        let mut first_fd = 0;
        let mut second_fd = 0;
        for fd_ret in [&mut first_fd, &mut second_fd] {
            assert_eq!(
                fixture.fs.path_open_raw::<MappedWasm>(
                    fixture.root_fd,
                    0,
                    path.as_ptr(),
                    path.len(),
                    0,
                    !0,
                    !0,
                    wasip1::FDFLAGS_APPEND,
                    fd_ret,
                ),
                wasip1::ERRNO_SUCCESS,
            );
        }

        *APPEND_IOV_GATE.lock() = Some(Arc::new(AppendIovGate::new()));
        let write_barrier = Arc::new(Barrier::new(2));
        std::thread::scope(|scope| {
            let fs = &fixture.fs;
            let first_barrier = Arc::clone(&write_barrier);
            scope.spawn(move || {
                let iov = Ciovec {
                    buf: FIRST_RECORD.as_ptr(),
                    buf_len: FIRST_RECORD.len(),
                };
                for _ in 0..WRITE_COUNT {
                    first_barrier.wait();
                    let mut nwritten = 0;
                    assert_eq!(
                        fs.fd_write_raw::<AppendRaceWasm>(first_fd, &iov, 1, &mut nwritten),
                        wasip1::ERRNO_SUCCESS,
                    );
                    assert_eq!(nwritten, FIRST_RECORD.len());
                }
            });
            let second_barrier = Arc::clone(&write_barrier);
            scope.spawn(move || {
                let iov = Ciovec {
                    buf: SECOND_RECORD.as_ptr(),
                    buf_len: SECOND_RECORD.len(),
                };
                for _ in 0..WRITE_COUNT {
                    second_barrier.wait();
                    let mut nwritten = 0;
                    assert_eq!(
                        fs.fd_write_raw::<AppendRaceWasm>(second_fd, &iov, 1, &mut nwritten),
                        wasip1::ERRNO_SUCCESS,
                    );
                    assert_eq!(nwritten, SECOND_RECORD.len());
                }
            });
        });
        *APPEND_IOV_GATE.lock() = None;

        for fd in [first_fd, second_fd] {
            assert_eq!(
                fixture.fs.fd_close_raw::<MappedWasm>(fd),
                wasip1::ERRNO_SUCCESS,
            );
        }
        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                0,
                !0,
                !0,
                0,
                &mut fd,
            ),
            wasip1::ERRNO_SUCCESS,
        );

        let expected_len = PREFIX.len() + WRITE_COUNT * (FIRST_RECORD.len() + SECOND_RECORD.len());
        let mut bytes = vec![0; expected_len];
        let read_iov = Ciovec {
            buf: bytes.as_mut_ptr(),
            buf_len: bytes.len(),
        };
        let mut nread = 0;
        assert_eq!(
            fixture
                .fs
                .fd_read_raw::<MappedWasm>(fd, &read_iov, 1, &mut nread),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(nread, expected_len);
        assert_eq!(&bytes[..PREFIX.len()], PREFIX);

        let mut first_count = 0;
        let mut second_count = 0;
        for record in bytes[PREFIX.len()..].chunks_exact(FIRST_RECORD.len()) {
            if record == FIRST_RECORD {
                first_count += 1;
            } else if record == SECOND_RECORD {
                second_count += 1;
            } else {
                panic!("unexpected append record: {record:?}");
            }
        }
        assert_eq!(first_count, WRITE_COUNT);
        assert_eq!(second_count, WRITE_COUNT);
        let inode = *fixture.fs.fd_map.get(&fd).unwrap().inode_id();
        assert_eq!(fixture.fs.lfs.read_file(inode).unwrap(), bytes);
    }

    #[test]
    fn routes_only_relative_root_fd_paths_for_the_mapped_target() {
        let fixture = fixture();
        let guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
            .unwrap();
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"),
            9
        );
        assert_eq!(
            stat_size::<UnmappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"),
            4
        );
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"/shared.txt"),
            4
        );
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.explicit_fd, b"shared.txt"),
            14
        );
        drop(guard);
    }

    #[test]
    fn root_path_hint_keeps_stripped_sysroot_path_at_root_with_cwd_collision() {
        let fixture = fixture();
        let _guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", vec![vec!["sysroot".to_string()]])
            .unwrap();
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"sysroot/shared.txt"),
            12
        );
    }

    #[test]
    fn exact_absolute_source_hint_keeps_path_at_root() {
        let fixture = fixture();
        let _guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(
                b"/cwd",
                vec![vec!["cwd".to_string(), "shared.txt".to_string()]],
            )
            .unwrap();
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"cwd/shared.txt"),
            9
        );
    }

    #[test]
    fn plain_relative_path_still_routes_to_cwd_with_root_hints() {
        let fixture = fixture();
        let _guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", vec![vec!["sysroot".to_string()]])
            .unwrap();
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"),
            9
        );
    }

    #[test]
    fn relative_path_starting_with_cwd_name_routes_without_a_hint() {
        let fixture = fixture();
        let _guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
            .unwrap();
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"cwd/shared.txt"),
            10
        );
    }

    #[test]
    fn target_identity_does_not_depend_on_display_name() {
        let fixture = fixture();
        let _guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
            .unwrap();
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"),
            9
        );
        assert_eq!(
            stat_size::<SameNameWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"),
            4
        );
    }

    #[test]
    fn link_and_rename_route_both_directory_path_pairs() {
        let fixture = fixture();
        let _guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
            .unwrap();
        let source = b"shared.txt";
        let link = b"linked.txt";
        assert_eq!(
            fixture.fs.path_link_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                source.as_ptr(),
                source.len(),
                fixture.explicit_fd,
                link.as_ptr(),
                link.len(),
            ),
            wasip1::ERRNO_SUCCESS,
        );
        let renamed = b"source/renamed.txt";
        assert_eq!(
            fixture.fs.path_rename_raw::<MappedWasm>(
                fixture.explicit_fd,
                link.as_ptr(),
                link.len(),
                fixture.root_fd,
                renamed.as_ptr(),
                renamed.len(),
            ),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, renamed),
            9
        );
    }

    #[test]
    fn rejects_invalid_cwd_without_allocating_an_fd() {
        for cwd in [
            b"/missing".as_slice(),
            b"/plain-file",
            b"/../escape",
            b"/symlink-to-cwd",
            &[0xff],
        ] {
            let fixture = fixture();
            let next_fd = fixture.fs.next_fd.load(Ordering::SeqCst);
            let fd_count = fixture.fs.fd_map.len();
            assert!(
                fixture
                    .fs
                    .enter_target_cwd::<MappedWasm>(cwd, Vec::new())
                    .is_err()
            );
            assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), next_fd);
            assert_eq!(fixture.fs.fd_map.len(), fd_count);
        }
    }

    #[test]
    fn empty_cwd_is_a_no_op_that_preserves_root_routing() {
        let fixture = fixture();
        let initial_next = fixture.fs.next_fd.load(Ordering::SeqCst);
        let initial_count = fixture.fs.fd_map.len();

        let guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"", Vec::new())
            .unwrap();

        assert!(guard.target_id.is_none());
        assert!(guard.cwd_fd.is_none());
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), initial_next);
        assert_eq!(fixture.fs.fd_map.len(), initial_count);
        assert!(
            !fixture
                .fs
                .target_cwds
                .read()
                .contains_key(&TypeId::of::<MappedWasm>())
        );
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"),
            4
        );

        drop(guard);
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), initial_next);
        assert_eq!(fixture.fs.fd_map.len(), initial_count);
    }

    #[test]
    fn root_duplicate_drop_and_protected_descriptors_preserve_ownership() {
        let fixture = fixture();
        let initial_next = fixture.fs.next_fd.load(Ordering::SeqCst);
        let initial_count = fixture.fs.fd_map.len();
        drop(
            fixture
                .fs
                .enter_target_cwd::<MappedWasm>(b"/", Vec::new())
                .unwrap(),
        );
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), initial_next);
        assert_eq!(fixture.fs.fd_map.len(), initial_count);

        let guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
            .unwrap();
        let cwd_fd = fixture.fs.target_cwds.read()[&TypeId::of::<MappedWasm>()].cwd_fd;
        let next_after_first = fixture.fs.next_fd.load(Ordering::SeqCst);
        let count_after_first = fixture.fs.fd_map.len();
        assert!(
            fixture
                .fs
                .enter_target_cwd::<MappedWasm>(b"/", Vec::new())
                .is_err()
        );
        assert!(
            fixture
                .fs
                .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
                .is_err()
        );
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), next_after_first);
        assert_eq!(fixture.fs.fd_map.len(), count_after_first);
        for fd in [fixture.root_fd, cwd_fd] {
            assert_eq!(
                fixture.fs.fd_close_raw::<MappedWasm>(fd),
                wasip1::ERRNO_NOTCAPABLE
            );
            assert_eq!(
                fixture.fs.fd_renumber_raw::<MappedWasm>(fd, 100),
                wasip1::ERRNO_NOTCAPABLE
            );
            assert_eq!(
                fixture.fs.fd_renumber_raw::<MappedWasm>(100, fd),
                wasip1::ERRNO_NOTCAPABLE
            );
            assert!(fixture.fs.fd_map.contains_key(&fd));
        }
        drop(guard);
        assert!(!fixture.fs.fd_map.contains_key(&cwd_fd));
        assert_eq!(
            stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"),
            4
        );
    }

    #[test]
    fn unprotected_descriptors_can_be_closed() {
        let fixture = fixture();
        let inode = fixture
            .fs
            .lfs
            .add_dir(fixture.fs.root_inode, "closable")
            .unwrap();
        let fd = fixture.fs.add_fd(inode, !0, !0);
        assert_eq!(
            fixture.fs.fd_close_raw::<MappedWasm>(fd),
            wasip1::ERRNO_SUCCESS
        );
        assert!(!fixture.fs.fd_map.contains_key(&fd));
    }

    #[test]
    fn renumber_onto_next_fd_leaves_allocation_to_skip_the_destination() {
        let fixture = fixture();
        let destination = fixture.fs.next_fd.load(Ordering::SeqCst);
        assert_eq!(
            fixture
                .fs
                .fd_renumber_raw::<MappedWasm>(fixture.explicit_fd, destination),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), destination);
        let guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
            .unwrap();
        let cwd_fd = fixture.fs.target_cwds.read()[&TypeId::of::<MappedWasm>()].cwd_fd;
        assert_eq!(cwd_fd, destination + 1);
        assert!(fixture.fs.fd_map.contains_key(&destination));
        assert!(fixture.fs.fd_map.contains_key(&cwd_fd));
        drop(guard);
    }

    #[test]
    fn renumber_near_max_does_not_exhaust_low_fd_allocation() {
        let fixture = fixture();
        let initial_next = fixture.fs.next_fd.load(Ordering::SeqCst);
        let destination = u32::MAX - 1;
        assert_eq!(
            fixture
                .fs
                .fd_renumber_raw::<MappedWasm>(fixture.explicit_fd, destination),
            wasip1::ERRNO_SUCCESS,
        );
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), initial_next);
        assert!(fixture.fs.fd_map.contains_key(&destination));

        let guard = fixture
            .fs
            .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
            .unwrap();
        let cwd_fd = fixture.fs.target_cwds.read()[&TypeId::of::<MappedWasm>()].cwd_fd;
        assert_eq!(cwd_fd, initial_next);

        let path = b"new-file";
        let mut opened = 0;
        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                wasip1::OFLAGS_CREAT,
                !0,
                !0,
                0,
                &mut opened,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        assert!(opened < destination);
        assert!(fixture.fs.fd_map.contains_key(&destination));
        drop(guard);
    }

    #[test]
    fn descriptor_exhaustion_never_wraps_the_allocator() {
        let fixture = fixture();
        assert_eq!(
            fixture
                .fs
                .fd_renumber_raw::<MappedWasm>(fixture.explicit_fd, u32::MAX),
            wasip1::ERRNO_MFILE,
        );
        assert!(fixture.fs.fd_map.contains_key(&fixture.explicit_fd));

        fixture.fs.next_fd.store(u32::MAX, Ordering::SeqCst);
        assert!(
            fixture
                .fs
                .enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new())
                .is_err()
        );
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), u32::MAX);

        let path = b"new-file";
        let mut opened = 0;
        assert_eq!(
            fixture.fs.path_open_raw::<MappedWasm>(
                fixture.root_fd,
                0,
                path.as_ptr(),
                path.len(),
                wasip1::OFLAGS_CREAT,
                !0,
                !0,
                0,
                &mut opened,
            ),
            wasip1::ERRNO_MFILE,
        );
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), u32::MAX);
    }

    type RouteBlock = (mpsc::Sender<()>, mpsc::Receiver<()>);
    static ROUTE_BLOCK: LazyLock<parking_lot::Mutex<Option<RouteBlock>>> =
        LazyLock::new(|| parking_lot::Mutex::new(None));

    #[derive(Debug)]
    struct BlockingWasm;

    impl WasmAccessName for BlockingWasm {
        const NAME: &'static str = "blocking";
    }

    impl WasmAccessRaw for BlockingWasm {
        fn memcpy_raw(offset: *mut u8, src: *const u8, len: usize) {
            unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
        }

        fn memcpy_to_raw(offset: *mut u8, src: *const u8, len: usize) {
            let block = ROUTE_BLOCK.lock().take();
            if let Some((entered, release)) = block {
                entered.send(()).unwrap();
                release.recv().unwrap();
            }
            unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
        }

        fn _main_raw() -> wasip1::Errno {
            wasip1::ERRNO_SUCCESS
        }
        fn _reset_raw() {}
        fn _start_raw() {}
        fn memory_director_raw(ptr: isize) -> isize {
            ptr
        }
    }

    #[test]
    fn routed_call_holds_lock_until_inner_dispatch_finishes() {
        let fixture = fixture();
        let guard = fixture
            .fs
            .enter_target_cwd::<BlockingWasm>(b"/cwd", Vec::new())
            .unwrap();
        let cwd_fd = fixture.fs.target_cwds.read()[&TypeId::of::<BlockingWasm>()].cwd_fd;
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *ROUTE_BLOCK.lock() = Some((entered_tx, release_rx));

        let (path_tx, path_rx) = mpsc::channel();
        let (drop_started_tx, drop_started_rx) = mpsc::channel();
        let (drop_finished_tx, drop_finished_rx) = mpsc::channel();
        let mut write_was_available = false;
        let mut drop_finished_early = false;

        std::thread::scope(|scope| {
            scope.spawn(|| {
                let path = b"shared.txt";
                let mut stat: wasip1::Filestat = unsafe { std::mem::zeroed() };
                let errno = fixture.fs.path_filestat_get_raw::<BlockingWasm>(
                    fixture.root_fd,
                    wasip1::LOOKUPFLAGS_SYMLINK_FOLLOW,
                    path.as_ptr(),
                    path.len(),
                    &mut stat,
                );
                path_tx.send(errno).unwrap();
            });

            if let Err(error) = entered_rx.recv_timeout(Duration::from_secs(1)) {
                let _ = release_tx.send(());
                panic!("routed call did not inspect the path: {error}");
            }
            write_was_available = fixture.fs.target_cwds.try_write().is_some();
            scope.spawn(move || {
                drop_started_tx.send(()).unwrap();
                drop(guard);
                drop_finished_tx.send(()).unwrap();
            });
            let drop_started = drop_started_rx.recv_timeout(Duration::from_secs(1));
            if drop_started.is_ok() {
                drop_finished_early = drop_finished_rx
                    .recv_timeout(Duration::from_millis(50))
                    .is_ok();
            }
            let release_result = release_tx.send(());
            let path_result = path_rx.recv_timeout(Duration::from_secs(1));
            let drop_finished = if drop_started.is_ok() && !drop_finished_early {
                Some(drop_finished_rx.recv_timeout(Duration::from_secs(1)))
            } else {
                None
            };

            assert!(drop_started.is_ok());
            assert!(release_result.is_ok());
            assert_eq!(path_result.unwrap(), wasip1::ERRNO_SUCCESS);
            assert!(drop_finished.is_some_and(|result| result.is_ok()));
        });

        assert!(!write_was_available);
        assert!(!drop_finished_early);
        assert!(!fixture.fs.fd_map.contains_key(&cwd_fd));
    }
}

#[cfg(test)]
mod invocation_state_tests {
    use super::*;

    struct ChildProcessStdioReset {
        previous: Option<ChildProcessStdio>,
    }

    impl ChildProcessStdioReset {
        fn install(current: Option<ChildProcessStdio>) -> Self {
            let previous = std::mem::replace(&mut *CHILD_PROCESS_STDIO.lock(), current);
            Self { previous }
        }
    }

    impl Drop for ChildProcessStdioReset {
        fn drop(&mut self) {
            *CHILD_PROCESS_STDIO.lock() = self.previous.take();
        }
    }

    fn install_sentinel_invocation_state(
        env: Vec<String>,
        args: Vec<String>,
        stdout: Vec<u8>,
    ) -> RustcInvocationState {
        let state = RustcInvocationState::new(env, args);
        CARGO_OUTPUT.with(|output| {
            let mut output = output.borrow_mut();
            let output = output.as_mut().unwrap();
            output.stdout = stdout;
            output.stderr = b"outer-error".to_vec();
        });
        state
    }

    #[test]
    fn rustc_argv_root_path_hints_cover_supported_forms() {
        let argv = [
            "rustc",
            "/cwd/src/lib.rs",
            "--sysroot",
            "/sysroot",
            "--out-dir",
            "/target/out",
            "-Ldependency=/target/deps",
            "--extern=name=/target/deps/libname.rlib",
            "--emit=dep-info=/target/emit/name.d,link=/target/emit/name.wasm",
            "--emit",
            "asm=/target/emit/separate.s,llvm-ir=/target/emit/separate.ll",
            "@/response.rsp",
            "/sysroot",
            "/a/../normalized",
            "/../escape",
            "--extern=relative=target/deps/relative.rlib",
        ]
        .map(str::to_string);

        assert_eq!(
            rustc_root_path_hints(&argv),
            vec![
                vec!["cwd", "src", "lib.rs"],
                vec!["sysroot"],
                vec!["target", "out"],
                vec!["target", "deps"],
                vec!["target", "deps", "libname.rlib"],
                vec!["target", "emit", "name.d"],
                vec!["target", "emit", "name.wasm"],
                vec!["target", "emit", "separate.s"],
                vec!["target", "emit", "separate.ll"],
                vec!["response.rsp"],
                vec!["normalized"],
            ]
            .into_iter()
            .map(|components| components.into_iter().map(str::to_string).collect())
            .collect::<Vec<Vec<String>>>(),
        );
    }

    #[test]
    fn invocation_state_cwd_error_is_bounded_without_mutating_state() {
        let _rustc_lock = RUSTC_RUN_LOCK.lock();
        let sentinel_env = vec!["SENTINEL_ENV=1".to_string()];
        let sentinel_args = vec!["sentinel-rustc".to_string()];
        let sentinel_stdout = b"outer-output".to_vec();
        let sentinel_cwd = b"/outer".to_vec();

        let _outer_state = install_sentinel_invocation_state(
            sentinel_env.clone(),
            sentinel_args.clone(),
            sentinel_stdout.clone(),
        );
        let _outer_child = ChildProcessStdioReset::install(Some(ChildProcessStdio::new(
            sentinel_cwd.clone(),
            Vec::new(),
        )));

        let stderr = bounded_rustc_cwd_error(&sentinel_cwd, &"x".repeat(MAX_CHILD_ERROR_BYTES));

        assert_eq!(RUSTC_CWD_ERROR_STATUS, 1);
        assert_eq!(stderr.len(), MAX_CHILD_ERROR_BYTES);
        assert_eq!(VIRTUAL_SHELL_ENV.lock().env, sentinel_env);
        assert_eq!(command::VIRTUAL_ARGS.lock().args, sentinel_args);
        CARGO_OUTPUT.with(|output| {
            assert_eq!(output.borrow().as_ref().unwrap().stdout, sentinel_stdout);
        });
        assert_eq!(
            CHILD_PROCESS_STDIO.lock().as_ref().unwrap().cwd,
            sentinel_cwd
        );
    }

    #[test]
    fn invocation_state_panic_error_is_bounded_with_status_101() {
        let stderr = bounded_rustc_panic_error(&"x".repeat(MAX_CHILD_ERROR_BYTES * 2));

        assert_eq!(RUSTC_PANIC_STATUS, 101);
        assert_eq!(stderr.len(), MAX_CHILD_ERROR_BYTES);
        assert!(stderr.starts_with(b"embedded rustc panicked: "));
    }

    #[test]
    fn invocation_state_success_preserves_output_and_status() {
        let _rustc_lock = RUSTC_RUN_LOCK.lock();
        let _outer_child = ChildProcessStdioReset::install(None);
        let previous_status = RUSTC_EXIT_STATUS.swap(17, Ordering::SeqCst);

        let (output, status) = run_rustc_invocation(
            vec!["INNER_ENV=1".to_string()],
            vec!["inner-rustc".to_string()],
            b"/inner".to_vec(),
            b"inner-input".to_vec(),
            || {
                let mut child = CHILD_PROCESS_STDIO.lock();
                let child = child
                    .as_mut()
                    .expect("replacement child stdio is installed");
                child.stdout.write(b"inner-output");
                child.stderr.write(b"inner-error");
            },
        );
        RUSTC_EXIT_STATUS.store(previous_status, Ordering::SeqCst);

        assert_eq!(status, 17);
        assert_eq!(output.stdout, b"inner-output");
        assert_eq!(output.stderr, b"inner-error");
        assert!(CHILD_PROCESS_STDIO.lock().is_none());
    }

    #[test]
    fn invocation_state_unwind_restores_previous_child_stdio() {
        let _rustc_lock = RUSTC_RUN_LOCK.lock();
        let sentinel_env = vec!["SENTINEL_ENV=1".to_string()];
        let sentinel_args = vec!["sentinel-rustc".to_string()];
        let sentinel_stdout = b"outer-output".to_vec();
        let sentinel_cwd = b"/outer".to_vec();
        let child_stdout = b"child-output".to_vec();

        let _outer_state = install_sentinel_invocation_state(
            sentinel_env.clone(),
            sentinel_args.clone(),
            sentinel_stdout.clone(),
        );
        let mut sentinel_child =
            ChildProcessStdio::new(sentinel_cwd.clone(), b"outer-input".to_vec());
        sentinel_child.stdout.write(&child_stdout);
        sentinel_child.stderr.write(b"child-error");
        let _outer_child = ChildProcessStdioReset::install(Some(sentinel_child));

        let replacement_seen = Cell::new(false);
        let (panic_output, status) = run_rustc_invocation(
            vec!["INNER_ENV=1".to_string()],
            vec!["inner-rustc".to_string()],
            b"/inner".to_vec(),
            b"inner-input".to_vec(),
            || {
                assert_eq!(VIRTUAL_SHELL_ENV.lock().env, ["INNER_ENV=1"]);
                assert_eq!(command::VIRTUAL_ARGS.lock().args, ["inner-rustc"]);
                CARGO_OUTPUT.with(|output| {
                    assert!(output.borrow().as_ref().unwrap().stdout.is_empty());
                });
                let child = CHILD_PROCESS_STDIO.lock();
                let child = child
                    .as_ref()
                    .expect("replacement child stdio is installed");
                assert_eq!(child.cwd, b"/inner");
                assert_eq!(
                    child.stdin.buffer.iter().copied().collect::<Vec<_>>(),
                    b"inner-input"
                );
                replacement_seen.set(true);
                panic!("rustc invocation failed");
            },
        );

        assert!(replacement_seen.get());
        assert_eq!(status, RUSTC_PANIC_STATUS);
        assert!(panic_output.stdout.is_empty());
        assert_eq!(
            panic_output.stderr,
            b"embedded rustc panicked: rustc invocation failed"
        );
        assert_eq!(VIRTUAL_SHELL_ENV.lock().env, sentinel_env);
        assert_eq!(command::VIRTUAL_ARGS.lock().args, sentinel_args);
        CARGO_OUTPUT.with(|output| {
            assert_eq!(output.borrow().as_ref().unwrap().stdout, sentinel_stdout);
        });
        let restored_child = CHILD_PROCESS_STDIO.lock();
        let restored_child = restored_child.as_ref().unwrap();
        assert_eq!(restored_child.owner, std::thread::current().id());
        assert_eq!(restored_child.cwd, sentinel_cwd);
        assert_eq!(
            restored_child
                .stdin
                .buffer
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"outer-input"
        );
        assert!(restored_child.stdin.write_closed);
        assert_eq!(
            restored_child
                .stdout
                .buffer
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            child_stdout
        );
        assert_eq!(
            restored_child
                .stderr
                .buffer
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"child-error"
        );
    }

    #[test]
    fn invocation_state_unwind_restores_absent_child_stdio() {
        let _rustc_lock = RUSTC_RUN_LOCK.lock();
        let sentinel_env = vec!["SENTINEL_ENV=1".to_string()];
        let sentinel_args = vec!["sentinel-rustc".to_string()];
        let sentinel_stdout = b"outer-output".to_vec();
        let sentinel_cwd = b"/outer".to_vec();

        let _outer_state = install_sentinel_invocation_state(
            sentinel_env.clone(),
            sentinel_args.clone(),
            sentinel_stdout.clone(),
        );
        let _outer_child = ChildProcessStdioReset::install(None);

        let replacement_seen = Cell::new(false);
        let (panic_output, status) = run_rustc_invocation(
            vec!["INNER_ENV=1".to_string()],
            vec!["inner-rustc".to_string()],
            sentinel_cwd.clone(),
            b"inner-input".to_vec(),
            || {
                let child = CHILD_PROCESS_STDIO.lock();
                let child = child
                    .as_ref()
                    .expect("replacement child stdio is installed");
                assert_eq!(child.cwd, sentinel_cwd);
                assert_eq!(
                    child.stdin.buffer.iter().copied().collect::<Vec<_>>(),
                    b"inner-input"
                );
                replacement_seen.set(true);
                panic!("rustc invocation failed without prior child stdio");
            },
        );

        assert!(replacement_seen.get());
        assert_eq!(status, RUSTC_PANIC_STATUS);
        assert!(panic_output.stdout.is_empty());
        assert_eq!(
            panic_output.stderr,
            b"embedded rustc panicked: rustc invocation failed without prior child stdio"
        );
        assert_eq!(VIRTUAL_SHELL_ENV.lock().env, sentinel_env);
        assert_eq!(command::VIRTUAL_ARGS.lock().args, sentinel_args);
        CARGO_OUTPUT.with(|output| {
            assert_eq!(output.borrow().as_ref().unwrap().stdout, sentinel_stdout);
        });
        assert!(CHILD_PROCESS_STDIO.lock().is_none());
    }
}

#[cfg(test)]
mod http_tests {
    use super::{
        CHILD_STATE_COMPLETED, CHILD_STATE_RUNNING, CHILD_STATE_UPLOADING, DEBUG_TERMINAL_OUTPUT,
        Guest, MAX_CHILD_ERROR_BYTES, MAX_CHILD_MODULE_BYTES, RequestGuard, Wit,
        allocate_cargo_owned, bounded_child_result, checked_child_module_size,
        decode_cargo_spawn_list, finish_child_request, format_http_response,
        recover_child_process_with, resolve_child_program, should_import_recovered_child,
    };
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn cargo_owned_allocation_can_be_reconstructed_and_dropped() {
        for (expected, size) in [(Vec::new(), 0), (vec![11, 22, 33, 44], 4)] {
            let ptr = allocate_cargo_owned(size);
            assert!(!ptr.is_null());

            unsafe {
                std::ptr::copy_nonoverlapping(expected.as_ptr(), ptr, size);
                let actual = Vec::from_raw_parts(ptr, size, size);
                assert_eq!(actual, expected);
            }
        }
    }

    #[test]
    fn response_wire_format_keeps_status_line_and_binary_body() {
        let response = format_http_response(
            206,
            b"content-type: application/octet-stream\nx-test: yes\n",
            &[0, 255, 17, 128],
        )
        .expect("response should fit in memory");

        assert_eq!(
            response,
            b"206\ncontent-type: application/octet-stream\nx-test: yes\n\n\x00\xff\x11\x80"
        );
    }

    #[test]
    fn virtual_shell_home_is_absolute() {
        let home = super::VIRTUAL_SHELL_ENV
            .lock()
            .env
            .iter()
            .find_map(|value| value.strip_prefix("HOME="))
            .expect("virtual shell HOME should be set")
            .to_string();

        assert!(std::path::Path::new(&home).is_absolute(), "HOME={home}");
    }

    #[test]
    fn cargo_spawn_lists_reject_empty_entries_before_host_encoding() {
        assert_eq!(
            decode_cargo_spawn_list(b"first\0second\0").unwrap(),
            ["first", "second"]
        );
        assert_eq!(decode_cargo_spawn_list(b"").unwrap(), Vec::<String>::new());
        assert!(decode_cargo_spawn_list(b"first\0\0second\0").is_err());
        assert!(decode_cargo_spawn_list(b"\0").is_err());
        assert!(decode_cargo_spawn_list(&[0xff, 0]).is_err());
    }

    #[test]
    fn terminal_capture_polling_does_not_block_while_output_is_locked() {
        let guard = DEBUG_TERMINAL_OUTPUT.lock();
        let (tx, rx) = mpsc::channel();
        let len_thread = std::thread::spawn(move || {
            tx.send(<Wit as Guest>::debug_terminal_output_len())
                .unwrap();
        });
        let len_result = rx.recv_timeout(Duration::from_millis(50));
        drop(guard);
        len_thread.join().unwrap();
        assert_eq!(len_result.unwrap(), 0);

        let guard = DEBUG_TERMINAL_OUTPUT.lock();
        let (tx, rx) = mpsc::channel();
        let read_thread = std::thread::spawn(move || {
            tx.send(<Wit as Guest>::debug_read_terminal_output(0, 0))
                .unwrap();
        });
        let read_result = rx.recv_timeout(Duration::from_millis(50));
        drop(guard);
        read_thread.join().unwrap();
        assert_eq!(read_result.unwrap(), 0);
    }

    #[test]
    fn child_program_is_resolved_relative_to_cargo_cwd() {
        assert_eq!(
            resolve_child_program("target/app.wasm", b"/workspace/project").unwrap(),
            std::path::PathBuf::from("workspace/project/target/app.wasm"),
        );
        assert_eq!(
            resolve_child_program("/absolute/app.wasm", b"/workspace").unwrap(),
            std::path::PathBuf::from("absolute/app.wasm"),
        );
        assert_eq!(
            resolve_child_program("../app.wasm", b"/workspace/project").unwrap(),
            std::path::PathBuf::from("workspace/app.wasm"),
        );
    }

    #[test]
    fn child_module_size_is_rejected_before_allocation() {
        assert_eq!(
            checked_child_module_size(MAX_CHILD_MODULE_BYTES as u64).unwrap(),
            MAX_CHILD_MODULE_BYTES,
        );
        assert!(checked_child_module_size((MAX_CHILD_MODULE_BYTES + 1) as u64).is_err());
        assert!(checked_child_module_size(u64::MAX).is_err());
    }

    #[test]
    fn recovery_reimports_host_after_completion_or_rollback() {
        assert!(should_import_recovered_child(CHILD_STATE_UPLOADING));
        assert!(should_import_recovered_child(CHILD_STATE_RUNNING));
        assert!(should_import_recovered_child(CHILD_STATE_COMPLETED));
        assert!(!should_import_recovered_child(0));
        assert!(!should_import_recovered_child(4));
    }

    #[test]
    fn graceful_reverse_sync_failure_retains_request_and_bounds_error() {
        let active = Rc::new(Cell::new(true));
        let end_calls = Rc::new(Cell::new(0));
        let active_for_end = Rc::clone(&active);
        let end_calls_for_end = Rc::clone(&end_calls);
        let mut request = RequestGuard::new(41, move |_| {
            end_calls_for_end.set(end_calls_for_end.get() + 1);
            active_for_end.set(false);
            0
        });
        request.retain_on_drop();

        let result = finish_child_request(request, Vec::new(), 7, || {
            Err("reverse sync failed ".repeat(MAX_CHILD_ERROR_BYTES))
        });
        let (stderr, status) = bounded_child_result(result);

        assert_eq!(status, 126);
        assert_eq!(stderr.len(), MAX_CHILD_ERROR_BYTES);
        assert_eq!(end_calls.get(), 0);
        assert!(active.get(), "completed request was acknowledged");
        let start_new_request = || !active.get();
        assert!(
            !start_new_request(),
            "a new request started before reconciliation"
        );
    }

    #[test]
    fn successful_reverse_sync_acknowledges_once_and_reports_conflict() {
        let end_calls = Rc::new(Cell::new(0));
        let end_calls_for_end = Rc::clone(&end_calls);
        let mut request = RequestGuard::new(42, move |_| {
            end_calls_for_end.set(end_calls_for_end.get() + 1);
            0
        });
        request.retain_on_drop();

        let (stderr, status) = finish_child_request(request, b"child stderr\n".to_vec(), 7, || {
            Ok(vec![PathBuf::from("workspace/src/main.rs")])
        })
        .unwrap();

        let stderr = String::from_utf8(stderr).unwrap();
        assert_eq!(status, 7);
        assert!(stderr.contains("workspace/src/main.rs"));
        assert_eq!(end_calls.get(), 1);
    }

    #[test]
    fn conflict_diagnostic_keeps_total_stderr_within_limit() {
        let mut request = RequestGuard::new(43, |_| 0);
        request.retain_on_drop();

        let (stderr, status) =
            finish_child_request(request, vec![b'x'; MAX_CHILD_ERROR_BYTES], 19, || {
                Ok(vec![PathBuf::from("conflicted.txt")])
            })
            .unwrap();

        assert_eq!(status, 19);
        assert_eq!(stderr.len(), MAX_CHILD_ERROR_BYTES);
        assert!(
            String::from_utf8_lossy(&stderr).contains("conflicted.txt"),
            "bounded stderr omitted the conflict diagnostic"
        );
    }

    #[test]
    fn recovery_import_failure_retains_authoritative_request() {
        for state in [
            CHILD_STATE_UPLOADING,
            CHILD_STATE_RUNNING,
            CHILD_STATE_COMPLETED,
        ] {
            let active = Rc::new(Cell::new(true));
            let end_calls = Rc::new(Cell::new(0));
            let active_for_end = Rc::clone(&active);
            let end_calls_for_end = Rc::clone(&end_calls);

            let result = recover_child_process_with(
                || Ok(Some((91, state))),
                || Err("injected authoritative import failure".to_string()),
                move |_| {
                    end_calls_for_end.set(end_calls_for_end.get() + 1);
                    active_for_end.set(false);
                    Ok(())
                },
            );

            assert!(result.is_err());
            assert_eq!(end_calls.get(), 0, "state {state} was acknowledged");
            assert!(active.get(), "state {state} allowed a new request");
            let start_new_request = || !active.get();
            assert!(
                !start_new_request(),
                "state {state} started a new request before recovery"
            );
        }
    }
}
