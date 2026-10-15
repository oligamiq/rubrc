//! C ABI exports — MUST match `include/fs_squashfs.h` exactly. Consumers
//! link `libfs_squashfs.a` and `#include` that header; any signature
//! change here requires the header to change in lockstep.
//!
//! Read-only surface (SquashFS cannot be written in place):
//! - fs_squashfs_mount(device_path) -> *mut fs_squashfs_fs_t
//! - fs_squashfs_mount_with_callbacks(cfg) -> *mut fs_squashfs_fs_t
//! - fs_squashfs_mount_with_fs_core_device(handle) -> *mut fs_squashfs_fs_t
//! - fs_squashfs_umount(fs)
//! - fs_squashfs_get_volume_info(fs, info) -> int
//! - fs_squashfs_stat(fs, path, attr) -> int
//! - fs_squashfs_dir_open(fs, path) / _dir_next(iter) / _dir_close(iter)
//! - fs_squashfs_read_file(fs, path, buf, offset, length) -> int64
//! - fs_squashfs_readlink(fs, path, buf, bufsize) -> int
//! - fs_squashfs_last_error() -> *const c_char
//! - fs_squashfs_last_errno() -> c_int
//!
//! Memory ownership:
//! - `fs_squashfs_fs_t*` owned by the caller; freed via `fs_squashfs_umount`.
//! - `fs_squashfs_dir_iter_t*` owned by the caller; freed via `_dir_close`.
//! - `_dir_next` returns a pointer into the iterator's internal buffer,
//!   valid until the next `_dir_next` / `_dir_close`.
//! - `_last_error` / `_last_errno` read thread-local storage, valid until
//!   the next FFI call on the same thread.

#![allow(non_camel_case_types)]
#![allow(clippy::missing_safety_doc)]

use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use crate::error::{errno, Error};
use crate::fs::Filesystem;
use crate::inode::{FileType, Inode};
use fs_core::callback_device::CallbackDevice;
use fs_core::BlockRead;

// ===========================================================================
// Thread-local last error (message + POSIX errno)
// ===========================================================================

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::new("").unwrap());
    static LAST_ERRNO: RefCell<c_int> = const { RefCell::new(0) };
}

fn set_last_error<E: std::fmt::Display>(e: E) {
    let msg = format!("{e}");
    LAST_ERROR.with(|c| {
        *c.borrow_mut() =
            CString::new(msg).unwrap_or_else(|_| CString::new("unknown error").unwrap());
    });
}

fn set_err_from(err: &Error, context: &str) {
    set_last_error(format!("{context}: {err}"));
    LAST_ERRNO.with(|c| *c.borrow_mut() = err.to_errno());
}

fn set_err_msg(msg: &str, e: c_int) {
    set_last_error(msg);
    LAST_ERRNO.with(|c| *c.borrow_mut() = e);
}

fn clear_last_error() {
    LAST_ERROR.with(|c| *c.borrow_mut() = CString::new("").unwrap());
    LAST_ERRNO.with(|c| *c.borrow_mut() = 0);
}

/// Wrap an FFI body in `catch_unwind`, returning `fail` on panic. Crossing
/// the C ABI while unwinding is UB; this is the non-negotiable catch-net.
fn ffi_guard<T>(fail: T, body: impl FnOnce() -> T + std::panic::UnwindSafe) -> T {
    match std::panic::catch_unwind(body) {
        Ok(v) => v,
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&'static str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic (non-string payload)".to_string());
            set_err_msg(&format!("panic: {msg}"), errno::EIO);
            fail
        }
    }
}

