use crate::LFS;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::Read as _;
use std::ops::Index;
use std::path::{Component, Path, PathBuf};
use wasi_virt_layer::prelude::__self;
use wasi_virt_layer::wasi::file::Wasip1LFSBase;

pub(crate) const DEFAULT_SYNC_LIMITS: SyncLimits = SyncLimits {
    max_entries: 10_000,
    max_bytes: 64 * 1024 * 1024,
};

const EXCLUDED_ROOTS: &[&str] = &[
    "sysroot",
    "target",
    ".cargo/registry",
    ".cargo/git",
    ".git",
    "node_modules",
    ".cache",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SyncLimits {
    pub(crate) max_entries: usize,
    pub(crate) max_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SyncError {
    TooManyEntries,
    TooManyBytes,
    Io(String),
    Vfs(&'static str),
    InvalidPath(PathBuf),
    UnsupportedFileType(PathBuf),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyEntries => write!(f, "filesystem sync exceeds the entry limit"),
            Self::TooManyBytes => write!(f, "filesystem sync exceeds the byte limit"),
            Self::Io(error) => write!(f, "filesystem sync I/O error: {error}"),
            Self::Vfs(operation) => write!(f, "filesystem sync VFS error during {operation}"),
            Self::InvalidPath(path) => {
                write!(f, "filesystem sync path is not valid UTF-8: {path:?}")
            }
            Self::UnsupportedFileType(path) => {
                write!(
                    f,
                    "filesystem sync does not support this file type: {path:?}"
                )
            }
        }
    }
}

impl std::error::Error for SyncError {}

#[derive(Clone, Debug, Eq, PartialEq)]
enum EntryKind {
    Directory,
    File(Vec<u8>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SnapshotEntry {
    kind: EntryKind,
    digest: u64,
}

impl SnapshotEntry {
    fn directory() -> Self {
        Self {
            kind: EntryKind::Directory,
            digest: stable_digest(b"directory"),
        }
    }

    fn file(bytes: Vec<u8>) -> Self {
        let digest = stable_digest(&bytes);
        Self {
            kind: EntryKind::File(bytes),
            digest,
        }
    }

    fn is_directory(&self) -> bool {
        matches!(self.kind, EntryKind::Directory)
    }

    fn bytes(&self) -> &[u8] {
        match &self.kind {
            EntryKind::File(bytes) => bytes,
            EntryKind::Directory => &[],
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct SyncBaseline {
    entries: BTreeMap<PathBuf, SnapshotEntry>,
    runtime_exclusions: Vec<PathBuf>,
}

impl Index<&str> for SyncBaseline {
    type Output = SnapshotEntry;

    fn index(&self, path: &str) -> &Self::Output {
        &self.entries[Path::new(path)]
    }
}

#[derive(Debug, Eq, PartialEq)]
struct ReconcileResult {
    tree: SyncBaseline,
    conflicts: Vec<PathBuf>,
}

fn stable_digest(bytes: &[u8]) -> u64 {
    let mut digest = 0xcbf29ce484222325_u64;
    for byte in bytes {
        digest ^= u64::from(*byte);
        digest = digest.wrapping_mul(0x100000001b3);
    }
    digest
}

fn is_excluded(path: &Path) -> bool {
    EXCLUDED_ROOTS
        .iter()
        .any(|excluded| path.starts_with(excluded))
}

fn is_runtime_excluded(path: &Path, runtime_exclusions: &[PathBuf]) -> bool {
    runtime_exclusions
        .iter()
        .any(|excluded| !excluded.as_os_str().is_empty() && path.starts_with(excluded))
}

fn contains_exclusion(path: &Path, runtime_exclusions: &[PathBuf]) -> bool {
    EXCLUDED_ROOTS
        .iter()
        .map(Path::new)
        .chain(runtime_exclusions.iter().map(PathBuf::as_path))
        .any(|excluded| excluded != path && excluded.starts_with(path))
}

fn should_exclude(path: &Path, runtime_exclusions: &[PathBuf]) -> bool {
    is_excluded(path) || is_runtime_excluded(path, runtime_exclusions)
}

fn check_limits(entries: usize, bytes: usize) -> Result<(), SyncError> {
    if entries > DEFAULT_SYNC_LIMITS.max_entries {
        return Err(SyncError::TooManyEntries);
    }
    if bytes > DEFAULT_SYNC_LIMITS.max_bytes {
        return Err(SyncError::TooManyBytes);
    }
    Ok(())
}

fn check_configured_limits(
    entries: usize,
    bytes: usize,
    limits: SyncLimits,
) -> Result<(), SyncError> {
    if entries > limits.max_entries {
        return Err(SyncError::TooManyEntries);
    }
    if bytes > limits.max_bytes {
        return Err(SyncError::TooManyBytes);
    }
    Ok(())
}

fn check_file_size(
    current_bytes: usize,
    file_bytes: usize,
    limits: SyncLimits,
) -> Result<usize, SyncError> {
    let total = current_bytes
        .checked_add(file_bytes)
        .ok_or(SyncError::TooManyBytes)?;
    if total > limits.max_bytes {
        return Err(SyncError::TooManyBytes);
    }
    Ok(total)
}

fn reconcile_diff(
    baseline: &SyncBaseline,
    child: &SyncBaseline,
    current_vfs: &SyncBaseline,
) -> Result<ReconcileResult, SyncError> {
    reconcile_diff_with_limits(baseline, child, current_vfs, DEFAULT_SYNC_LIMITS)
}

fn reconcile_diff_with_limits(
    baseline: &SyncBaseline,
    child: &SyncBaseline,
    current_vfs: &SyncBaseline,
    limits: SyncLimits,
) -> Result<ReconcileResult, SyncError> {
    let changed = baseline
        .entries
        .keys()
        .chain(child.entries.keys())
        .filter(|path| baseline.entries.get(*path) != child.entries.get(*path))
        .cloned()
        .collect::<BTreeSet<_>>();

    let conflicts = baseline
        .entries
        .keys()
        .chain(current_vfs.entries.keys())
        .filter(|path| current_vfs.entries.get(*path) != baseline.entries.get(*path))
        .filter(|path| {
            changed
                .iter()
                .any(|change| path.starts_with(change) || change.starts_with(*path))
        })
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let mut tree = current_vfs.clone();
    tree.runtime_exclusions = baseline.runtime_exclusions.clone();
    let mut changes = changed.into_iter().collect::<Vec<_>>();
    changes.sort_by_key(|path| path.components().count());

    for path in changes {
        if conflicts
            .iter()
            .any(|conflict| path.starts_with(conflict) || conflict.starts_with(&path))
        {
            continue;
        }

        tree.entries
            .retain(|existing, _| existing != &path && !existing.starts_with(&path));
        if let Some(entry) = child.entries.get(&path) {
            tree.entries.insert(path, entry.clone());
        }
    }

    let (entry_count, byte_count) = snapshot_size(&tree);
    check_configured_limits(entry_count, byte_count, limits)?;
    Ok(ReconcileResult { tree, conflicts })
}

fn reconcile_authoritative(
    host: &SyncBaseline,
    _current: &SyncBaseline,
) -> Result<SyncBaseline, SyncError> {
    reconcile_authoritative_with_limits(host, DEFAULT_SYNC_LIMITS)
}

fn reconcile_authoritative_with_limits(
    host: &SyncBaseline,
    limits: SyncLimits,
) -> Result<SyncBaseline, SyncError> {
    let (entry_count, byte_count) = snapshot_size(host);
    check_configured_limits(entry_count, byte_count, limits)?;
    Ok(host.clone())
}

fn snapshot_size(snapshot: &SyncBaseline) -> (usize, usize) {
    (
        snapshot.entries.len(),
        snapshot
            .entries
            .values()
            .map(|entry| entry.bytes().len())
            .sum(),
    )
}

pub(crate) fn sync_vfs_to_host(
    lfs: &LFS,
    root: usize,
    host_root: &Path,
    limits: SyncLimits,
    runtime_exclusions: &[PathBuf],
) -> Result<SyncBaseline, SyncError> {
    let runtime_exclusions = runtime_exclusions
        .iter()
        .map(|path| normalize_relative(path))
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    let source = snapshot_vfs(lfs, root, limits, &runtime_exclusions)?;
    let current_host = snapshot_host(host_root, limits, &runtime_exclusions)?;
    apply_host_snapshot(host_root, &current_host, &source)?;
    Ok(source)
}

pub(crate) fn sync_host_to_vfs(
    lfs: &LFS,
    root: usize,
    host_root: &Path,
    baseline: &SyncBaseline,
    limits: SyncLimits,
) -> Result<Vec<PathBuf>, SyncError> {
    let child = snapshot_host(host_root, limits, &baseline.runtime_exclusions)?;
    let current_vfs = snapshot_vfs(lfs, root, limits, &baseline.runtime_exclusions)?;
    let result = reconcile_diff_with_limits(baseline, &child, &current_vfs, limits)?;
    let mut conflicts = result.conflicts;
    conflicts.extend(apply_vfs_snapshot_rechecked(
        lfs,
        root,
        &current_vfs,
        &result.tree,
        limits,
        |_| {},
    )?);
    conflicts.sort();
    conflicts.dedup();
    Ok(conflicts)
}

pub(crate) fn import_host_authoritative(
    lfs: &LFS,
    root: usize,
    host_root: &Path,
    limits: SyncLimits,
) -> Result<SyncBaseline, SyncError> {
    let host = snapshot_host(host_root, limits, &[])?;
    let current_vfs = snapshot_vfs(lfs, root, limits, &[])?;
    let desired = reconcile_authoritative_with_limits(&host, limits)?;
    apply_vfs_snapshot(lfs, root, &current_vfs, &desired)?;
    Ok(desired)
}

pub(crate) fn runtime_exclusions_from_child(
    cargo_target_dir: Option<&Path>,
    executable: &Path,
) -> Vec<PathBuf> {
    let target = cargo_target_dir.map(normalize_relative).or_else(|| {
        let binary = executable.file_name()?.to_str()?;
        if !binary.ends_with(".wasm") {
            return None;
        }
        let profile = executable.parent()?;
        let triple = profile.parent()?;
        if triple.file_name()? != "wasm32-wasip1" {
            return None;
        }
        Some(normalize_relative(triple.parent()?))
    });

    target
        .filter(|path| !path.as_os_str().is_empty())
        .into_iter()
        .collect()
}

fn normalize_relative(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    normalized
}

fn validate_vfs_name(name: &str) -> Result<&str, SyncError> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(component)), None) if component == name => Ok(name),
        _ => Err(SyncError::InvalidPath(PathBuf::from(name))),
    }
}

fn snapshot_host(
    root: &Path,
    limits: SyncLimits,
    runtime_exclusions: &[PathBuf],
) -> Result<SyncBaseline, SyncError> {
    let mut snapshot = SyncBaseline {
        entries: BTreeMap::new(),
        runtime_exclusions: runtime_exclusions.to_vec(),
    };
    let mut byte_count = 0;
    snapshot_host_dir(root, Path::new(""), &mut snapshot, &mut byte_count, limits)?;
    Ok(snapshot)
}

fn snapshot_host_dir(
    host_dir: &Path,
    relative_dir: &Path,
    snapshot: &mut SyncBaseline,
    byte_count: &mut usize,
    limits: SyncLimits,
) -> Result<(), SyncError> {
    let mut entries = std::fs::read_dir(host_dir)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let relative_path = relative_dir.join(entry.file_name());
        if should_exclude(&relative_path, &snapshot.runtime_exclusions) {
            continue;
        }
        if relative_path.to_str().is_none() {
            return Err(SyncError::InvalidPath(relative_path));
        }

        let file_type = entry.file_type().map_err(io_error)?;
        let snapshot_entry = if file_type.is_dir() {
            SnapshotEntry::directory()
        } else if file_type.is_file() {
            let file_size = usize::try_from(entry.metadata().map_err(io_error)?.len())
                .map_err(|_| SyncError::TooManyBytes)?;
            check_file_size(*byte_count, file_size, limits)?;
            let remaining = limits.max_bytes - *byte_count;
            let mut bytes = Vec::with_capacity(file_size.min(remaining));
            std::fs::File::open(entry.path())
                .map_err(io_error)?
                .take(remaining as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
            *byte_count = check_file_size(*byte_count, bytes.len(), limits)?;
            SnapshotEntry::file(bytes)
        } else {
            return Err(SyncError::UnsupportedFileType(relative_path));
        };

        snapshot
            .entries
            .insert(relative_path.clone(), snapshot_entry);
        check_configured_limits(snapshot.entries.len(), *byte_count, limits)?;
        if file_type.is_dir() {
            snapshot_host_dir(&entry.path(), &relative_path, snapshot, byte_count, limits)?;
        }
    }
    Ok(())
}

fn snapshot_vfs(
    lfs: &LFS,
    root: usize,
    limits: SyncLimits,
    runtime_exclusions: &[PathBuf],
) -> Result<SyncBaseline, SyncError> {
    let mut snapshot = SyncBaseline {
        entries: BTreeMap::new(),
        runtime_exclusions: runtime_exclusions.to_vec(),
    };
    let mut byte_count = 0;
    snapshot_vfs_dir(
        lfs,
        root,
        Path::new(""),
        &mut snapshot,
        &mut byte_count,
        limits,
    )?;
    Ok(snapshot)
}

fn snapshot_vfs_dir(
    lfs: &LFS,
    inode: usize,
    relative_dir: &Path,
    snapshot: &mut SyncBaseline,
    byte_count: &mut usize,
    limits: SyncLimits,
) -> Result<(), SyncError> {
    let mut entries = lfs
        .read_dir(inode)
        .map_err(|_| SyncError::Vfs("read_dir"))?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    for (name, child_inode) in entries {
        if name == "." || name == ".." {
            continue;
        }
        let relative_path = relative_dir.join(validate_vfs_name(&name)?);
        if should_exclude(&relative_path, &snapshot.runtime_exclusions) {
            continue;
        }

        if lfs.read_dir(child_inode).is_ok() {
            snapshot
                .entries
                .insert(relative_path.clone(), SnapshotEntry::directory());
            check_configured_limits(snapshot.entries.len(), *byte_count, limits)?;
            snapshot_vfs_dir(
                lfs,
                child_inode,
                &relative_path,
                snapshot,
                byte_count,
                limits,
            )?;
        } else {
            let (bytes, total_bytes) =
                read_vfs_file_bounded(lfs, child_inode, *byte_count, limits)?;
            *byte_count = total_bytes;
            snapshot
                .entries
                .insert(relative_path, SnapshotEntry::file(bytes));
            check_configured_limits(snapshot.entries.len(), *byte_count, limits)?;
        }
    }
    Ok(())
}

fn read_vfs_file_bounded(
    lfs: &LFS,
    inode: usize,
    current_bytes: usize,
    limits: SyncLimits,
) -> Result<(Vec<u8>, usize), SyncError> {
    let stat = <LFS as Wasip1LFSBase>::fd_filestat_get_raw::<__self>(lfs, &inode)
        .map_err(|_| SyncError::Vfs("fd_filestat_get_raw"))?;
    let file_size = usize::try_from(stat.size).map_err(|_| SyncError::TooManyBytes)?;
    let total_bytes = check_file_size(current_bytes, file_size, limits)?;
    let mut bytes = vec![0; file_size];
    let bytes_read = <LFS as Wasip1LFSBase>::fd_pread_raw::<__self>(
        lfs,
        &inode,
        bytes.as_mut_ptr(),
        bytes.len(),
        0,
    )
    .map_err(|_| SyncError::Vfs("fd_pread_raw"))?;
    bytes.truncate(bytes_read);
    let final_stat = <LFS as Wasip1LFSBase>::fd_filestat_get_raw::<__self>(lfs, &inode)
        .map_err(|_| SyncError::Vfs("fd_filestat_get_raw"))?;
    if final_stat.size != stat.size || bytes.len() != file_size {
        return Err(SyncError::Vfs("file changed during snapshot"));
    }
    Ok((bytes, total_bytes))
}

fn snapshot_vfs_branch(
    lfs: &LFS,
    root: usize,
    path: &Path,
    include_descendants: bool,
    limits: SyncLimits,
    runtime_exclusions: &[PathBuf],
) -> Result<SyncBaseline, SyncError> {
    let mut snapshot = SyncBaseline {
        entries: BTreeMap::new(),
        runtime_exclusions: runtime_exclusions.to_vec(),
    };
    let mut inode = root;
    let mut relative_path = PathBuf::new();
    let mut components = path.components().peekable();
    let mut byte_count = 0;

    while let Some(Component::Normal(component)) = components.next() {
        let name = component
            .to_str()
            .ok_or_else(|| SyncError::InvalidPath(path.to_path_buf()))?;
        let Some(child_inode) = lfs
            .read_dir(inode)
            .map_err(|_| SyncError::Vfs("read_dir"))?
            .into_iter()
            .find_map(|(entry_name, inode)| (entry_name == name).then_some(inode))
        else {
            break;
        };
        relative_path.push(name);

        if lfs.read_dir(child_inode).is_ok() {
            snapshot
                .entries
                .insert(relative_path.clone(), SnapshotEntry::directory());
            check_configured_limits(snapshot.entries.len(), byte_count, limits)?;
            if components.peek().is_none() && include_descendants {
                snapshot_vfs_dir(
                    lfs,
                    child_inode,
                    &relative_path,
                    &mut snapshot,
                    &mut byte_count,
                    limits,
                )?;
            }
            inode = child_inode;
        } else {
            let (bytes, total_bytes) = read_vfs_file_bounded(lfs, child_inode, byte_count, limits)?;
            byte_count = total_bytes;
            snapshot
                .entries
                .insert(relative_path.clone(), SnapshotEntry::file(bytes));
            check_configured_limits(snapshot.entries.len(), byte_count, limits)?;
            break;
        }
    }
    Ok(snapshot)
}

fn apply_host_snapshot(
    root: &Path,
    current: &SyncBaseline,
    desired: &SyncBaseline,
) -> Result<(), SyncError> {
    let mut removals = current
        .entries
        .iter()
        .filter(|(path, entry)| {
            !entry.is_directory()
                || (!contains_exclusion(path, &current.runtime_exclusions)
                    && !contains_exclusion(path, &desired.runtime_exclusions))
        })
        .filter(|(path, entry)| {
            desired
                .entries
                .get(*path)
                .is_none_or(|wanted| wanted.is_directory() != entry.is_directory())
        })
        .map(|(path, entry)| (path.clone(), entry.is_directory()))
        .collect::<Vec<_>>();
    removals.sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));
    for (path, is_directory) in removals {
        if is_directory {
            std::fs::remove_dir(root.join(path)).map_err(io_error)?;
        } else {
            std::fs::remove_file(root.join(path)).map_err(io_error)?;
        }
    }

    let mut directories = desired
        .entries
        .iter()
        .filter(|(path, entry)| entry.is_directory() && current.entries.get(*path) != Some(*entry))
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    directories.sort_by_key(|path| path.components().count());
    for path in directories {
        std::fs::create_dir(root.join(path)).map_err(io_error)?;
    }

    for (path, entry) in &desired.entries {
        if !entry.is_directory() && current.entries.get(path) != Some(entry) {
            std::fs::write(root.join(path), entry.bytes()).map_err(io_error)?;
        }
    }
    Ok(())
}

