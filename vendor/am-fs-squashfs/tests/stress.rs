//! Stress + edge-case tests: many files in one directory, deep directory
//! chains, max-length names, empty files/dirs, and malformed-image refusal.
//!
//! The oracle-built cases (many files, deep trees, long names, all five
//! compressors) need `mksquashfs` and are `#[ignore]`-gated. Run them with:
//!
//! ```sh
//! cargo test --release --test stress -- --ignored
//! ```
//!
//! The committed-fixture and malformed-image cases run under a plain
//! `cargo test` (no external tools).

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use common::*;
use fs_squashfs::{Error, Filesystem};

// ===========================================================================
// Committed-fixture edge cases (no external tools)
// ===========================================================================

#[test]
fn empty_file_reads_as_zero_length() {
    let fs = open_image_path(&basic_fixture_path());
    let inode = fs.lookup_path("/empty.txt").unwrap();
    assert!(inode.is_regular_file());
    assert_eq!(inode.file_size, 0);
    let mut buf = [0u8; 8];
    assert_eq!(fs.read_file(&inode, 0, &mut buf).unwrap(), 0);
}

#[test]
fn deep_path_lookup_on_committed_fixture() {
    // /sub/deep/big.bin is the deepest committed path.
    let fs = open_image_path(&basic_fixture_path());
    assert!(fs
        .lookup_path("/sub/deep/big.bin")
        .unwrap()
        .is_regular_file());
    // A path that descends through a regular file must be rejected.
    assert!(fs.lookup_path("/hello.txt/nope").is_err());
}

// ===========================================================================
// Malformed-image refusal — the reader must return Err(_), never panic.
// ===========================================================================

/// `Filesystem::open` wrapped in `catch_unwind`: `Ok(Some(e))` on a clean
/// error, `Ok(None)` if it surprisingly succeeded, `Err(_)` on a panic.
fn open_classify(bytes: Vec<u8>) -> std::thread::Result<Option<Error>> {
    std::panic::catch_unwind(move || {
        let dev: Arc<dyn fs_core::BlockRead> = Arc::new(MemDev::new(bytes));
        Filesystem::open(dev).err()
    })
}

#[test]
fn flipped_magic_is_rejected_no_panic() {
    let mut img = fixture_bytes();
    img[0] ^= 0xFF; // magic at byte 0
    let err = open_classify(img)
        .expect("must not panic")
        .expect("must error");
    assert!(
        matches!(err, Error::NotSquashfs | Error::BadSuperblock(_)),
        "expected NotSquashfs/BadSuperblock, got {err:?}",
    );
}

#[test]
fn truncated_image_is_rejected_no_panic() {
    let img = vec![0u8; 32]; // far too short for a 96-byte superblock
    assert!(open_classify(img).expect("must not panic").is_some());
}

#[test]
fn all_zeros_image_is_rejected_no_panic() {
    let img = vec![0u8; 4096];
    let err = open_classify(img)
        .expect("must not panic")
        .expect("must error");
    assert!(
        matches!(err, Error::NotSquashfs | Error::BadSuperblock(_)),
        "expected NotSquashfs/BadSuperblock for zeros, got {err:?}",
    );
}

#[test]
fn corrupt_block_log_is_rejected_no_panic() {
    let mut img = fixture_bytes();
    img[0x16] = 99; // block_log out of the 12..=20 range
    let err = open_classify(img)
        .expect("must not panic")
        .expect("must error");
    assert!(
        matches!(err, Error::BadSuperblock(_)),
        "expected BadSuperblock, got {err:?}",
    );
}

#[test]
fn unsupported_compression_id_is_rejected_no_panic() {
    let mut img = fixture_bytes();
    // compression_id at 0x14: 0xFFFF is not a known codec.
    img[0x14..0x16].copy_from_slice(&0xFFFFu16.to_le_bytes());
    let err = open_classify(img)
        .expect("must not panic")
        .expect("must error");
    assert!(
        matches!(
            err,
            Error::UnsupportedCompression(_) | Error::BadSuperblock(_)
        ),
        "expected UnsupportedCompression, got {err:?}",
    );
}

#[test]
fn corrupt_root_inode_ref_is_handled_no_panic() {
    let mut img = fixture_bytes();
    // root_inode_ref at 0x20: a wildly out-of-range value must error on
    // the first root-inode read, not panic.
    img[0x20..0x28].copy_from_slice(&0xFFFF_FFFF_FFFFu64.to_le_bytes());
    let res: std::thread::Result<fs_squashfs::Result<()>> = std::panic::catch_unwind(move || {
        let dev: Arc<dyn fs_core::BlockRead> = Arc::new(MemDev::new(img));
        let fs = Filesystem::open(dev)?;
        fs.root_inode().map(|_| ())
    });
    assert!(
        res.expect("must not panic").is_err(),
        "bad root ref must error"
    );
}

// ===========================================================================
// Oracle-built stress trees (require mksquashfs)
// ===========================================================================

