use crate::LFS;
use fs_core::{BlockRead, Error as BlockError};
use fs_squashfs::{Compressor, FileType, Filesystem, Inode};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;
use wasi_virt_layer::file::{InodeId, StandardDynamicLFS};

pub(crate) const RUST_SRC_MOUNT_PATH: &str = "/sysroot/lib/rustlib/src/rust/library";
const REQUIRED_BLOCK_SIZE: u32 = 256 * 1024;
const REQUIRED_SENTINELS: &[&str] = &[
    "Cargo.toml",
    "core/src/lib.rs",
    "alloc/src/lib.rs",
    "std/src/lib.rs",
];

struct OwnedBytesBlockRead {
    bytes: Arc<[u8]>,
}

impl BlockRead for OwnedBytesBlockRead {
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> fs_core::Result<()> {
        let size = self.bytes.len() as u64;
        let len = buf.len() as u64;
        let end = offset
            .checked_add(len)
            .ok_or(BlockError::OutOfBounds { offset, len, size })?;
        if end > size {
            return Err(BlockError::OutOfBounds { offset, len, size });
        }
        let start = offset as usize;
        buf.copy_from_slice(&self.bytes[start..start + buf.len()]);
        Ok(())
    }

    fn size_bytes(&self) -> u64 {
        self.bytes.len() as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RustSrcNodeKind {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RustSrcStat {
    pub kind: RustSrcNodeKind,
    pub size: u64,
    pub mtime_secs: u32,
}

pub(crate) struct RustSrcMount {
    fs: Filesystem,
    files: HashMap<InodeId, Inode>,
    mounted_inodes: HashSet<InodeId>,
    mount_root_inode: InodeId,
    file_count: usize,
    directory_count: usize,
    total_bytes: u64,
}

impl fmt::Debug for RustSrcMount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RustSrcMount")
            .field("mount_root_inode", &self.mount_root_inode)
            .field("file_count", &self.file_count)
            .field("directory_count", &self.directory_count)
            .field("total_bytes", &self.total_bytes)
            .finish_non_exhaustive()
    }
}

impl RustSrcMount {
    pub(crate) fn mount(lfs: &LFS, root_inode: InodeId, bytes: Vec<u8>) -> Result<Self, String> {
        let device: Arc<dyn BlockRead> = Arc::new(OwnedBytesBlockRead {
            bytes: Arc::from(bytes),
        });
        let fs = Filesystem::open(device).map_err(|e| format!("open rust-src SquashFS: {e}"))?;
        validate_format(&fs)?;
        validate_sentinels(&fs)?;
        let image_root = fs
            .root_inode()
            .map_err(|e| format!("read rust-src SquashFS root: {e}"))?;
        if !image_root.is_dir() {
            return Err("rust-src SquashFS root is not a directory".to_string());
        }

        let mount_root_inode = ensure_mount_path(lfs, root_inode)?;
        let mut files = HashMap::new();
        let mut mounted_inodes = HashSet::from([mount_root_inode]);
        let mut file_count = 0usize;
        let mut directory_count = 1usize;
        mount_directory(
            &fs,
            lfs,
            &image_root,
            mount_root_inode,
            &mut files,
            &mut mounted_inodes,
            &mut file_count,
            &mut directory_count,
        )?;
        let total_bytes = files.values().try_fold(0u64, |total, inode| {
            total
                .checked_add(inode.file_size)
                .ok_or_else(|| "rust-src SquashFS total size overflow".to_string())
        })?;

        Ok(Self {
            fs,
            files,
            mounted_inodes,
            mount_root_inode,
            file_count,
            directory_count,
            total_bytes,
        })
    }

    pub(crate) fn is_mounted_inode(&self, inode: InodeId) -> bool {
        self.mounted_inodes.contains(&inode)
    }

    pub(crate) fn is_file_inode(&self, inode: InodeId) -> bool {
        self.files.contains_key(&inode)
    }

    pub(crate) fn file_size(&self, inode: InodeId) -> Option<u64> {
        self.files.get(&inode).map(|inode| inode.file_size)
    }

