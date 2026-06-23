use const_struct::*;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use wasi_virt_layer::{file::*, poll::*, prelude::*, thread::VirtualThreadPool};

pub mod memory_manager;
use memory_manager::*;

wit_bindgen::generate!({
    world: "vfs-host",
});

const LSP_SESSION_ID: u32 = 0xFFFFFFFF;
const EVENT_TYPE_LSP: u32 = 6;
const EVENT_TYPE_WRITE_FILE: u32 = 7;
const EVENT_TYPE_DEBUG_FIXED_RUSTC: u32 = 1007;
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

thread_local! {
    static CARGO_OUTPUT: RefCell<Option<CargoOutput>> = const { RefCell::new(None) };
}

static CARGO_RUN_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
static CARGO_STARTED: AtomicBool = AtomicBool::new(false);
pub(crate) static CARGO_EXIT_STATUS: AtomicI32 = AtomicI32::new(0);
static RUSTC_STARTED: AtomicBool = AtomicBool::new(false);
pub(crate) static RUSTC_EXIT_STATUS: AtomicI32 = AtomicI32::new(0);

pub(crate) fn run_cargo() {
    CARGO_EXIT_STATUS.store(0, Ordering::SeqCst);
    MEMORY_MANAGER.ensure::<cargo_opt>(CARGO_CONFIG);
    if !CARGO_STARTED.swap(true, Ordering::SeqCst) {
        cargo_opt::_start();
    }
    cargo_opt::_main();
}