fn apply_vfs_snapshot(
    lfs: &LFS,
    root: usize,
    current: &SyncBaseline,
    desired: &SyncBaseline,
) -> Result<(), SyncError> {
    let mut removals = current
        .entries
        .iter()
        .filter(|(path, entry)| {
            !entry.is_directory()
                || (!contains_exclusion(path, &current.runtime_exclusions)
                    && !contains_exclusion(path, &desired.runtime_exclusions))
        })
        .filter(|(path, entry)| {
            desired
                .entries
                .get(*path)
                .is_none_or(|wanted| wanted.is_directory() != entry.is_directory())
        })
        .map(|(path, entry)| (path.clone(), entry.is_directory()))
        .collect::<Vec<_>>();
    removals.sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));
    for (path, is_directory) in removals {
        let (parent, name) = vfs_parent_and_name(lfs, root, &path)?;
        if is_directory {
            lfs.remove_dir(parent, name)
                .map_err(|_| SyncError::Vfs("remove_dir"))?;
        } else {
            lfs.remove_file(parent, name)
                .map_err(|_| SyncError::Vfs("remove_file"))?;
        }
    }

    let mut directories = desired
        .entries
        .iter()
        .filter(|(path, entry)| entry.is_directory() && current.entries.get(*path) != Some(*entry))
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    directories.sort_by_key(|path| path.components().count());
    for path in directories {
        let (parent, name) = vfs_parent_and_name(lfs, root, &path)?;
        lfs.add_dir(parent, name)
            .map_err(|_| SyncError::Vfs("add_dir"))?;
    }

    for (path, entry) in &desired.entries {
        if entry.is_directory() || current.entries.get(path) == Some(entry) {
            continue;
        }
        let (parent, name) = vfs_parent_and_name(lfs, root, path)?;
        if current
            .entries
            .get(path)
            .is_some_and(|entry| !entry.is_directory())
        {
            let inode = vfs_child(lfs, parent, name)?;
            lfs.write_file(inode, entry.bytes().to_vec())
                .map_err(|_| SyncError::Vfs("write_file"))?;
        } else {
            lfs.add_file(parent, name, entry.bytes().to_vec())
                .map_err(|_| SyncError::Vfs("add_file"))?;
        }
    }
    Ok(())
}

