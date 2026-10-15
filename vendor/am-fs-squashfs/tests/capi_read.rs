//! C-ABI read-path tests — the `fs_squashfs_read_file` surface and the
//! three mount entry points (`fs_squashfs_mount`, `_mount_with_callbacks`,
//! `_mount_with_fs_core_device`).
//!
//! As with `capi_basic.rs`, staticlibs don't re-export unmangled C symbols
//! to integration tests, so we call the public items in `fs_squashfs::capi`
//! directly — this verifies the read *logic* behind the exports.
//!
//! Almost everything here reads the committed `test-disks/squashfs-basic.sqfs`
//! fixture, so the bulk runs under a plain `cargo test` (no squashfs-tools).
//! The one case that compares the driver against `unsquashfs` itself is
//! `#[ignore]`-gated.
//!
//! Fixture geometry (see `test-disks/squashfs-basic.meta.txt`):
//!   block_size = 4096
//!   /sub/deep/big.bin = 20000 bytes of the LCG pattern
//!       → 4 full 4096-byte blocks (16384) + a 3616-byte tail fragment.

mod common;

use std::ffi::{c_void, CString};

use common::{
    basic_big_bin, basic_fixture_path, embed_at_offset, fixture_bytes, fs_core_handle,
    mksquashfs_available, unsquashfs_available, MemDev,
};
use fs_squashfs::capi::*;

const FIXTURE_BLOCK_SIZE: u64 = 4096;
const BIG_LEN: usize = 20000;

fn fixture_cstr() -> CString {
    CString::new(basic_fixture_path().to_str().unwrap()).unwrap()
}

/// Mount the committed fixture over the POSIX-path entry point.
fn mount_path() -> *mut fs_squashfs_fs_t {
    let path = fixture_cstr();
    let fs = unsafe { fs_squashfs_mount(path.as_ptr()) };
    assert!(!fs.is_null(), "fs_squashfs_mount returned NULL");
    fs
}

/// Read an entire file via the C ABI, looping until EOF, into a `Vec`.
fn read_all_capi(fs: *mut fs_squashfs_fs_t, path: &str) -> Vec<u8> {
    let c = CString::new(path).unwrap();
    // Probe the size via stat first so we size the buffer exactly.
    let mut attr = unsafe { std::mem::zeroed::<fs_squashfs_attr_t>() };
    let rc = unsafe { fs_squashfs_stat(fs, c.as_ptr(), &mut attr) };
    assert_eq!(rc, 0, "stat {path}");
    let size = attr.size as usize;

    let mut out = vec![0u8; size];
    let mut done = 0usize;
    while done < size {
        let n = unsafe {
            fs_squashfs_read_file(
                fs,
                c.as_ptr(),
                out[done..].as_mut_ptr() as *mut c_void,
                done as u64,
                (size - done) as u64,
            )
        };
        assert!(n >= 0, "read_file {path} at {done} returned {n}");
        if n == 0 {
            break;
        }
        done += n as usize;
    }
    out.truncate(done);
    out
}

/// Read a window `[offset, offset+len)` via a single C-ABI call.
fn read_window(fs: *mut fs_squashfs_fs_t, path: &str, offset: u64, len: usize) -> Vec<u8> {
    let c = CString::new(path).unwrap();
    let mut buf = vec![0u8; len];
    let n = unsafe {
        fs_squashfs_read_file(
            fs,
            c.as_ptr(),
            buf.as_mut_ptr() as *mut c_void,
            offset,
            len as u64,
        )
    };
    assert!(n >= 0, "read_file {path}@{offset}+{len} returned {n}");
    buf.truncate(n as usize);
    buf
}

// ===========================================================================
// read_file content/geometry over the POSIX-path mount
// ===========================================================================

