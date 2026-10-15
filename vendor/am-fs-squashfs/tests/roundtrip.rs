//! End-to-end round-trip against a real `mksquashfs -comp gzip` image.
//!
//! Builds a source tree with a fragment-sized small file, a multi-block
//! large file, nested directories, and a symlink; squashes it; then reads
//! it back through the pure-Rust driver and asserts every path matches.
//!
//! Skips (does not fail) when `mksquashfs` isn't on PATH, so the suite
//! still runs on a host without squashfs-tools installed.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use fs_core::{BlockRead, FileDevice};
use fs_squashfs::Filesystem;

fn have_mksquashfs() -> bool {
    Command::new("mksquashfs")
        .arg("-version")
        .output()
        .map(|o| o.status.success() || !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Deterministic pseudo-random bytes so the large file actually spans
/// multiple compressed blocks (not a trivial run the codec collapses).
fn pattern(len: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(len);
    let mut x: u32 = 0x1234_5678;
    for _ in 0..len {
        x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        v.push((x >> 16) as u8);
    }
    v
}

fn build_fixture(root: &Path) -> std::path::PathBuf {
    let src = root.join("src");
    std::fs::create_dir_all(src.join("sub/deep")).unwrap();
    std::fs::write(src.join("hello.txt"), b"hi\n").unwrap();
    std::fs::write(src.join("sub/note.md"), b"# note\nsome words here\n").unwrap();
    std::fs::write(src.join("sub/deep/big.bin"), pattern(300_000)).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("hello.txt", src.join("link")).unwrap();

    let img = root.join("out.sqfs");
    let status = Command::new("mksquashfs")
        .arg(&src)
        .arg(&img)
        .args(["-comp", "gzip", "-noappend", "-no-progress"])
        .status()
        .expect("spawn mksquashfs");
    assert!(status.success(), "mksquashfs failed");
    img
}

fn open(img: &Path) -> Filesystem {
    let dev = Arc::new(FileDevice::open(img.to_str().unwrap()).unwrap()) as Arc<dyn BlockRead>;
    Filesystem::open(dev).unwrap()
}

#[test]
fn roundtrip_gzip_image() {
    if !have_mksquashfs() {
        eprintln!("skipping: mksquashfs not found on PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let img = build_fixture(tmp.path());
    let fs = open(&img);

    // Root lists the expected names.
    let root = fs.root_inode().unwrap();
    assert!(root.is_dir());
    let mut names: Vec<String> = fs
        .read_dir(&root)
        .unwrap()
        .iter()
        .map(|e| String::from_utf8_lossy(&e.name).into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec!["hello.txt", "link", "sub"]);

    // Small file (fragment path).
    let f = fs.lookup_path("/hello.txt").unwrap();
    assert!(f.is_regular_file());
    assert_eq!(f.file_size, 3);
    let mut buf = vec![0u8; 3];
    assert_eq!(fs.read_file(&f, 0, &mut buf).unwrap(), 3);
    assert_eq!(&buf, b"hi\n");

    // Nested file.
    let n = fs.lookup_path("/sub/note.md").unwrap();
    let mut nbuf = vec![0u8; n.file_size as usize];
    fs.read_file(&n, 0, &mut nbuf).unwrap();
    assert_eq!(&nbuf, b"# note\nsome words here\n");

    // Large multi-block file — full content + a mid-file offset read.
    let big = fs.lookup_path("/sub/deep/big.bin").unwrap();
    assert_eq!(big.file_size, 300_000);
    let expect = pattern(300_000);
    let mut full = vec![0u8; 300_000];
    let got = fs.read_file(&big, 0, &mut full).unwrap();
    assert_eq!(got, 300_000);
    assert_eq!(full, expect, "large file content mismatch");
    let mut mid = vec![0u8; 1000];
    fs.read_file(&big, 200_000, &mut mid).unwrap();
    assert_eq!(&mid[..], &expect[200_000..201_000]);

    // Symlink target.
    #[cfg(unix)]
    {
        let l = fs.lookup_path("/link").unwrap();
        assert!(l.is_symlink());
        assert_eq!(fs.read_symlink_target(&l).unwrap(), b"hello.txt");
    }

    // Missing paths surface NotFound.
    assert!(fs.lookup_path("/nope").is_err());
}