#[no_mangle]
pub extern "C" fn fs_squashfs_last_error() -> *const c_char {
    LAST_ERROR.with(|c| c.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn fs_squashfs_last_errno() -> c_int {
    LAST_ERRNO.with(|c| *c.borrow())
}

unsafe fn cstr_to_str<'a>(p: *const c_char) -> &'a str {
    if p.is_null() {
        return "";
    }
    unsafe { CStr::from_ptr(p) }.to_str().unwrap_or("")
}

// ===========================================================================
// Opaque handles + C structs
// ===========================================================================

pub struct fs_squashfs_fs_t {
    fs: Filesystem,
}

/// File-type enum — matches the `fs_squashfs_file_type_t` C enum.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct fs_squashfs_attr_t {
    pub inode: u32,
    pub mode: u16, // permission bits (no type bits)
    pub uid: u32,
    pub gid: u32,
    pub size: u64,
    pub mtime: u32,
    pub link_count: u32,
    pub file_type: u32, // fs_squashfs_file_type_t
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct fs_squashfs_dirent_t {
    pub inode: u32,
    pub file_type: u8,
    pub name_len: u8,
    pub name: [c_char; 256],
}

#[repr(C)]
pub struct fs_squashfs_volume_info_t {
    pub block_size: u32,
    pub compression_id: u16,
    pub compression_name: [c_char; 16],
    pub inode_count: u32,
    pub fragment_count: u32,
    pub id_count: u16,
    pub bytes_used: u64,
    pub mkfs_time: u32,
    pub version_major: u16,
    pub version_minor: u16,
    pub flags: u16,
}

/// Read callback (read-only mount). Returns 0 on success, non-zero on
/// error; must fully fill `length` bytes.
pub type fs_squashfs_read_fn = Option<
    unsafe extern "C" fn(context: *mut c_void, buf: *mut c_void, offset: u64, length: u64) -> c_int,
>;

#[repr(C)]
pub struct fs_squashfs_blockdev_cfg_t {
    pub read: fs_squashfs_read_fn,
    pub context: *mut c_void,
    pub size_bytes: u64,
    pub block_size: u32,
}

pub struct fs_squashfs_dir_iter_t {
    entries: Vec<fs_squashfs_dirent_t>,
    position: usize,
    current: fs_squashfs_dirent_t,
}

// ===========================================================================
// Helpers
// ===========================================================================

fn fill_attr(out: &mut fs_squashfs_attr_t, fs: &Filesystem, inode: &Inode) {
    out.inode = inode.inode_number;
    out.mode = inode.permissions & 0o7777;
    out.uid = fs.resolve_uid(inode.uid_idx);
    out.gid = fs.resolve_gid(inode.gid_idx);
    out.size = inode.file_size;
    out.mtime = inode.mtime;
    out.link_count = inode.nlink;
    out.file_type = inode.file_type().to_abi() as u32;
}

fn dir_entry_to_abi(e: &crate::dir::DirEntry) -> fs_squashfs_dirent_t {
    let mut name = [0 as c_char; 256];
    let copy = e.name.len().min(255);
    for (i, &b) in e.name[..copy].iter().enumerate() {
        name[i] = b as c_char;
    }
    name[copy] = 0;
    fs_squashfs_dirent_t {
        inode: e.inode_number,
        file_type: FileType::from_type_id(e.type_id).to_abi(),
        name_len: copy as u8,
        name,
    }
}

fn mount_from_device(dev: Arc<dyn BlockRead>, context: &str) -> *mut fs_squashfs_fs_t {
    match Filesystem::open(dev) {
        Ok(fs) => Box::into_raw(Box::new(fs_squashfs_fs_t { fs })),
        Err(e) => {
            set_err_from(&e, context);
            std::ptr::null_mut()
        }
    }
}

// ===========================================================================
// Lifecycle
// ===========================================================================

/// Mount a SquashFS image from a device/image path (direct POSIX I/O).
#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_mount(device_path: *const c_char) -> *mut fs_squashfs_fs_t {
    ffi_guard(
        std::ptr::null_mut(),
        AssertUnwindSafe(|| {
            clear_last_error();
            let path = unsafe { cstr_to_str(device_path) };
            if path.is_empty() {
                set_err_msg("null or empty device_path", errno::EINVAL);
                return std::ptr::null_mut();
            }
            let dev = match fs_core::FileDevice::open(path) {
                Ok(d) => Arc::new(d) as Arc<dyn BlockRead>,
                Err(e) => {
                    set_err_msg(&format!("open {path}: {e}"), errno::EIO);
                    return std::ptr::null_mut();
                }
            };
            mount_from_device(dev, &format!("mount {path}"))
        }),
    )
}

/// Mount via a caller-supplied read callback (sandboxed FSKit path).
#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_mount_with_callbacks(
    cfg: *const fs_squashfs_blockdev_cfg_t,
) -> *mut fs_squashfs_fs_t {
    ffi_guard(
        std::ptr::null_mut(),
        AssertUnwindSafe(|| {
            clear_last_error();
            if cfg.is_null() {
                set_err_msg("null cfg", errno::EINVAL);
                return std::ptr::null_mut();
            }
            let cfg = unsafe { &*cfg };
            let Some(read_fn) = cfg.read else {
                set_err_msg("cfg.read is null", errno::EINVAL);
                return std::ptr::null_mut();
            };
            // Context is passed back verbatim to the callback. We carry it
            // as usize so the closure stays Send+Sync; the host guarantees
            // the pointer outlives the mount (FSKit serialises access).
            let ctx_addr = cfg.context as usize;
            let dev = CallbackDevice {
                size: cfg.size_bytes,
                read: Box::new(move |offset, buf| {
                    let rc = unsafe {
                        read_fn(
                            ctx_addr as *mut c_void,
                            buf.as_mut_ptr() as *mut c_void,
                            offset,
                            buf.len() as u64,
                        )
                    };
                    if rc == 0 {
                        Ok(())
                    } else {
                        Err(std::io::Error::other(format!(
                            "read callback returned {rc}"
                        )))
                    }
                }),
                write: None,
                flush: None,
            };
            mount_from_device(Arc::new(dev) as Arc<dyn BlockRead>, "mount (callback)")
        }),
    )
}