fn apply_vfs_snapshot_rechecked<F>(
    lfs: &LFS,
    root: usize,
    current: &SyncBaseline,
    desired: &SyncBaseline,
    limits: SyncLimits,
    mut before_mutation: F,
) -> Result<Vec<PathBuf>, SyncError>
where
    F: FnMut(&Path),
{
    let mut expected = current.clone();
    let mut conflicts = BTreeSet::new();
    let mut removals = current
        .entries
        .iter()
        .filter(|(path, entry)| {
            !entry.is_directory()
                || (!contains_exclusion(path, &current.runtime_exclusions)
                    && !contains_exclusion(path, &desired.runtime_exclusions))
        })
        .filter(|(path, entry)| {
            desired
                .entries
                .get(*path)
                .is_none_or(|wanted| wanted.is_directory() != entry.is_directory())
        })
        .map(|(path, entry)| (path.clone(), entry.is_directory()))
        .collect::<Vec<_>>();
    removals.sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));

    for (path, is_directory) in removals {
        if is_related_to_conflict(&path, &conflicts) {
            continue;
        }
        before_mutation(&path);
        let live = snapshot_vfs_branch(
            lfs,
            root,
            &path,
            is_directory,
            limits,
            &current.runtime_exclusions,
        )?;
        let found = affected_differences(&expected, &live, &path, is_directory);
        if !found.is_empty() {
            conflicts.extend(found);
            continue;
        }

        let (parent, name) = vfs_parent_and_name(lfs, root, &path)?;
        if is_directory {
            lfs.remove_dir(parent, name)
                .map_err(|_| SyncError::Vfs("remove_dir"))?;
            expected
                .entries
                .retain(|existing, _| existing != &path && !existing.starts_with(&path));
        } else {
            lfs.remove_file(parent, name)
                .map_err(|_| SyncError::Vfs("remove_file"))?;
            expected.entries.remove(&path);
        }
    }

    let mut directories = desired
        .entries
        .iter()
        .filter(|(path, entry)| entry.is_directory() && current.entries.get(*path) != Some(*entry))
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    directories.sort_by_key(|path| path.components().count());
    for path in directories {
        if is_related_to_conflict(&path, &conflicts) {
            continue;
        }
        before_mutation(&path);
        let live =
            snapshot_vfs_branch(lfs, root, &path, false, limits, &current.runtime_exclusions)?;
        let found = affected_differences(&expected, &live, &path, false);
        if !found.is_empty() {
            conflicts.extend(found);
            continue;
        }

        let (parent, name) = vfs_parent_and_name(lfs, root, &path)?;
        lfs.add_dir(parent, name)
            .map_err(|_| SyncError::Vfs("add_dir"))?;
        expected.entries.insert(path, SnapshotEntry::directory());
    }

    for (path, entry) in &desired.entries {
        if entry.is_directory()
            || current.entries.get(path) == Some(entry)
            || is_related_to_conflict(path, &conflicts)
        {
            continue;
        }
        before_mutation(path);
        let live =
            snapshot_vfs_branch(lfs, root, path, false, limits, &current.runtime_exclusions)?;
        let found = affected_differences(&expected, &live, path, false);
        if !found.is_empty() {
            conflicts.extend(found);
            continue;
        }

        let (parent, name) = vfs_parent_and_name(lfs, root, path)?;
        if expected
            .entries
            .get(path)
            .is_some_and(|entry| !entry.is_directory())
        {
            let inode = vfs_child(lfs, parent, name)?;
            lfs.write_file(inode, entry.bytes().to_vec())
                .map_err(|_| SyncError::Vfs("write_file"))?;
        } else {
            lfs.add_file(parent, name, entry.bytes().to_vec())
                .map_err(|_| SyncError::Vfs("add_file"))?;
        }
        expected.entries.insert(path.clone(), entry.clone());
    }

    Ok(conflicts.into_iter().collect())
}