fn run_rustc() {
    RUSTC_EXIT_STATUS.store(0, Ordering::SeqCst);
    MEMORY_MANAGER.ensure::<rustc_opt>(RUSTC_CONFIG);
    // MEMORY_MANAGER.ensure::<llvm_opt>(LLVM_CONFIG);
    // if RUSTC_STARTED.swap(true, Ordering::SeqCst) {
    //     rustc_opt::_main();
    // } else {
    //     rustc_opt::_start();
    // }
    // rustc_opt::_start();
    // rustc_opt::_main();
    unreachable!("##");
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
            MEMORY_MANAGER.reserve_for_thread();
            THREAD_POOL.set_capacity(i);
            THREAD_POOL.flush_capacity().wait();
        }

        Self::flush_to_vfs();

        println!("Running rustc_opt (1/2)");
        MEMORY_MANAGER.ensure::<rustc_opt>(RUSTC_CONFIG);
        MEMORY_MANAGER.ensure::<llvm_opt>(LLVM_CONFIG);
        let fixed_args: &[&str] = &[
            "rustc",
            "/src/main.rs",
            "--sysroot",
            "/sysroot",
            "--target",
            "wasm32-wasip1",
            "-Clinker-flavor=wasm-ld",
            "-Clinker=wasm-ld",
        ];
        crate::command::set_rustc_opt_args(fixed_args);

        crate::rustc_opt::_reset();
        crate::rustc_opt::_main();

        println!("Running rustc_opt (2/2)");
        crate::rustc_opt::_reset();
        crate::rustc_opt::_main();

        println!("Done!");
    }

    fn flush_to_vfs() {
        let root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);

        fn walk_host(dir: &Path, vfs_parent: usize) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name().unwrap().to_string_lossy().to_string();

                    if path.is_dir() {
                        let vfs_child = VIRTUAL_FILE_SYSTEM
                            .lfs
                            .add_dir(vfs_parent, &name)
                            .unwrap_or(vfs_parent);
                        walk_host(&path, vfs_child);
                    } else if path.is_file() {
                        if let Ok(content) = std::fs::read(&path) {
                            let _ = VIRTUAL_FILE_SYSTEM.lfs.add_file(vfs_parent, &name, content);
                        }
                    }
                }
            }
        }

        walk_host(Path::new("."), root);
    }

    fn flush_from_vfs() {
        let root = LFS_ROOT.load(std::sync::atomic::Ordering::Relaxed);

        fn walk_vfs(vfs_inode: usize, host_path: PathBuf) {
            if let Ok(entries) = VIRTUAL_FILE_SYSTEM.lfs.read_dir(vfs_inode) {
                for (name, child_inode) in entries {
                    if name == "." || name == ".." {
                        continue;
                    }
                    let child_path = host_path.join(&name);

                    // Try to list as directory to check if it is one
                    if VIRTUAL_FILE_SYSTEM.lfs.read_dir(child_inode).is_ok() {
                        let _ = std::fs::create_dir_all(&child_path);
                        walk_vfs(child_inode, child_path);
                    } else {
                        // Treat as file
                        if let Ok(content) = VIRTUAL_FILE_SYSTEM.lfs.read_file(child_inode) {
                            let _ = std::fs::write(&child_path, content);
                        }
                    }
                }
            }
        }

        walk_vfs(root, PathBuf::from("."));
    }

    fn dispatch(session_id: u32, event_type: u32, arg1: u32, arg2: u32) {
        if session_id == LSP_SESSION_ID {
            if LSP_START_ONCE.try_start() {
                MEMORY_MANAGER.reserve_for_thread();
                std::thread::spawn(move || {
                    crate::shell::vfs_set_current_session_id(LSP_SESSION_ID);
                    crate::command::set_lsp_opt_args(&["rust-analyzer"]);
                    MEMORY_MANAGER.ensure::<lsp_opt>(LSP_CONFIG);
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
            debug_trace(&format!("1 debug-rustc:enter run={run_marker}"));
            std::thread::spawn(move || {
                debug_trace(&format!("2 debug-rustc:enter run={run_marker}"));

                crate::debug_trace(&format!("3 debug-rustc:enter run={run_marker}"));
                MEMORY_MANAGER.ensure::<rustc_opt>(RUSTC_CONFIG);
                MEMORY_MANAGER.ensure::<llvm_opt>(LLVM_CONFIG);
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
                crate::command::set_rustc_opt_args(fixed_args);
                crate::debug_trace("debug-rustc:_reset:enter");
                crate::rustc_opt::_reset();
                crate::debug_trace("debug-rustc:_reset:return");
                crate::shell::vfs_set_current_session_id(1);
                crate::debug_trace("debug-rustc:_main:enter");
                crate::rustc_opt::_main();
                crate::debug_trace("debug-rustc:_main:return");
                crate::debug_trace(&format!("debug-rustc:return run={run_marker}"));
            });
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
        DEBUG_TERMINAL_OUTPUT.lock().len() as u32
    }

    fn debug_read_terminal_output(ptr: u32, len: u32) -> u32 {
        let mut output = DEBUG_TERMINAL_OUTPUT.lock();
        let read_len = usize::min(output.len(), len as usize);
        if read_len != 0 {
            let destination = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, read_len) };
            destination.copy_from_slice(&output[..read_len]);
            output.drain(..read_len);
        }
        read_len as u32
    }
}

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

pub static VIRTUAL_SHELL_ENV: std::sync::LazyLock<parking_lot::Mutex<VirtualEnvState>> =
    std::sync::LazyLock::new(|| {
        parking_lot::Mutex::new(VirtualEnvState {
            env: vec![
                "HOME=~/".to_string(),
                // "RUST_SRC_PATH=/sysroot/lib/rustlib".to_string(),
                "SYSROOT=/sysroot".to_string(),
            ],
        })
    });

#[derive(Debug)]
pub struct ShellVirtualStdIO;

impl wasi_virt_layer::wasi::file::stdio::StdIO for ShellVirtualStdIO {
    fn write(buf: &[u8]) -> Result<usize, wasi_virt_layer::__private::wasip1::Errno> {
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

pub mod command;
pub mod process;
pub mod shell;

pub static VIRTUAL_FILE_SYSTEM: std::sync::LazyLock<StandardDynamicFileSystem<LFS>> =
    std::sync::LazyLock::new(|| {
        let lfs = StandardDynamicLFS::new();
        let root_inode = lfs.add_preopen(".");
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
    environ: &["HOME=~/"],
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
plug_sched!(DefaultSched, cargo_opt);

static THREAD_POOL: VirtualThreadPool<ThreadAccessor> = unsafe { VirtualThreadPool::new_const(8) };

plug_thread!(
    { &THREAD_POOL },
    self,
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
    _method_ptr: i32,
    _method_len: i32,
    _url_ptr: i32,
    _url_len: i32,
    _headers_ptr: i32,
    _headers_len: i32,
    _body_ptr: i32,
    _body_len: i32,
    _out_status: i32,
    _out_resp_ptr: i32,
    _out_resp_len: i32,
) -> i32 {
    1
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
    args_ptr: i32,
    args_len: i32,
    env_ptr: i32,
    env_len: i32,
    cwd_ptr: i32,
    cwd_len: i32,
    out_exit_code: i32,
    out_stdout_ptr: i32,
    out_stdout_len: i32,
    out_stderr_ptr: i32,
    out_stderr_len: i32,
) -> i32 {
    let program = cargo_opt::get_array(program_ptr as *const u8, program_len as usize);
    let program = String::from_utf8_lossy(&program).into_owned();
    let args = cargo_opt::get_array(args_ptr as *const u8, args_len as usize);
    let env = cargo_opt::get_array(env_ptr as *const u8, env_len as usize);
    let cwd = cargo_opt::get_array(cwd_ptr as *const u8, cwd_len as usize);

    let mut argv = vec![program.clone()];
    argv.extend(
        args.split(|byte| *byte == 0)
            .filter(|arg| !arg.is_empty())
            .map(|arg| String::from_utf8_lossy(arg).into_owned()),
    );

    let old_env = {
        let mut virtual_env = VIRTUAL_SHELL_ENV.lock();
        let old = virtual_env.env.clone();
        for entry in env
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
        {
            let entry = String::from_utf8_lossy(entry);
            let Some((key, _)) = entry.split_once('=') else {
                continue;
            };
            virtual_env
                .env
                .retain(|current| !current.starts_with(&format!("{key}=")));
            virtual_env.env.push(entry.into_owned());
        }
        old
    };
    let old_cwd = std::env::current_dir().ok();
    if !cwd.is_empty() {
        let _ = std::env::set_current_dir(String::from_utf8_lossy(&cwd).as_ref());
    }

    let outer_output = CARGO_OUTPUT.with(|output| output.borrow_mut().take());
    CARGO_OUTPUT.with(|output| *output.borrow_mut() = Some(CargoOutput::default()));

    let program_name = Path::new(&program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&program);
    let status = if program_name == "rustc" {
        command::set_rustc_opt_args(&argv);
        run_rustc();
        RUSTC_EXIT_STATUS.load(Ordering::SeqCst)
    } else {
        let message = format!("unsupported child process: {program}");
        CARGO_OUTPUT.with(|output| {
            if let Some(output) = output.borrow_mut().as_mut() {
                output.stderr.extend_from_slice(message.as_bytes());
            }
        });
        127
    };

    let child_output = CARGO_OUTPUT
        .with(|output| output.borrow_mut().take())
        .unwrap_or_default();
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
    0
}

#[cfg(target_os = "wasi")]
#[link(wasm_import_module = "wasip1_vfs_cargo_opt")]
unsafe extern "C" {
    fn wasi_ext_allocate(size: usize) -> *mut u8;
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
        if data.is_empty() {
            return (0, 0);
        }
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
        let _ = std::env::set_current_dir(cwd);
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
