//! C-ABI smoke tests — invoke the `fs_squashfs_*` functions directly via
//! the rlib.
//!
//! Staticlibs don't re-export unmangled C symbols to integration tests, so
//! instead of `extern "C" { fs_squashfs_mount ... }` we call the public
//! items in `fs_squashfs::capi` directly. This verifies the *logic* behind
//! the exports; the actual ABI symbol surface is verified by downstream
//! consumers linking `libfs_squashfs.a`.
//!
//! Everything here reads the committed `test-disks/squashfs-basic.sqfs`
//! fixture, so the whole file runs under a plain `cargo test` — no
//! squashfs-tools required.

mod common;

use std::ffi::{CStr, CString};

use common::basic_fixture_path;
use fs_squashfs::capi::*;

/// The committed fixture as a NUL-terminated path.
fn fixture_cstr() -> CString {
    CString::new(basic_fixture_path().to_str().unwrap()).unwrap()
}

fn last_err_str() -> String {
    unsafe {
        let p = fs_squashfs_last_error();
        if p.is_null() {
            return "<null>".into();
        }
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

/// Mount the committed fixture or panic with the last error.
fn mount_fixture() -> *mut fs_squashfs_fs_t {
    let path = fixture_cstr();
    let fs = unsafe { fs_squashfs_mount(path.as_ptr()) };
    assert!(!fs.is_null(), "mount returned NULL: {}", last_err_str());
    fs
}

#[test]
fn mount_and_umount_basic_image() {
    let fs = mount_fixture();
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn umount_null_is_safe() {
    // Documented contract: safe to call with NULL.
    unsafe { fs_squashfs_umount(std::ptr::null_mut()) };
}

#[test]
fn mount_rejects_missing_file() {
    let path = CString::new("/tmp/definitely-does-not-exist-sqfs-xyz").unwrap();
    let fs = unsafe { fs_squashfs_mount(path.as_ptr()) };
    assert!(fs.is_null(), "mount should have failed");
    let err = last_err_str();
    assert!(
        err.contains("open") || err.contains("No such") || err.contains("mount"),
        "err was: {err}"
    );
    assert_eq!(fs_squashfs_last_errno(), 5 /* EIO */);
}

#[test]
fn mount_rejects_null_path() {
    let fs = unsafe { fs_squashfs_mount(std::ptr::null()) };
    assert!(fs.is_null());
    assert_eq!(fs_squashfs_last_errno(), 22 /* EINVAL */);
}

#[test]
fn mount_rejects_non_squashfs_bytes() {
    // A real file that isn't a SquashFS image: the crate's own Cargo.toml.
    let path = CString::new(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    let fs = unsafe { fs_squashfs_mount(path.as_ptr()) };
    assert!(fs.is_null(), "mounting a non-squashfs file should fail");
    let err = last_err_str();
    assert!(
        err.contains("SquashFS") || err.contains("magic") || err.contains("superblock"),
        "err was: {err}"
    );
}

#[test]
fn volume_info_reports_expected_fields() {
    let fs = mount_fixture();
    let mut info = unsafe { std::mem::zeroed::<fs_squashfs_volume_info_t>() };
    let rc = unsafe { fs_squashfs_get_volume_info(fs, &mut info) };
    assert_eq!(rc, 0, "get_volume_info failed: {}", last_err_str());

    assert_eq!(info.block_size, 4096, "fixture built with -b 4096");
    assert_eq!(info.compression_id, 1, "gzip");
    assert_eq!(info.version_major, 4);
    assert!(info.inode_count >= 5, "at least 5 inodes");
    assert!(info.bytes_used > 0);
    // compression_name is a NUL-terminated "gzip".
    let name = unsafe { CStr::from_ptr(info.compression_name.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    assert_eq!(name, "gzip", "compression_name");

    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn volume_info_null_args_error_not_crash() {
    let fs = mount_fixture();
    unsafe {
        let rc = fs_squashfs_get_volume_info(std::ptr::null_mut(), std::ptr::null_mut());
        assert_eq!(rc, -1);
        let mut info = std::mem::zeroed::<fs_squashfs_volume_info_t>();
        let rc = fs_squashfs_get_volume_info(std::ptr::null_mut(), &mut info);
        assert_eq!(rc, -1);
        let rc = fs_squashfs_get_volume_info(fs, std::ptr::null_mut());
        assert_eq!(rc, -1);
        fs_squashfs_umount(fs);
    }
}

#[test]
fn stat_root_is_directory() {
    let fs = mount_fixture();
    let root = CString::new("/").unwrap();
    let mut attr = unsafe { std::mem::zeroed::<fs_squashfs_attr_t>() };
    let rc = unsafe { fs_squashfs_stat(fs, root.as_ptr(), &mut attr) };
    assert_eq!(rc, 0, "stat / failed: {}", last_err_str());
    // file_type 2 == DIR in the C ABI.
    assert_eq!(attr.file_type, 2, "root file_type != DIR");
    assert!(attr.link_count >= 2, "dir link_count >= 2");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn stat_regular_file_reports_size() {
    let fs = mount_fixture();
    let p = CString::new("/hello.txt").unwrap();
    let mut attr = unsafe { std::mem::zeroed::<fs_squashfs_attr_t>() };
    let rc = unsafe { fs_squashfs_stat(fs, p.as_ptr(), &mut attr) };
    assert_eq!(rc, 0, "stat /hello.txt failed: {}", last_err_str());
    assert_eq!(attr.file_type, 1, "REG_FILE");
    assert_eq!(attr.size, 3, "\"hi\\n\"");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn stat_empty_file_size_zero() {
    let fs = mount_fixture();
    let p = CString::new("/empty.txt").unwrap();
    let mut attr = unsafe { std::mem::zeroed::<fs_squashfs_attr_t>() };
    let rc = unsafe { fs_squashfs_stat(fs, p.as_ptr(), &mut attr) };
    assert_eq!(rc, 0, "stat /empty.txt failed: {}", last_err_str());
    assert_eq!(attr.file_type, 1, "REG_FILE");
    assert_eq!(attr.size, 0, "empty file");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn stat_symlink_classified_as_symlink() {
    let fs = mount_fixture();
    let p = CString::new("/link").unwrap();
    let mut attr = unsafe { std::mem::zeroed::<fs_squashfs_attr_t>() };
    let rc = unsafe { fs_squashfs_stat(fs, p.as_ptr(), &mut attr) };
    assert_eq!(rc, 0, "stat /link failed: {}", last_err_str());
    assert_eq!(attr.file_type, 7, "SYMLINK");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn stat_missing_path_returns_enoent() {
    let fs = mount_fixture();
    let missing = CString::new("/definitely-not-there-987").unwrap();
    let mut attr = unsafe { std::mem::zeroed::<fs_squashfs_attr_t>() };
    let rc = unsafe { fs_squashfs_stat(fs, missing.as_ptr(), &mut attr) };
    assert_eq!(rc, -1);
    assert_eq!(fs_squashfs_last_errno(), 2 /* ENOENT */);
    assert!(last_err_str().contains("not found") || last_err_str().contains("stat"));
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn stat_null_args_error_not_crash() {
    unsafe {
        let mut attr = std::mem::zeroed::<fs_squashfs_attr_t>();
        let rc = fs_squashfs_stat(std::ptr::null_mut(), std::ptr::null(), &mut attr);
        assert_eq!(rc, -1);
    }
}

#[test]
fn dir_open_root_lists_all_entries() {
    let fs = mount_fixture();
    let root = CString::new("/").unwrap();
    let iter = unsafe { fs_squashfs_dir_open(fs, root.as_ptr()) };
    assert!(!iter.is_null(), "dir_open / failed: {}", last_err_str());

    let mut names = Vec::new();
    loop {
        let de = unsafe { fs_squashfs_dir_next(iter) };
        if de.is_null() {
            break;
        }
        let name_ptr = unsafe { (*de).name.as_ptr() };
        let name = unsafe { CStr::from_ptr(name_ptr).to_string_lossy().into_owned() };
        // name_len must match the C-string length.
        assert_eq!(
            unsafe { (*de).name_len } as usize,
            name.len(),
            "name_len mismatch for {name}"
        );
        names.push(name);
    }
    unsafe { fs_squashfs_dir_close(iter) };

    names.sort();
    assert_eq!(
        names,
        vec!["empty.txt", "hello.txt", "link", "sub"],
        "root listing"
    );
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn dir_next_returns_correct_file_types() {
    let fs = mount_fixture();
    let root = CString::new("/").unwrap();
    let iter = unsafe { fs_squashfs_dir_open(fs, root.as_ptr()) };
    assert!(!iter.is_null());

    let mut by_name = std::collections::BTreeMap::new();
    loop {
        let de = unsafe { fs_squashfs_dir_next(iter) };
        if de.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*de).name.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        by_name.insert(name, unsafe { (*de).file_type });
    }
    unsafe { fs_squashfs_dir_close(iter) };

    assert_eq!(by_name.get("hello.txt"), Some(&1u8), "REG_FILE");
    assert_eq!(by_name.get("sub"), Some(&2u8), "DIR");
    assert_eq!(by_name.get("link"), Some(&7u8), "SYMLINK");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn dir_open_on_file_is_enotdir() {
    let fs = mount_fixture();
    let p = CString::new("/hello.txt").unwrap();
    let iter = unsafe { fs_squashfs_dir_open(fs, p.as_ptr()) };
    assert!(iter.is_null(), "dir_open on a file must fail");
    assert_eq!(fs_squashfs_last_errno(), 20 /* ENOTDIR */);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn dir_open_missing_is_enoent() {
    let fs = mount_fixture();
    let p = CString::new("/no-such-dir").unwrap();
    let iter = unsafe { fs_squashfs_dir_open(fs, p.as_ptr()) };
    assert!(iter.is_null());
    assert_eq!(fs_squashfs_last_errno(), 2 /* ENOENT */);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn dir_next_on_null_iter_returns_null() {
    let de = unsafe { fs_squashfs_dir_next(std::ptr::null_mut()) };
    assert!(de.is_null());
}

#[test]
fn dir_close_null_is_safe() {
    unsafe { fs_squashfs_dir_close(std::ptr::null_mut()) };
}

#[test]
fn dir_open_null_args_error_not_crash() {
    let iter = unsafe { fs_squashfs_dir_open(std::ptr::null_mut(), std::ptr::null()) };
    assert!(iter.is_null());
}

#[test]
fn readlink_returns_target() {
    let fs = mount_fixture();
    let p = CString::new("/link").unwrap();
    let mut buf = [0i8; 256];
    let rc = unsafe { fs_squashfs_readlink(fs, p.as_ptr(), buf.as_mut_ptr(), buf.len()) };
    assert_eq!(rc, 0, "readlink /link failed: {}", last_err_str());
    let target = unsafe { CStr::from_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    assert_eq!(target, "hello.txt");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn readlink_on_regular_file_is_einval() {
    let fs = mount_fixture();
    let p = CString::new("/hello.txt").unwrap();
    let mut buf = [0i8; 256];
    let rc = unsafe { fs_squashfs_readlink(fs, p.as_ptr(), buf.as_mut_ptr(), buf.len()) };
    assert_eq!(rc, -1, "readlink on a file must fail");
    assert_eq!(fs_squashfs_last_errno(), 22 /* EINVAL */);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn readlink_buffer_too_small_is_erange() {
    let fs = mount_fixture();
    let p = CString::new("/link").unwrap();
    // Target is "hello.txt" (9 bytes); 4 bytes can't fit it + NUL.
    let mut buf = [0i8; 4];
    let rc = unsafe { fs_squashfs_readlink(fs, p.as_ptr(), buf.as_mut_ptr(), buf.len()) };
    assert_eq!(rc, -1);
    assert_eq!(fs_squashfs_last_errno(), 34 /* ERANGE */);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn readlink_zero_bufsize_is_einval() {
    let fs = mount_fixture();
    let p = CString::new("/link").unwrap();
    let mut buf = [0i8; 4];
    let rc = unsafe { fs_squashfs_readlink(fs, p.as_ptr(), buf.as_mut_ptr(), 0) };
    assert_eq!(rc, -1);
    assert_eq!(fs_squashfs_last_errno(), 22 /* EINVAL */);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn readlink_null_args_error_not_crash() {
    unsafe {
        let rc = fs_squashfs_readlink(
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        );
        assert_eq!(rc, -1);
    }
}