fn is_related_to_conflict(path: &Path, conflicts: &BTreeSet<PathBuf>) -> bool {
    conflicts
        .iter()
        .any(|conflict| path.starts_with(conflict) || conflict.starts_with(path))
}

fn affected_differences(
    expected: &SyncBaseline,
    live: &SyncBaseline,
    path: &Path,
    include_descendants: bool,
) -> Vec<PathBuf> {
    expected
        .entries
        .keys()
        .chain(live.entries.keys())
        .filter(|candidate| {
            *candidate == path
                || path.starts_with(*candidate)
                || (include_descendants && candidate.starts_with(path))
        })
        .filter(|candidate| expected.entries.get(*candidate) != live.entries.get(*candidate))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn vfs_parent_and_name<'a>(
    lfs: &LFS,
    root: usize,
    path: &'a Path,
) -> Result<(usize, &'a str), SyncError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SyncError::InvalidPath(path.to_path_buf()))?;
    let mut inode = root;
    if let Some(parent) = path.parent() {
        for component in parent.components() {
            let Component::Normal(component) = component else {
                continue;
            };
            let component = component
                .to_str()
                .ok_or_else(|| SyncError::InvalidPath(path.to_path_buf()))?;
            inode = vfs_child(lfs, inode, component)?;
        }
    }
    Ok((inode, name))
}