/// Many files in one directory: proves directory listings that span
/// multiple metadata blocks parse and every entry resolves.
#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn many_files_in_one_directory_gzip() {
    if !mksquashfs_available() {
        eprintln!("skipping: mksquashfs not on PATH");
        return;
    }
    let n = 1000;
    let mut entries = Vec::with_capacity(n);
    let names: Vec<String> = (0..n).map(|i| format!("file_{i:04}")).collect();
    for (i, name) in names.iter().enumerate() {
        entries.push((name.as_str(), file(format!("contents-{i}\n").as_bytes())));
    }
    let art = build_with_mksquashfs("gzip", &dir(entries));
    let fs = open_image(art.bytes);

    // Every entry is listed.
    let listed = sorted_dir_names(&fs, "/");
    assert_eq!(listed.len(), n, "directory entry count");

    // Spot-check a scatter of files resolve + read back correctly.
    for &i in &[0usize, 1, 42, 500, 999] {
        let got = read_whole_file(&fs, &format!("/file_{i:04}"));
        assert_eq!(got, format!("contents-{i}\n").as_bytes(), "file_{i:04}");
    }
}

/// A deep directory chain: proves path traversal recurses arbitrarily.
#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn deep_directory_chain_gzip() {
    if !mksquashfs_available() {
        eprintln!("skipping: mksquashfs not on PATH");
        return;
    }
    // Build /d0/d1/.../d19/leaf.txt nested 20 deep.
    const DEPTH: usize = 20;
    let mut node = dir(vec![("leaf.txt", file(b"bottom\n"))]);
    for level in (0..DEPTH).rev() {
        node = dir(vec![(
            Box::leak(format!("d{level}").into_boxed_str()) as &str,
            node,
        )]);
    }
    let art = build_with_mksquashfs("gzip", &node);
    let fs = open_image(art.bytes);

    let mut path = String::new();
    for level in 0..DEPTH {
        path.push_str(&format!("/d{level}"));
    }
    path.push_str("/leaf.txt");
    assert_eq!(read_whole_file(&fs, &path), b"bottom\n", "deep leaf");
}

/// Max-length (255-byte) and unicode filenames round-trip.
#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn long_and_unicode_names_gzip() {
    if !mksquashfs_available() {
        eprintln!("skipping: mksquashfs not on PATH");
        return;
    }
    let long_name = "x".repeat(255);
    let tree = dir(vec![
        (long_name.as_str(), file(b"long\n")),
        ("h\u{e9}llo-\u{4e16}\u{754c}.txt", file(b"unicode\n")),
        ("file with spaces.txt", file(b"spaces\n")),
    ]);
    let art = build_with_mksquashfs("gzip", &tree);
    let fs = open_image(art.bytes);

    assert_eq!(read_whole_file(&fs, &format!("/{long_name}")), b"long\n");
    assert_eq!(
        read_whole_file(&fs, "/h\u{e9}llo-\u{4e16}\u{754c}.txt"),
        b"unicode\n"
    );
    assert_eq!(read_whole_file(&fs, "/file with spaces.txt"), b"spaces\n");
}

/// Empty files and empty directories survive a round-trip.
#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn empty_files_and_dirs_gzip() {
    if !mksquashfs_available() {
        eprintln!("skipping: mksquashfs not on PATH");
        return;
    }
    let tree = dir(vec![
        ("zero.bin", file(b"")),
        ("empty_dir", dir(vec![])),
        ("nonempty", dir(vec![("x", file(b"x\n"))])),
    ]);
    let art = build_with_mksquashfs("gzip", &tree);
    let fs = open_image(art.bytes);

    let zero = fs.lookup_path("/zero.bin").unwrap();
    assert_eq!(zero.file_size, 0);
    assert_eq!(read_whole_file(&fs, "/zero.bin"), b"");

    let empty_dir = fs.lookup_path("/empty_dir").unwrap();
    assert!(empty_dir.is_dir());
    assert!(
        fs.read_dir(&empty_dir).unwrap().is_empty(),
        "empty dir listing"
    );

    assert_eq!(sorted_dir_names(&fs, "/nonempty"), vec!["x"]);
}

/// A moderately varied tree built once per compressor; read every leaf
/// back and confirm the bytes match. Proves the stress shape decodes from
/// every codec's real `mksquashfs` output.
#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn varied_tree_all_compressors() {
    if !mksquashfs_available() {
        eprintln!("skipping: mksquashfs not on PATH");
        return;
    }
    // (path, contents) pairs the tree below contains.
    let mut expected: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    expected.insert("/a.txt".into(), b"alpha\n".to_vec());
    expected.insert("/dir/b.bin".into(), pattern(50_000)); // multi-block
    expected.insert("/dir/sub/c.txt".into(), b"charlie\n".to_vec());
    expected.insert("/dir/sub/empty".into(), Vec::new());

    let tree = dir(vec![
        ("a.txt", file(b"alpha\n")),
        (
            "dir",
            dir(vec![
                ("b.bin", file(&pattern(50_000))),
                (
                    "sub",
                    dir(vec![("c.txt", file(b"charlie\n")), ("empty", file(b""))]),
                ),
            ]),
        ),
    ]);

    for comp in ["gzip", "xz", "lz4", "zstd", "lzo"] {
        let art = build_with_mksquashfs(comp, &tree);
        let fs = open_image(art.bytes);
        for (path, want) in &expected {
            let got = read_whole_file(&fs, path);
            assert_eq!(&got, want, "[{comp}] {path}");
        }
    }
}
