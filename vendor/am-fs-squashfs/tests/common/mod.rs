//! Shared helpers for integration tests.
//!
//! Lives in `tests/common/mod.rs` so every `tests/*.rs` integration file
//! can `mod common;` and reuse it without each test crate getting its own
//! duplicate copy.
//!
//! Each integration test compiles `common/` independently and uses only a
//! subset of the helpers, so a few "unused" warnings are expected --
//! silenced at module scope rather than per item.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use fs_core::{BlockDevice, BlockRead};
use fs_squashfs::Filesystem;

/// In-memory `BlockRead` impl backed by a `Vec<u8>`. Owned via
/// `Mutex<Vec<u8>>` so the device is `Send + Sync`.
pub struct MemDev(Mutex<Vec<u8>>);

impl MemDev {
    pub fn new(bytes: Vec<u8>) -> Self {
        MemDev(Mutex::new(bytes))
    }

    /// Construct an `Arc<dyn BlockRead>` from raw bytes -- the shape
    /// `Filesystem::open` wants.
    pub fn arc(bytes: Vec<u8>) -> Arc<dyn BlockRead> {
        Arc::new(MemDev::new(bytes))
    }
}

impl BlockRead for MemDev {
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> fs_core::Result<()> {
        let v = self.0.lock().unwrap();
        let s = offset as usize;
        let e = s + buf.len();
        if e > v.len() {
            return Err(fs_core::Error::ShortRead {
                offset,
                want: buf.len(),
                got: v.len().saturating_sub(s),
            });
        }
        buf.copy_from_slice(&v[s..e]);
        Ok(())
    }
    fn size_bytes(&self) -> u64 {
        self.0.lock().unwrap().len() as u64
    }
}

// SquashFS is read-only, so a `BlockDevice` impl that inherits the trait's
// default (write returns `Err(ReadOnly)`) is all the fs_core handle path
// needs. This lets a test wrap raw bytes into an `FsCoreDevice` handle and
// drive `fs_squashfs_mount_with_fs_core_device` / the slice-mount path.
impl BlockDevice for MemDev {}

/// Open a SquashFS image given as raw bytes. Panics on parse failure --
/// integration tests are expected to feed valid images here.
pub fn open_image(bytes: Vec<u8>) -> Filesystem {
    Filesystem::open(MemDev::arc(bytes)).expect("filesystem open")
}

/// Open a SquashFS image from a file path.
pub fn open_image_path(path: &Path) -> Filesystem {
    let bytes = std::fs::read(path).expect("read image file");
    open_image(bytes)
}

// ---- source-tree model -------------------------------------------------

/// A minimal file-tree model the oracle materialises on disk before
/// handing it to `mksquashfs`.
#[derive(Clone)]
pub enum Node {
    Dir(BTreeMap<String, Node>),
    File(Vec<u8>),
    Symlink(String),
}

/// Build a `Node::Dir` from `(name, child)` pairs.
pub fn dir(entries: Vec<(&str, Node)>) -> Node {
    let mut m = BTreeMap::new();
    for (k, v) in entries {
        m.insert(k.to_string(), v);
    }
    Node::Dir(m)
}

/// A regular file with the given contents.
pub fn file(data: &[u8]) -> Node {
    Node::File(data.to_vec())
}

/// A symlink pointing at `target`.
pub fn symlink(target: &str) -> Node {
    Node::Symlink(target.to_string())
}

/// Deterministic pseudo-random bytes so large files actually span multiple
/// compressed blocks (not a trivial run a codec would collapse to nothing).
pub fn pattern(len: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(len);
    let mut x: u32 = 0x1234_5678;
    for _ in 0..len {
        x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        v.push((x >> 16) as u8);
    }
    v
}

fn materialize(path: &Path, node: &Node) {
    match node {
        Node::Dir(entries) => {
            std::fs::create_dir_all(path).expect("create dir");
            for (name, child) in entries {
                materialize(&path.join(name), child);
            }
        }
        Node::File(data) => {
            std::fs::write(path, data).expect("write file");
        }
        Node::Symlink(target) => {
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, path).expect("create symlink");
            #[cfg(not(unix))]
            panic!("symlink materialization only supported on unix");
        }
    }
}

// ---- squashfs-tools oracle plumbing ------------------------------------

/// True if `mksquashfs` is on `PATH` and runnable.
pub fn mksquashfs_available() -> bool {
    Command::new("mksquashfs")
        .arg("-version")
        .output()
        .map(|o| o.status.success() || !o.stdout.is_empty())
        .unwrap_or(false)
}