#[test]
fn read_small_fragment_file_exact_bytes() {
    let fs = mount_path();
    assert_eq!(read_all_capi(fs, "/hello.txt"), b"hi\n");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_nested_small_file_exact_bytes() {
    let fs = mount_path();
    assert_eq!(
        read_all_capi(fs, "/sub/note.md"),
        b"# note\nsome words here\n"
    );
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_multiblock_file_full_matches_pattern() {
    let fs = mount_path();
    let got = read_all_capi(fs, "/sub/deep/big.bin");
    assert_eq!(got.len(), BIG_LEN, "big.bin length");
    assert_eq!(got, basic_big_bin(), "big.bin full content");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_from_offset_zero_partial() {
    // A single short read at offset 0 must return the head of the file.
    let fs = mount_path();
    let want = basic_big_bin();
    let got = read_window(fs, "/sub/deep/big.bin", 0, 100);
    assert_eq!(got, &want[..100]);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_mid_file_offset_inside_one_block() {
    // 5000..6000 sits entirely inside the 2nd 4096-byte block.
    let fs = mount_path();
    let want = basic_big_bin();
    let got = read_window(fs, "/sub/deep/big.bin", 5000, 1000);
    assert_eq!(got, &want[5000..6000]);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_spanning_block_boundary() {
    // Window 4000..4200 straddles the block-0 / block-1 boundary (4096).
    let fs = mount_path();
    let want = basic_big_bin();
    let got = read_window(fs, "/sub/deep/big.bin", 4000, 200);
    assert_eq!(got, &want[4000..4200]);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_spanning_full_blocks_into_fragment_tail() {
    // 4 full blocks end at 16384; the tail fragment holds 16384..20000.
    // A window 16000..17000 crosses the last-block / fragment boundary.
    let fs = mount_path();
    let want = basic_big_bin();
    let got = read_window(fs, "/sub/deep/big.bin", 16000, 1000);
    assert_eq!(got, &want[16000..17000]);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_purely_inside_fragment_tail() {
    // 18000..19000 lives entirely inside the tail fragment.
    let fs = mount_path();
    let want = basic_big_bin();
    let got = read_window(fs, "/sub/deep/big.bin", 18000, 1000);
    assert_eq!(got, &want[18000..19000]);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_each_block_boundary_aligned() {
    // Read exactly one block at a time on aligned offsets; reassemble and
    // compare to the whole file. Exercises every full block + the tail.
    let fs = mount_path();
    let want = basic_big_bin();
    let mut assembled = Vec::with_capacity(BIG_LEN);
    let mut off = 0u64;
    while (off as usize) < BIG_LEN {
        let chunk = read_window(fs, "/sub/deep/big.bin", off, FIXTURE_BLOCK_SIZE as usize);
        assert!(!chunk.is_empty(), "unexpected empty read at {off}");
        assembled.extend_from_slice(&chunk);
        off += chunk.len() as u64;
    }
    assert_eq!(assembled, want);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_at_eof_returns_zero() {
    let fs = mount_path();
    let c = CString::new("/sub/deep/big.bin").unwrap();
    let mut buf = [0u8; 16];
    let n = unsafe {
        fs_squashfs_read_file(
            fs,
            c.as_ptr(),
            buf.as_mut_ptr() as *mut c_void,
            BIG_LEN as u64,
            buf.len() as u64,
        )
    };
    assert_eq!(n, 0, "read at EOF must return 0");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_past_eof_returns_zero() {
    let fs = mount_path();
    let c = CString::new("/hello.txt").unwrap();
    let mut buf = [0u8; 16];
    let n =
        unsafe { fs_squashfs_read_file(fs, c.as_ptr(), buf.as_mut_ptr() as *mut c_void, 9999, 16) };
    assert_eq!(n, 0, "read well past EOF must return 0");
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_crossing_eof_is_short() {
    // big.bin is 20000 bytes; ask for 1000 starting at 19500 → only 500
    // bytes remain. read_file must clamp to the available 500.
    let fs = mount_path();
    let want = basic_big_bin();
    let got = read_window(fs, "/sub/deep/big.bin", 19500, 1000);
    assert_eq!(got.len(), 500, "short read clamped to EOF");
    assert_eq!(got, &want[19500..20000]);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_oversized_length_clamped_to_file_size() {
    // Passing u64::MAX as length must not fabricate an oversized slice;
    // the ABI clamps to the file size. Buffer is sized to the file.
    let fs = mount_path();
    let want = basic_big_bin();
    let c = CString::new("/sub/deep/big.bin").unwrap();
    let mut buf = vec![0u8; BIG_LEN];
    let n = unsafe {
        fs_squashfs_read_file(fs, c.as_ptr(), buf.as_mut_ptr() as *mut c_void, 0, u64::MAX)
    };
    assert_eq!(n, BIG_LEN as i64, "clamped read length");
    assert_eq!(buf, want);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_empty_file_returns_zero() {
    let fs = mount_path();
    let c = CString::new("/empty.txt").unwrap();
    let mut buf = [0u8; 8];
    let n = unsafe { fs_squashfs_read_file(fs, c.as_ptr(), buf.as_mut_ptr() as *mut c_void, 0, 8) };
    assert_eq!(n, 0, "empty file read returns 0");
    unsafe { fs_squashfs_umount(fs) };
}

// ===========================================================================
// read_file error arms
// ===========================================================================

#[test]
fn read_on_directory_is_einval() {
    let fs = mount_path();
    let c = CString::new("/sub").unwrap();
    let mut buf = [0u8; 8];
    let n = unsafe { fs_squashfs_read_file(fs, c.as_ptr(), buf.as_mut_ptr() as *mut c_void, 0, 8) };
    assert_eq!(n, -1, "read on a directory must fail");
    assert_eq!(fs_squashfs_last_errno(), 22 /* EINVAL */);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_on_symlink_is_einval() {
    let fs = mount_path();
    let c = CString::new("/link").unwrap();
    let mut buf = [0u8; 8];
    let n = unsafe { fs_squashfs_read_file(fs, c.as_ptr(), buf.as_mut_ptr() as *mut c_void, 0, 8) };
    assert_eq!(n, -1, "read on a symlink must fail");
    assert_eq!(fs_squashfs_last_errno(), 22 /* EINVAL */);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_missing_path_is_enoent() {
    let fs = mount_path();
    let c = CString::new("/no-such-file").unwrap();
    let mut buf = [0u8; 8];
    let n = unsafe { fs_squashfs_read_file(fs, c.as_ptr(), buf.as_mut_ptr() as *mut c_void, 0, 8) };
    assert_eq!(n, -1);
    assert_eq!(fs_squashfs_last_errno(), 2 /* ENOENT */);
    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn read_null_args_error_not_crash() {
    let fs = mount_path();
    let c = CString::new("/hello.txt").unwrap();
    let mut buf = [0u8; 8];
    unsafe {
        // null fs
        assert_eq!(
            fs_squashfs_read_file(
                std::ptr::null_mut(),
                c.as_ptr(),
                buf.as_mut_ptr() as *mut c_void,
                0,
                8
            ),
            -1
        );
        // null path
        assert_eq!(
            fs_squashfs_read_file(fs, std::ptr::null(), buf.as_mut_ptr() as *mut c_void, 0, 8),
            -1
        );
        // null buf
        assert_eq!(
            fs_squashfs_read_file(fs, c.as_ptr(), std::ptr::null_mut(), 0, 8),
            -1
        );
        fs_squashfs_umount(fs);
    }
}

// ===========================================================================
// Callback-mount path (fs_squashfs_mount_with_callbacks)
// ===========================================================================

/// Read callback over a leaked `Vec<u8>` carried as the context pointer.
/// Returns 0 on success, non-zero on a short/over-range read.
unsafe extern "C" fn vec_read_cb(
    context: *mut c_void,
    buf: *mut c_void,
    offset: u64,
    length: u64,
) -> std::os::raw::c_int {
    let data = unsafe { &*(context as *const Vec<u8>) };
    let start = offset as usize;
    let end = match start.checked_add(length as usize) {
        Some(e) => e,
        None => return 1,
    };
    if end > data.len() {
        return 1;
    }
    let dst = unsafe { std::slice::from_raw_parts_mut(buf as *mut u8, length as usize) };
    dst.copy_from_slice(&data[start..end]);
    0
}

#[test]
fn callback_mount_reads_multiblock_and_fragment() {
    // Leak the backing bytes so the context pointer stays valid for the
    // mount's lifetime; freed at process exit (a test, so that's fine).
    let bytes: &'static Vec<u8> = Box::leak(Box::new(fixture_bytes()));
    let size = bytes.len() as u64;

    let cfg = fs_squashfs_blockdev_cfg_t {
        read: Some(vec_read_cb),
        context: bytes as *const Vec<u8> as *mut c_void,
        size_bytes: size,
        block_size: FIXTURE_BLOCK_SIZE as u32,
    };
    let fs = unsafe { fs_squashfs_mount_with_callbacks(&cfg) };
    assert!(!fs.is_null(), "callback mount returned NULL");

    // multi-block + fragment file round-trips through the callback device.
    assert_eq!(read_all_capi(fs, "/sub/deep/big.bin"), basic_big_bin());
    // small fragment file too.
    assert_eq!(read_all_capi(fs, "/hello.txt"), b"hi\n");
    // mid-file offset window.
    let want = basic_big_bin();
    assert_eq!(
        read_window(fs, "/sub/deep/big.bin", 9000, 500),
        &want[9000..9500]
    );

    unsafe { fs_squashfs_umount(fs) };
}

#[test]
fn callback_mount_rejects_null_read_fn() {
    let cfg = fs_squashfs_blockdev_cfg_t {
        read: None,
        context: std::ptr::null_mut(),
        size_bytes: 0,
        block_size: 4096,
    };
    let fs = unsafe { fs_squashfs_mount_with_callbacks(&cfg) };
    assert!(fs.is_null(), "null read fn must be rejected");
    assert_eq!(fs_squashfs_last_errno(), 22 /* EINVAL */);
}

#[test]
fn callback_mount_rejects_null_cfg() {
    let fs = unsafe { fs_squashfs_mount_with_callbacks(std::ptr::null()) };
    assert!(fs.is_null());
    assert_eq!(fs_squashfs_last_errno(), 22 /* EINVAL */);
}

// ===========================================================================
// fs_core handle mount path (fs_squashfs_mount_with_fs_core_device)
// ===========================================================================

#[test]
fn fs_core_handle_mount_reads_back() {
    let handle = fs_core_handle(fixture_bytes());
    let fs = unsafe { fs_squashfs_mount_with_fs_core_device(handle) };
    assert!(!fs.is_null(), "fs_core handle mount returned NULL");

    // Full multi-block + fragment read.
    assert_eq!(read_all_capi(fs, "/sub/deep/big.bin"), basic_big_bin());
    // Volume info reported through the handle path.
    let mut info = unsafe { std::mem::zeroed::<fs_squashfs_volume_info_t>() };
    let rc = unsafe { fs_squashfs_get_volume_info(fs, &mut info) };
    assert_eq!(rc, 0);
    assert_eq!(info.block_size, FIXTURE_BLOCK_SIZE as u32);
    assert_eq!(info.compression_id, 1, "gzip");

    unsafe { fs_squashfs_umount(fs) };
    // The caller still owns the handle and must close it independently.
    unsafe { fs_core::ffi::fs_core_device_close(handle) };
}

#[test]
fn fs_core_handle_mount_rejects_null() {
    let fs = unsafe { fs_squashfs_mount_with_fs_core_device(std::ptr::null_mut()) };
    assert!(fs.is_null());
    assert_eq!(fs_squashfs_last_errno(), 22 /* EINVAL */);
}

// ===========================================================================
// fs_core slice-mount path — image embedded at an offset inside a larger
// container (simulating a partition), mounted via a sliced handle.
// ===========================================================================

#[test]
fn fs_core_slice_mount_reads_back() {
    // Embed the fixture 1 MiB into a zero-padded buffer, then slice the
    // sub-region back out via the fs_core device and mount it.
    let img = fixture_bytes();
    let (padded, off) = embed_at_offset(&img, 1 << 20);

    // Wrap the padded buffer in an fs_core handle, then slice [off, off+len).
    let handle = fs_core_handle(padded);
    let sliced = unsafe { fs_core::ffi::fs_core_device_slice_ro(handle, off, img.len() as u64) };
    assert!(!sliced.is_null(), "slice returned NULL");

    let fs = unsafe { fs_squashfs_mount_with_fs_core_device(sliced) };
    assert!(!fs.is_null(), "slice mount returned NULL");

    assert_eq!(read_all_capi(fs, "/sub/deep/big.bin"), basic_big_bin());
    assert_eq!(
        read_all_capi(fs, "/sub/note.md"),
        b"# note\nsome words here\n"
    );

    unsafe { fs_squashfs_umount(fs) };
    unsafe { fs_core::ffi::fs_core_device_close(sliced) };
    unsafe { fs_core::ffi::fs_core_device_close(handle) };
}

// ===========================================================================
// In-process Filesystem read (rlib path) — exercises read_file directly to
// cover the `MemDev` BlockRead device the FFI callback path also rides on.
// ===========================================================================

#[test]
fn rlib_read_file_matches_capi() {
    let fs = common::open_image_path(&basic_fixture_path());
    let inode = fs.lookup_path("/sub/deep/big.bin").unwrap();
    assert_eq!(inode.file_size, BIG_LEN as u64);
    let mut buf = vec![0u8; BIG_LEN];
    let n = fs.read_file(&inode, 0, &mut buf).unwrap();
    assert_eq!(n, BIG_LEN);
    assert_eq!(buf, basic_big_bin());

    // Reading at an offset >= size yields 0 (EOF contract).
    let mut tail = [0u8; 8];
    assert_eq!(fs.read_file(&inode, BIG_LEN as u64, &mut tail).unwrap(), 0);
}

#[test]
fn rlib_short_read_loop_reassembles() {
    // Drive read_file in tiny 37-byte windows (deliberately unaligned to
    // the 4096 block size) and confirm the reassembly matches the file.
    let bytes = fixture_bytes();
    let dev = MemDev::arc(bytes);
    let fs = fs_squashfs::Filesystem::open(dev).unwrap();
    let inode = fs.lookup_path("/sub/deep/big.bin").unwrap();

    let mut assembled = Vec::with_capacity(BIG_LEN);
    let mut off = 0u64;
    let mut chunk = [0u8; 37];
    loop {
        let n = fs.read_file(&inode, off, &mut chunk).unwrap();
        if n == 0 {
            break;
        }
        assembled.extend_from_slice(&chunk[..n]);
        off += n as u64;
    }
    assert_eq!(assembled, basic_big_bin());
}

// ===========================================================================
// Oracle cross-check (requires squashfs-tools) — the driver's read of the
// committed fixture must byte-match what `unsquashfs` extracts from it.
// ===========================================================================

#[test]
#[ignore = "requires squashfs-tools (unsquashfs); run with -- --ignored"]
fn read_matches_unsquashfs_extract() {
    if !mksquashfs_available() && !unsquashfs_available() {
        eprintln!("skipping: squashfs-tools not on PATH");
        return;
    }
    let fs = mount_path();
    let via_driver = read_all_capi(fs, "/sub/deep/big.bin");
    unsafe { fs_squashfs_umount(fs) };

    let via_oracle = common::unsquashfs_extract_file(&basic_fixture_path(), "/sub/deep/big.bin");
    assert_eq!(
        via_driver, via_oracle,
        "driver vs unsquashfs disagree on big.bin"
    );
}