    pub(crate) fn file_mtime_secs(&self, inode: InodeId) -> Option<u32> {
        self.files.get(&inode).map(|inode| inode.mtime)
    }

    pub(crate) fn read_file(
        &self,
        inode: InodeId,
        offset: u64,
        buf: &mut [u8],
    ) -> Result<usize, String> {
        let inode = self
            .files
            .get(&inode)
            .ok_or_else(|| "inode is not a rust-src regular file".to_string())?;
        self.fs
            .read_file(inode, offset, buf)
            .map_err(|e| format!("read rust-src SquashFS file: {e}"))
    }

    pub(crate) fn stat_path(&self, relative_path: &str) -> Result<RustSrcStat, String> {
        let inode = self.lookup_relative(relative_path)?;
        Ok(stat_from_inode(&inode))
    }

    pub(crate) fn read_path(
        &self,
        relative_path: &str,
        offset: u64,
        buf: &mut [u8],
    ) -> Result<usize, String> {
        let inode = self.lookup_relative(relative_path)?;
        self.fs
            .read_file(&inode, offset, buf)
            .map_err(|e| format!("read rust-src path '{relative_path}': {e}"))
    }

    pub(crate) fn read_dir_path(&self, relative_path: &str) -> Result<Vec<String>, String> {
        let inode = self.lookup_relative(relative_path)?;
        self.fs
            .read_dir(&inode)
            .map_err(|e| format!("read rust-src directory '{relative_path}': {e}"))?
            .into_iter()
            .map(|entry| {
                String::from_utf8(entry.name)
                    .map_err(|_| "rust-src SquashFS contains a non-UTF-8 name".to_string())
            })
            .collect()
    }

    pub(crate) fn file_count(&self) -> usize {
        self.file_count
    }

    pub(crate) fn directory_count(&self) -> usize {
        self.directory_count
    }

