use const_struct::*;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
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

fn with_child_process_stdio<T>(
    cwd: Vec<u8>,
    stdin: Vec<u8>,
    f: impl FnOnce() -> T,
) -> (T, CargoOutput) {
    let previous = {
        let mut process = CHILD_PROCESS_STDIO.lock();
        process.replace(ChildProcessStdio::new(cwd, stdin))
    };

    let result = f();

    let mut current = {
        let mut process = CHILD_PROCESS_STDIO.lock();
        let current = process
            .take()
            .unwrap_or_else(|| ChildProcessStdio::new(Vec::new(), Vec::new()));
        *process = previous;
        current
    };

    if !current.cwd.is_empty() {
        debug_trace(&format!(
            "child-process:cwd {}",
            String::from_utf8_lossy(&current.cwd)
        ));
    }

    (
        result,
        CargoOutput {
            stdout: current.stdout.drain(),
            stderr: current.stderr.drain(),
        },
    )
}

fn virtual_cwd_for_set_current_dir(cwd: &[u8]) -> Option<std::borrow::Cow<'_, str>> {
    let cwd = String::from_utf8_lossy(cwd);
    if cwd == "/" {
        None
    } else if let Some(relative) = cwd.strip_prefix('/') {
        Some(std::borrow::Cow::Owned(relative.to_string()))
    } else {
        Some(cwd)
    }
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
pub(crate) static LFS_ROOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn initialized_lfs_root() -> usize {
    std::sync::LazyLock::force(&VIRTUAL_FILE_SYSTEM);
    LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed)
}

pub mod command;
pub mod process;
pub mod shell;

pub static VIRTUAL_FILE_SYSTEM: std::sync::LazyLock<StandardDynamicFileSystem<LFS>> =
    std::sync::LazyLock::new(|| {
        let lfs = StandardDynamicLFS::new();
        let root_inode = lfs.add_preopen(".");
        if let Ok(bin_inode) = lfs.add_dir(root_inode, "bin") {
            let _ = lfs.add_file(bin_inode, "cargo", b"#!/bin/sh\nexit 0\n".to_vec());
        }
        LFS_ROOT.store(root_inode, std::sync::atomic::Ordering::SeqCst);
        let vfs = StandardDynamicFileSystem::new(lfs);
        vfs.add_fd(root_inode, !0, !0);
        vfs
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

    let old_env = {
        let mut virtual_env = VIRTUAL_SHELL_ENV.lock();
        let old = virtual_env.env.clone();
        virtual_env.env = env
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .map(|entry| String::from_utf8_lossy(entry).into_owned())
            .collect();
        old
    };
    if !cwd.is_empty() {
        crate::debug_trace(&format!(
            "wasi-ext-spawn:virtual-cwd {}",
            String::from_utf8_lossy(&cwd)
        ));
    }

    let old_cwd = std::env::current_dir().ok();
    if !cwd.is_empty() {
        let cwd_string = String::from_utf8_lossy(&cwd);
        let set_cwd = virtual_cwd_for_set_current_dir(&cwd);
        if let Some(set_cwd) = set_cwd {
            if let Err(error) = std::env::set_current_dir(set_cwd.as_ref()) {
                VIRTUAL_SHELL_ENV.lock().env = old_env;
                write_cargo_owned_spawn_result(
                    Vec::new(),
                    format!("failed to set cwd `{cwd_string}`: {error}").into_bytes(),
                    1,
                    out_exit_code,
                    out_stdout_ptr,
                    out_stdout_len,
                    out_stderr_ptr,
                    out_stderr_len,
                );
                return 0;
            }
        }
    }

    let outer_output = CARGO_OUTPUT.with(|output| output.borrow_mut().take());
    CARGO_OUTPUT.with(|output| *output.borrow_mut() = Some(CargoOutput::default()));

    crate::debug_trace("wasi-ext-spawn:run-rustc:enter");
    let old_args = command::VIRTUAL_ARGS.lock().args.clone();
    argv.push("--sysroot".to_string());
    argv.push("/sysroot".to_string());
    argv.push("-Clinker-flavor=wasm-ld".to_string());
    argv.push("-Clinker=wasm-ld".to_string());
    command::set_rustc_opt_args(&argv);
    let ((), child_output) = with_child_process_stdio(cwd.to_vec(), stdin, run_rustc);
    command::VIRTUAL_ARGS.lock().args = old_args;
    let status = RUSTC_EXIT_STATUS.load(Ordering::SeqCst);
    crate::debug_trace(&format!("wasi-ext-spawn:run-rustc:return status={status}"));

    let _ = CARGO_OUTPUT.with(|output| output.borrow_mut().take());
    CARGO_OUTPUT.with(|output| *output.borrow_mut() = outer_output);
    if let Some(old_cwd) = old_cwd {
        let _ = std::env::set_current_dir(old_cwd);
    }
    VIRTUAL_SHELL_ENV.lock().env = old_env;

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
const CHILD_STATE_UPLOADING: u32 = 1;
const CHILD_STATE_RUNNING: u32 = 2;
const CHILD_STATE_COMPLETED: u32 = 3;

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