/// Mount via an `FsCoreDevice` handle from a sister crate (e.g. an FSKit
/// extension wraps its block-device resource this way, optionally slicing
/// a partition out of a container image first). The handle's refcount is
/// incremented; the caller still owns + frees its own handle via
/// `fs_core_device_close`.
#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_mount_with_fs_core_device(
    handle: *mut fs_core::ffi::FsCoreDevice,
) -> *mut fs_squashfs_fs_t {
    ffi_guard(
        std::ptr::null_mut(),
        AssertUnwindSafe(|| {
            clear_last_error();
            if handle.is_null() {
                set_err_msg("null fs_core handle", errno::EINVAL);
                return std::ptr::null_mut();
            }
            // Clone the inner Arc<dyn BlockDevice> and upcast to BlockRead —
            // SquashFS is read-only, so the read half of the trait is all we
            // need. Trait upcasting is supported on the pinned toolchain.
            let dev: Arc<dyn fs_core::BlockDevice> = unsafe { (*handle).inner().clone() };
            let read: Arc<dyn BlockRead> = dev;
            mount_from_device(read, "mount via fs_core handle")
        }),
    )
}

/// Unmount + free a filesystem handle. Safe to call with NULL.
#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_umount(fs: *mut fs_squashfs_fs_t) {
    ffi_guard(
        (),
        AssertUnwindSafe(|| {
            if !fs.is_null() {
                drop(unsafe { Box::from_raw(fs) });
            }
        }),
    )
}

// ===========================================================================
// Volume info / stat / readdir / read / readlink
// ===========================================================================

#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_get_volume_info(
    fs: *mut fs_squashfs_fs_t,
    info: *mut fs_squashfs_volume_info_t,
) -> c_int {
    ffi_guard(
        -1,
        AssertUnwindSafe(|| {
            clear_last_error();
            if fs.is_null() || info.is_null() {
                set_err_msg("null fs or info", errno::EINVAL);
                return -1;
            }
            let fs = unsafe { &(*fs).fs };
            let info = unsafe { &mut *info };
            unsafe { std::ptr::write_bytes(info as *mut fs_squashfs_volume_info_t, 0, 1) };

            let sb = &fs.sb;
            info.block_size = sb.block_size;
            info.compression_id = sb.compression_id;
            let cname = fs.compressor().name().as_bytes();
            let n = cname.len().min(15);
            for (i, &b) in cname[..n].iter().enumerate() {
                info.compression_name[i] = b as c_char;
            }
            info.compression_name[n] = 0;
            info.inode_count = sb.inode_count;
            info.fragment_count = sb.fragment_entry_count;
            info.id_count = sb.id_count;
            info.bytes_used = sb.bytes_used;
            info.mkfs_time = sb.modification_time;
            info.version_major = sb.version_major;
            info.version_minor = sb.version_minor;
            info.flags = sb.flags;
            0
        }),
    )
}

#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_stat(
    fs: *mut fs_squashfs_fs_t,
    path: *const c_char,
    attr: *mut fs_squashfs_attr_t,
) -> c_int {
    ffi_guard(
        -1,
        AssertUnwindSafe(|| {
            clear_last_error();
            if fs.is_null() || path.is_null() || attr.is_null() {
                set_err_msg("null fs, path, or attr", errno::EINVAL);
                return -1;
            }
            let fs = unsafe { &(*fs).fs };
            let path = unsafe { cstr_to_str(path) };
            let attr = unsafe { &mut *attr };
            match fs.lookup_path(path) {
                Ok(inode) => {
                    fill_attr(attr, fs, &inode);
                    0
                }
                Err(e) => {
                    set_err_from(&e, &format!("stat {path}"));
                    -1
                }
            }
        }),
    )
}