    pub(crate) fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    fn lookup_relative(&self, relative_path: &str) -> Result<Inode, String> {
        if relative_path.split('/').any(|part| part == "..") {
            return Err("rust-src path escapes mount root".to_string());
        }
        self.fs
            .lookup_path(relative_path)
            .map_err(|e| format!("lookup rust-src path '{relative_path}': {e}"))
    }
}

fn validate_format(fs: &Filesystem) -> Result<(), String> {
    if fs.sb.version_major != 4 || fs.sb.version_minor != 0 {
        return Err(format!(
            "unsupported rust-src SquashFS version {}.{}; expected 4.0",
            fs.sb.version_major, fs.sb.version_minor
        ));
    }
    if fs.compressor() != Compressor::Zstd {
        return Err(format!(
            "unsupported rust-src SquashFS compressor {}; expected zstd",
            fs.compressor().name()
        ));
    }
    if fs.sb.block_size != REQUIRED_BLOCK_SIZE {
        return Err(format!(
            "unsupported rust-src SquashFS block size {}; expected {}",
            fs.sb.block_size, REQUIRED_BLOCK_SIZE
        ));
    }
    Ok(())
}

fn validate_sentinels(fs: &Filesystem) -> Result<(), String> {
    for path in REQUIRED_SENTINELS {
        let inode = fs
            .lookup_path(path)
            .map_err(|e| format!("rust-src SquashFS is missing '{path}': {e}"))?;
        if !inode.is_regular_file() || inode.file_size == 0 {
            return Err(format!(
                "rust-src SquashFS sentinel '{path}' is empty or not a file"
            ));
        }
        let mut first_byte = [0_u8; 1];
        let read = fs
            .read_file(&inode, 0, &mut first_byte)
            .map_err(|e| format!("rust-src SquashFS sentinel '{path}' is unreadable: {e}"))?;
        if read != first_byte.len() {
            return Err(format!(
                "rust-src SquashFS sentinel '{path}' produced a short read"
            ));
        }
    }
    Ok(())
}

fn ensure_mount_path(lfs: &LFS, root_inode: InodeId) -> Result<InodeId, String> {
    let mut current = root_inode;
    for component in ["sysroot", "lib", "rustlib", "src", "rust", "library"] {
        current = ensure_directory(lfs, current, component)?;
    }
    Ok(current)
}

fn ensure_directory(lfs: &LFS, parent: InodeId, name: &str) -> Result<InodeId, String> {
    if let Some(existing) = find_child(lfs, parent, name)? {
        let metadata = lfs
            .metadata(existing)
            .map_err(|e| format!("stat existing VFS path component '{name}': {e}"))?;
        if metadata.filetype != wasi_virt_layer::__private::wasip1::FILETYPE_DIRECTORY {
            return Err(format!(
                "existing VFS path component '{name}' is not a directory"
            ));
        }
        return Ok(existing);
    }
    lfs.add_dir(parent, name)
        .map_err(|e| format!("create VFS directory '{name}': {e}"))
}

fn ensure_placeholder_file(lfs: &LFS, parent: InodeId, name: &str) -> Result<InodeId, String> {
    if let Some(existing) = find_child(lfs, parent, name)? {
        let metadata = lfs
            .metadata(existing)
            .map_err(|e| format!("stat existing VFS file '{name}': {e}"))?;
        if metadata.filetype != wasi_virt_layer::__private::wasip1::FILETYPE_REGULAR_FILE {
            return Err(format!("existing VFS path '{name}' is not a regular file"));
        }
        lfs.write_file(existing, Vec::new())
            .map_err(|e| format!("clear existing VFS placeholder '{name}': {e}"))?;
        return Ok(existing);
    }
    lfs.add_file(parent, name, Vec::new())
        .map_err(|e| format!("create VFS placeholder '{name}': {e}"))
}

fn find_child(lfs: &LFS, parent: InodeId, name: &str) -> Result<Option<InodeId>, String> {
    lfs.read_dir(parent)
        .map_err(|e| format!("read VFS directory while looking for '{name}': {e}"))
        .map(|entries| {
            entries
                .into_iter()
                .find_map(|(entry_name, inode)| (entry_name == name).then_some(inode))
        })
}

#[allow(clippy::too_many_arguments)]
fn mount_directory(
    fs: &Filesystem,
    lfs: &LFS,
    image_dir: &Inode,
    vfs_dir: InodeId,
    files: &mut HashMap<InodeId, Inode>,
    mounted_inodes: &mut HashSet<InodeId>,
    file_count: &mut usize,
    directory_count: &mut usize,
) -> Result<(), String> {
    let entries = fs
        .read_dir(image_dir)
        .map_err(|e| format!("read rust-src SquashFS directory: {e}"))?;
    for entry in entries {
        let name = String::from_utf8(entry.name)
            .map_err(|_| "rust-src SquashFS contains a non-UTF-8 name".to_string())?;
        let inode = fs
            .read_inode(entry.inode_ref)
            .map_err(|e| format!("read rust-src SquashFS inode '{name}': {e}"))?;
        match inode.file_type() {
            FileType::Dir => {
                let child = ensure_directory(lfs, vfs_dir, &name)?;
                mounted_inodes.insert(child);
                *directory_count += 1;
                mount_directory(
                    fs,
                    lfs,
                    &inode,
                    child,
                    files,
                    mounted_inodes,
                    file_count,
                    directory_count,
                )?;
            }
            FileType::RegFile => {
                let child = ensure_placeholder_file(lfs, vfs_dir, &name)?;
                mounted_inodes.insert(child);
                files.insert(child, inode);
                *file_count += 1;
            }
            FileType::Symlink => {
                if find_child(lfs, vfs_dir, &name)?.is_some() {
                    return Err(format!(
                        "existing VFS symlink path '{name}' cannot be replaced safely"
                    ));
                }
                let target = fs
                    .read_symlink_target(&inode)
                    .map_err(|e| format!("read rust-src symlink '{name}': {e}"))?;
                let target = String::from_utf8(target)
                    .map_err(|_| format!("rust-src symlink '{name}' has a non-UTF-8 target"))?;
                let child = lfs
                    .add_symlink(vfs_dir, &name, &target)
                    .map_err(|e| format!("create VFS symlink '{name}': {e}"))?;
                mounted_inodes.insert(child);
            }
            other => {
                return Err(format!(
                    "rust-src SquashFS contains unsupported node '{name}' of type {other:?}"
                ));
            }
        }
    }
    Ok(())
}

fn stat_from_inode(inode: &Inode) -> RustSrcStat {
    let (kind, size) = match inode.file_type() {
        FileType::Dir => (RustSrcNodeKind::Directory, 0),
        FileType::RegFile => (RustSrcNodeKind::File, inode.file_size),
        FileType::Symlink => (RustSrcNodeKind::Symlink, inode.file_size),
        _ => (RustSrcNodeKind::File, inode.file_size),
    };
    RustSrcStat {
        kind,
        size,
        mtime_secs: inode.mtime,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ShellVirtualStdIO;

    type TestLfs = StandardDynamicLFS<ShellVirtualStdIO>;
    const FIXTURE: &[u8] = include_bytes!("../testdata/rust-src-zstd256k.sqfs");

    fn child(lfs: &TestLfs, parent: InodeId, name: &str) -> InodeId {
        lfs.read_dir(parent)
            .unwrap()
            .into_iter()
            .find_map(|(entry_name, inode)| (entry_name == name).then_some(inode))
            .unwrap_or_else(|| panic!("missing VFS child {name}"))
    }

    fn path_inode(lfs: &TestLfs, root: InodeId, path: &str) -> InodeId {
        path.split('/')
            .filter(|part| !part.is_empty())
            .fold(root, |parent, name| child(lfs, parent, name))
    }

    #[test]
    fn mounts_metadata_only_and_reads_file_lazily() {
        let lfs = TestLfs::new();
        let root = lfs.add_preopen(".");
        let mount = RustSrcMount::mount(&lfs, root, FIXTURE.to_vec()).unwrap();

        let core = path_inode(
            &lfs,
            root,
            "/sysroot/lib/rustlib/src/rust/library/core/src/lib.rs",
        );
        assert!(mount.is_file_inode(core));
        assert!(mount.is_mounted_inode(core));
        assert!(lfs.read_file(core).unwrap().is_empty());
        assert_eq!(
            mount.file_size(core),
            Some(b"pub const CORE_SENTINEL: &str = \"core-from-squashfs\";\n".len() as u64)
        );

        let mut first = [0u8; 9];
        assert_eq!(mount.read_file(core, 4, &mut first).unwrap(), first.len());
        assert_eq!(&first, b"const COR");
        assert!(lfs.read_file(core).unwrap().is_empty());
    }

    #[test]
    fn exposes_complete_fixture_tree_for_direct_lazy_provider() {
        let lfs = TestLfs::new();
        let root = lfs.add_preopen(".");
        let mount = RustSrcMount::mount(&lfs, root, FIXTURE.to_vec()).unwrap();

        assert_eq!(mount.file_count(), 5);
        assert!(mount.directory_count() >= 10);
        assert_eq!(
            mount.stat_path("core/src/lib.rs").unwrap().kind,
            RustSrcNodeKind::File
        );
        let root_entries = mount.read_dir_path("").unwrap();
        assert!(root_entries.iter().any(|name| name == "core"));
        assert!(root_entries.iter().any(|name| name == "portable-simd"));

        let mut buf = [0u8; 64];
        let read = mount
            .read_path("portable-simd/crates/core_simd/src/lib.rs", 0, &mut buf)
            .unwrap();
        assert_eq!(
            &buf[..read],
            b"pub const SIMD_SENTINEL: &str = \"simd-from-squashfs\";\n"
        );
    }

    #[test]
    fn rejects_wrong_block_size_before_mounting() {
        let mut image = FIXTURE.to_vec();
        image[0x0c..0x10].copy_from_slice(&131072u32.to_le_bytes());
        image[0x16..0x18].copy_from_slice(&17u16.to_le_bytes());
        let lfs = TestLfs::new();
        let root = lfs.add_preopen(".");
        let error = RustSrcMount::mount(&lfs, root, image).unwrap_err();
        assert!(error.contains("block size"), "{error}");
    }
}