fn vfs_child(lfs: &LFS, parent: usize, name: &str) -> Result<usize, SyncError> {
    lfs.read_dir(parent)
        .map_err(|_| SyncError::Vfs("read_dir"))?
        .into_iter()
        .find_map(|(entry_name, inode)| (entry_name == name).then_some(inode))
        .ok_or(SyncError::Vfs("lookup"))
}

fn io_error(error: std::io::Error) -> SyncError {
    SyncError::Io(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_ID: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rubrc-vfs-{name}-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn file_map<const N: usize>(files: [(&str, &[u8]); N]) -> SyncBaseline {
        SyncBaseline {
            entries: files
                .into_iter()
                .map(|(path, bytes)| (PathBuf::from(path), SnapshotEntry::file(bytes.to_vec())))
                .collect(),
            runtime_exclusions: Vec::new(),
        }
    }

    fn tree(entries: &[(&str, Option<&[u8]>)]) -> SyncBaseline {
        SyncBaseline {
            entries: entries
                .iter()
                .map(|(path, bytes)| {
                    let entry = match bytes {
                        Some(bytes) => SnapshotEntry::file(bytes.to_vec()),
                        None => SnapshotEntry::directory(),
                    };
                    (PathBuf::from(path), entry)
                })
                .collect(),
            runtime_exclusions: Vec::new(),
        }
    }

    #[test]
    fn excludes_runtime_and_dependency_trees() {
        for path in [
            "sysroot",
            "target",
            ".cargo/registry",
            ".cargo/git",
            ".git",
            "node_modules",
            ".cache",
        ] {
            assert!(is_excluded(Path::new(path)), "{path}");
        }
        assert!(!is_excluded(Path::new("src/main.rs")));
    }

    #[test]
    fn rejects_entry_and_byte_budgets_before_execution() {
        assert_eq!(check_limits(10_001, 1), Err(SyncError::TooManyEntries));
        assert_eq!(
            check_limits(1, 64 * 1024 * 1024 + 1),
            Err(SyncError::TooManyBytes)
        );
    }

    #[test]
    fn rejects_known_file_size_before_reading_contents() {
        let limits = SyncLimits {
            max_entries: 10,
            max_bytes: 1,
        };

        assert_eq!(check_file_size(0, 2, limits), Err(SyncError::TooManyBytes));
        assert_eq!(check_file_size(1, 1, limits), Err(SyncError::TooManyBytes));
        assert_eq!(check_file_size(0, 1, limits), Ok(1));
    }

    #[test]
    fn host_snapshot_rejects_file_larger_than_remaining_budget() {
        let root = temp_dir("host-byte-limit");
        std::fs::write(root.join("large.bin"), b"12").unwrap();

        let result = snapshot_host(
            &root,
            SyncLimits {
                max_entries: 10,
                max_bytes: 1,
            },
            &[],
        );

        assert_eq!(result, Err(SyncError::TooManyBytes));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn vfs_snapshot_rejects_file_larger_than_remaining_budget() {
        let lfs = LFS::new();
        let root = lfs.add_preopen(".");
        lfs.add_file(root, "large.bin", b"12".to_vec()).unwrap();

        let result = snapshot_vfs(
            &lfs,
            root,
            SyncLimits {
                max_entries: 10,
                max_bytes: 1,
            },
            &[],
        );

        assert_eq!(result, Err(SyncError::TooManyBytes));
    }

    #[test]
    fn rejects_vfs_names_that_can_escape_the_host_root() {
        for name in ["../escape", "/absolute", "nested/name"] {
            assert_eq!(
                validate_vfs_name(name),
                Err(SyncError::InvalidPath(PathBuf::from(name)))
            );
        }
        assert_eq!(validate_vfs_name("safe.txt"), Ok("safe.txt"));
    }

    #[test]
    fn reconciled_tree_respects_caller_limits() {
        let baseline = SyncBaseline::default();
        let child = file_map([("child.txt", b"child")]);
        let current_vfs = file_map([("editor.txt", b"editor")]);

        assert_eq!(
            reconcile_diff_with_limits(
                &baseline,
                &child,
                &current_vfs,
                SyncLimits {
                    max_entries: 1,
                    max_bytes: 1024,
                },
            ),
            Err(SyncError::TooManyEntries)
        );
    }

    #[test]
    fn child_diff_preserves_concurrent_vfs_edit() {
        let baseline = file_map([("shared.txt", b"before")]);
        let child = file_map([("shared.txt", b"child")]);
        let current_vfs = file_map([("shared.txt", b"editor")]);
        let result = reconcile_diff(&baseline, &child, &current_vfs).unwrap();
        assert_eq!(result.conflicts, vec![PathBuf::from("shared.txt")]);
        assert_eq!(result.tree["shared.txt"].bytes(), b"editor");
    }

    #[test]
    fn child_delete_preserves_concurrent_descendant_creation() {
        let baseline = tree(&[("item", None)]);
        let child = SyncBaseline::default();
        let current_vfs = tree(&[("item", None), ("item/editor.txt", Some(b"editor"))]);

        let result = reconcile_diff(&baseline, &child, &current_vfs).unwrap();

        assert_eq!(result.conflicts, vec![PathBuf::from("item/editor.txt")]);
        assert_eq!(result.tree["item/editor.txt"].bytes(), b"editor");
    }

    #[test]
    fn child_type_replacement_preserves_concurrent_descendant_creation() {
        let baseline = tree(&[("item", None)]);
        let child = file_map([("item", b"child")]);
        let current_vfs = tree(&[("item", None), ("item/editor.txt", Some(b"editor"))]);

        let result = reconcile_diff(&baseline, &child, &current_vfs).unwrap();

        assert_eq!(result.conflicts, vec![PathBuf::from("item/editor.txt")]);
        assert!(result.tree["item"].is_directory());
        assert_eq!(result.tree["item/editor.txt"].bytes(), b"editor");
    }

    #[test]
    fn child_diff_creates_updates_and_deletes_files() {
        let baseline = file_map([("update.txt", b"before"), ("delete.txt", b"old")]);
        let child = file_map([("update.txt", b"after"), ("create.txt", b"new")]);
        let current_vfs = baseline.clone();
        let result = reconcile_diff(&baseline, &child, &current_vfs).unwrap();

        assert_eq!(result.tree["update.txt"].bytes(), b"after");
        assert_eq!(result.tree["create.txt"].bytes(), b"new");
        assert!(!result.tree.entries.contains_key(Path::new("delete.txt")));
        assert!(result.conflicts.is_empty());
    }

    #[test]
    fn child_diff_replaces_file_with_directory() {
        let baseline = file_map([("item", b"file")]);
        let child = tree(&[("item", None), ("item/nested.txt", Some(b"nested"))]);
        let result = reconcile_diff(&baseline, &child, &baseline).unwrap();

        assert!(result.tree["item"].is_directory());
        assert_eq!(result.tree["item/nested.txt"].bytes(), b"nested");
    }

    #[test]
    fn child_diff_replaces_directory_with_file() {
        let baseline = tree(&[("item", None), ("item/nested.txt", Some(b"nested"))]);
        let child = file_map([("item", b"file")]);
        let result = reconcile_diff(&baseline, &child, &baseline).unwrap();

        assert_eq!(result.tree["item"].bytes(), b"file");
        assert!(
            !result
                .tree
                .entries
                .contains_key(Path::new("item/nested.txt"))
        );
    }

    #[test]
    fn applies_directory_to_file_replacement_to_vfs() {
        let lfs = LFS::new();
        let root = lfs.add_preopen(".");
        let item = lfs.add_dir(root, "item").unwrap();
        lfs.add_file(item, "nested.txt", b"nested".to_vec())
            .unwrap();
        let current = snapshot_vfs(&lfs, root, DEFAULT_SYNC_LIMITS, &[]).unwrap();
        let desired = file_map([("item", b"file")]);

        apply_vfs_snapshot(&lfs, root, &current, &desired).unwrap();

        let actual = snapshot_vfs(&lfs, root, DEFAULT_SYNC_LIMITS, &[]).unwrap();
        assert_eq!(actual, desired);
    }

    #[test]
    fn mutation_time_recheck_preserves_concurrent_file_edit() {
        let lfs = LFS::new();
        let root = lfs.add_preopen(".");
        lfs.add_file(root, "a.txt", b"before".to_vec()).unwrap();
        let b_inode = lfs.add_file(root, "b.txt", b"before".to_vec()).unwrap();
        let baseline = snapshot_vfs(&lfs, root, DEFAULT_SYNC_LIMITS, &[]).unwrap();
        let child = file_map([("a.txt", b"child"), ("b.txt", b"child")]);
        let desired = reconcile_diff(&baseline, &child, &baseline).unwrap().tree;
        let mut edited = false;

        let conflicts = apply_vfs_snapshot_rechecked(
            &lfs,
            root,
            &baseline,
            &desired,
            DEFAULT_SYNC_LIMITS,
            |path| {
                if path == Path::new("b.txt") && !edited {
                    lfs.write_file(b_inode, b"editor".to_vec()).unwrap();
                    edited = true;
                }
            },
        )
        .unwrap();

        assert_eq!(conflicts, vec![PathBuf::from("b.txt")]);
        let actual = snapshot_vfs(&lfs, root, DEFAULT_SYNC_LIMITS, &[]).unwrap();
        assert_eq!(actual["a.txt"].bytes(), b"child");
        assert_eq!(actual["b.txt"].bytes(), b"editor");
    }

    #[test]
    fn mutation_time_recheck_preserves_descendant_created_before_parent_delete() {
        let lfs = LFS::new();
        let root = lfs.add_preopen(".");
        let item = lfs.add_dir(root, "item").unwrap();
        let baseline = snapshot_vfs(&lfs, root, DEFAULT_SYNC_LIMITS, &[]).unwrap();
        let desired = SyncBaseline::default();
        let mut created = false;

        let conflicts = apply_vfs_snapshot_rechecked(
            &lfs,
            root,
            &baseline,
            &desired,
            DEFAULT_SYNC_LIMITS,
            |path| {
                if path == Path::new("item") && !created {
                    lfs.add_file(item, "editor.txt", b"editor".to_vec())
                        .unwrap();
                    created = true;
                }
            },
        )
        .unwrap();

        assert_eq!(conflicts, vec![PathBuf::from("item/editor.txt")]);
        let actual = snapshot_vfs(&lfs, root, DEFAULT_SYNC_LIMITS, &[]).unwrap();
        assert_eq!(actual["item/editor.txt"].bytes(), b"editor");
    }

    #[test]
    fn mutation_recheck_snapshots_only_the_affected_branch() {
        let lfs = LFS::new();
        let root = lfs.add_preopen(".");
        let item = lfs.add_dir(root, "item").unwrap();
        lfs.add_file(item, "child.txt", b"child".to_vec()).unwrap();
        lfs.add_file(root, "unrelated.txt", b"unrelated".to_vec())
            .unwrap();

        let branch = snapshot_vfs_branch(
            &lfs,
            root,
            Path::new("item/child.txt"),
            false,
            DEFAULT_SYNC_LIMITS,
            &[],
        )
        .unwrap();

        assert!(branch.entries.contains_key(Path::new("item")));
        assert!(branch.entries.contains_key(Path::new("item/child.txt")));
        assert!(!branch.entries.contains_key(Path::new("unrelated.txt")));
    }

    #[test]
    fn mutation_time_recheck_reports_parent_removed_before_child_add() {
        let lfs = LFS::new();
        let root = lfs.add_preopen(".");
        lfs.add_dir(root, "item").unwrap();
        let baseline = snapshot_vfs(&lfs, root, DEFAULT_SYNC_LIMITS, &[]).unwrap();
        let desired = tree(&[("item", None), ("item/child.txt", Some(b"child"))]);
        let mut removed = false;

        let conflicts = apply_vfs_snapshot_rechecked(
            &lfs,
            root,
            &baseline,
            &desired,
            DEFAULT_SYNC_LIMITS,
            |path| {
                if path == Path::new("item/child.txt") && !removed {
                    lfs.remove_dir(root, "item").unwrap();
                    removed = true;
                }
            },
        )
        .unwrap();

        assert_eq!(conflicts, vec![PathBuf::from("item")]);
        assert!(
            lfs.read_dir(root)
                .unwrap()
                .iter()
                .all(|(name, _)| name != "item")
        );
    }

    #[test]
    fn authoritative_recovery_replaces_the_entire_tree() {
        let current = tree(&[("stale", None), ("stale/file", Some(b"old"))]);
        let host = tree(&[("src", None), ("src/main.rs", Some(b"fn main() {}"))]);

        let recovered = reconcile_authoritative(&host, &current).unwrap();

        assert_eq!(recovered, host);
    }

    #[test]
    fn normalizes_explicit_cargo_target_directory() {
        assert_eq!(
            runtime_exclusions_from_child(
                Some(Path::new("./build/../cargo-target")),
                Path::new("ignored.wasm"),
            ),
            vec![PathBuf::from("cargo-target")]
        );
    }

    #[test]
    fn infers_custom_target_directory_from_executable() {
        assert_eq!(
            runtime_exclusions_from_child(
                None,
                Path::new("build-output/wasm32-wasip1/debug/app.wasm"),
            ),
            vec![PathBuf::from("build-output")]
        );
    }

    #[test]
    fn preserves_parent_directories_of_runtime_exclusions() {
        assert!(contains_exclusion(
            Path::new("workspace"),
            &[PathBuf::from("workspace/build-output")],
        ));
        assert!(!contains_exclusion(
            Path::new("src"),
            &[PathBuf::from("workspace/build-output")],
        ));
    }

    #[test]
    fn fixed_exclusion_children_do_not_block_cargo_parent_reconciliation() {
        let root = temp_dir("fixed-exclusions");
        std::fs::create_dir_all(root.join(".cargo/registry")).unwrap();
        std::fs::create_dir_all(root.join(".cargo/git")).unwrap();
        std::fs::write(root.join(".cargo/registry/cache"), b"registry").unwrap();
        std::fs::write(root.join(".cargo/git/db"), b"git").unwrap();
        std::fs::write(root.join(".cargo/config.toml"), b"remove me").unwrap();
        let current = snapshot_host(&root, DEFAULT_SYNC_LIMITS, &[]).unwrap();

        apply_host_snapshot(&root, &current, &SyncBaseline::default()).unwrap();

        assert!(root.join(".cargo/registry/cache").is_file());
        assert!(root.join(".cargo/git/db").is_file());
        assert!(!root.join(".cargo/config.toml").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn root_lookup_initializes_the_global_vfs() {
        let root = crate::initialized_lfs_root();

        assert!(crate::VIRTUAL_FILE_SYSTEM.lfs.read_dir(root).is_ok());
    }
}