/// True if `unsquashfs` is on `PATH` and runnable.
pub fn unsquashfs_available() -> bool {
    Command::new("unsquashfs")
        .arg("-version")
        .output()
        .map(|o| o.status.success() || !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Build a SquashFS image with `mksquashfs -comp <comp>` from a `Node`
/// tree. Returns the rendered image bytes alongside the tempdir keeping
/// the source + image alive (for tools, e.g. `unsquashfs`, that want a
/// path). Panics if `mksquashfs` fails.
pub fn build_with_mksquashfs(comp: &str, tree: &Node) -> ImageArtifact {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    let img = dir.path().join("out.sqfs");
    materialize(&src, tree);

    let out = Command::new("mksquashfs")
        .arg(&src)
        .arg(&img)
        .args(["-comp", comp, "-noappend", "-no-progress", "-no-xattrs"])
        .output()
        .expect("spawn mksquashfs");
    if !out.status.success() {
        panic!(
            "mksquashfs -comp {comp} failed: code={:?}\nstderr: {}\nstdout: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr),
            String::from_utf8_lossy(&out.stdout),
        );
    }
    let bytes = std::fs::read(&img).expect("read built image");
    ImageArtifact {
        bytes,
        path: img,
        _guard: dir,
    }
}

/// Extract a single file from a SquashFS image via `unsquashfs` and return
/// its bytes -- a cross-check oracle independent of the Rust driver.
pub fn unsquashfs_extract_file(image: &Path, inner_path: &str) -> Vec<u8> {
    let dest = tempfile::tempdir().expect("tempdir");
    // `unsquashfs -d <dest> -no-xattrs <image> <inner_path>` extracts just
    // that path under <dest>. The leading slash is dropped by unsquashfs.
    let out = Command::new("unsquashfs")
        .args(["-f", "-no-xattrs", "-d"])
        .arg(dest.path())
        .arg(image)
        .arg(inner_path.trim_start_matches('/'))
        .output()
        .expect("spawn unsquashfs");
    assert!(
        out.status.success(),
        "unsquashfs failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let extracted = dest.path().join(inner_path.trim_start_matches('/'));
    std::fs::read(&extracted).expect("read unsquashfs-extracted file")
}

/// Wraps the bytes of a built image alongside the tempdir keeping its
/// on-disk twin alive for tools that want a path.
pub struct ImageArtifact {
    pub bytes: Vec<u8>,
    pub path: PathBuf,
    _guard: tempfile::TempDir,
}

/// Read an entire regular file out of the driver, by path, into a `Vec`.
pub fn read_whole_file(fs: &Filesystem, path: &str) -> Vec<u8> {
    let inode = fs.lookup_path(path).expect("lookup file");
    assert!(inode.is_regular_file(), "{path} is not a regular file");
    let mut buf = vec![0u8; inode.file_size as usize];
    let mut done = 0usize;
    while done < buf.len() {
        let n = fs
            .read_file(&inode, done as u64, &mut buf[done..])
            .expect("read_file");
        if n == 0 {
            break;
        }
        done += n;
    }
    assert_eq!(done, buf.len(), "short read of {path}");
    buf
}

/// Sorted child names of a directory inode, as UTF-8 strings.
pub fn sorted_dir_names(fs: &Filesystem, path: &str) -> Vec<String> {
    let inode = fs.lookup_path(path).expect("lookup dir");
    let mut names: Vec<String> = fs
        .read_dir(&inode)
        .expect("read_dir")
        .iter()
        .map(|e| String::from_utf8_lossy(&e.name).into_owned())
        .collect();
    names.sort();
    names
}

// ---- committed offline fixtures ----------------------------------------

/// Directory holding the committed test-disk fixtures.
pub fn test_disks_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("test-disks")
}

/// Path to the committed tiny canonical gzip fixture
/// (`test-disks/squashfs-basic.sqfs`). Always present in a checkout — no
/// squashfs-tools required to read it. Built by
/// `scripts/build-squashfs-feature-images.sh basic`.
pub fn basic_fixture_path() -> PathBuf {
    test_disks_dir().join("squashfs-basic.sqfs")
}

/// Raw bytes of the committed gzip fixture. Panics if the fixture is
/// missing from the checkout.
pub fn fixture_bytes() -> Vec<u8> {
    std::fs::read(basic_fixture_path()).expect("read committed fixture")
}

/// `pattern(20000)` — the exact bytes of `/sub/deep/big.bin` in the
/// committed basic fixture (the build script's Python LCG is byte-for-byte
/// identical to [`pattern`]).
pub fn basic_big_bin() -> Vec<u8> {
    pattern(20000)
}

// ---- fs_core handle plumbing (for the FFI mount paths) -----------------

/// Wrap raw image bytes in an `FsCoreDevice` handle (read-only). The
/// returned pointer is owned by the caller and must be freed with
/// `fs_core::ffi::fs_core_device_close`.
pub fn fs_core_handle(bytes: Vec<u8>) -> *mut fs_core::ffi::FsCoreDevice {
    let dev: Arc<dyn BlockDevice> = Arc::new(MemDev::new(bytes));
    fs_core::ffi::FsCoreDevice::into_handle(dev)
}

/// Embed `image` at byte offset `pad` inside a larger zero-padded buffer
/// (simulating a partition inside a container image) and return the
/// padded bytes plus the offset — the inputs to the slice-mount path.
pub fn embed_at_offset(image: &[u8], pad: usize) -> (Vec<u8>, u64) {
    let mut buf = vec![0u8; pad + image.len()];
    buf[pad..].copy_from_slice(image);
    (buf, pad as u64)
}