#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_dir_open(
    fs: *mut fs_squashfs_fs_t,
    path: *const c_char,
) -> *mut fs_squashfs_dir_iter_t {
    ffi_guard(
        std::ptr::null_mut(),
        AssertUnwindSafe(|| {
            clear_last_error();
            if fs.is_null() || path.is_null() {
                set_err_msg("null fs or path", errno::EINVAL);
                return std::ptr::null_mut();
            }
            let fs = unsafe { &(*fs).fs };
            let path = unsafe { cstr_to_str(path) };

            let inode = match fs.lookup_path(path) {
                Ok(i) => i,
                Err(e) => {
                    set_err_from(&e, &format!("dir_open {path}"));
                    return std::ptr::null_mut();
                }
            };
            if !inode.is_dir() {
                set_err_msg(&format!("dir_open {path}: not a directory"), errno::ENOTDIR);
                return std::ptr::null_mut();
            }
            let entries = match fs.read_dir(&inode) {
                Ok(es) => es.iter().map(dir_entry_to_abi).collect(),
                Err(e) => {
                    set_err_from(&e, &format!("read directory {path}"));
                    return std::ptr::null_mut();
                }
            };
            Box::into_raw(Box::new(fs_squashfs_dir_iter_t {
                entries,
                position: 0,
                current: unsafe { std::mem::zeroed() },
            }))
        }),
    )
}

#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_dir_next(
    iter: *mut fs_squashfs_dir_iter_t,
) -> *const fs_squashfs_dirent_t {
    ffi_guard(
        std::ptr::null(),
        AssertUnwindSafe(|| {
            if iter.is_null() {
                return std::ptr::null();
            }
            let iter = unsafe { &mut *iter };
            if iter.position >= iter.entries.len() {
                return std::ptr::null();
            }
            iter.current = iter.entries[iter.position];
            iter.position += 1;
            &iter.current as *const fs_squashfs_dirent_t
        }),
    )
}

#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_dir_close(iter: *mut fs_squashfs_dir_iter_t) {
    ffi_guard(
        (),
        AssertUnwindSafe(|| {
            if !iter.is_null() {
                drop(unsafe { Box::from_raw(iter) });
            }
        }),
    )
}

#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_read_file(
    fs: *mut fs_squashfs_fs_t,
    path: *const c_char,
    buf: *mut c_void,
    offset: u64,
    length: u64,
) -> i64 {
    ffi_guard(
        -1,
        AssertUnwindSafe(|| {
            clear_last_error();
            if fs.is_null() || path.is_null() || buf.is_null() {
                set_err_msg("null fs, path, or buf", errno::EINVAL);
                return -1;
            }
            let fs = unsafe { &(*fs).fs };
            let path = unsafe { cstr_to_str(path) };

            let inode = match fs.lookup_path(path) {
                Ok(i) => i,
                Err(e) => {
                    set_err_from(&e, &format!("read_file {path}"));
                    return -1;
                }
            };
            if !inode.is_regular_file() {
                set_err_msg(
                    &format!("read_file {path}: not a regular file"),
                    errno::EINVAL,
                );
                return -1;
            }
            // Bound `length` against the file size + usize so a caller
            // passing u64::MAX can't fabricate an oversized slice.
            let length = length.min(inode.file_size).min(usize::MAX as u64) as usize;
            let out = unsafe { std::slice::from_raw_parts_mut(buf as *mut u8, length) };
            match fs.read_file(&inode, offset, out) {
                Ok(n) => n as i64,
                Err(e) => {
                    set_err_from(&e, &format!("read_file {path}"));
                    -1
                }
            }
        }),
    )
}

#[no_mangle]
pub unsafe extern "C" fn fs_squashfs_readlink(
    fs: *mut fs_squashfs_fs_t,
    path: *const c_char,
    buf: *mut c_char,
    bufsize: usize,
) -> c_int {
    ffi_guard(
        -1,
        AssertUnwindSafe(|| {
            clear_last_error();
            if fs.is_null() || path.is_null() || buf.is_null() || bufsize == 0 {
                set_err_msg("null fs/path/buf or zero bufsize", errno::EINVAL);
                return -1;
            }
            let fs = unsafe { &(*fs).fs };
            let path = unsafe { cstr_to_str(path) };

            let inode = match fs.lookup_path(path) {
                Ok(i) => i,
                Err(e) => {
                    set_err_from(&e, &format!("readlink {path}"));
                    return -1;
                }
            };
            if !inode.is_symlink() {
                set_err_msg(&format!("readlink {path}: not a symlink"), errno::EINVAL);
                return -1;
            }
            let target = &inode.symlink_target;
            // Need room for the target + a NUL terminator.
            if target.len() + 1 > bufsize {
                set_err_msg("readlink buffer too small", errno::ERANGE);
                return -1;
            }
            let dst = unsafe { std::slice::from_raw_parts_mut(buf as *mut u8, bufsize) };
            dst[..target.len()].copy_from_slice(target);
            dst[target.len()] = 0;
            0
        }),
    )
}
