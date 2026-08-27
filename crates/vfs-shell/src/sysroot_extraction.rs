use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

static SYSROOT_LOAD_LOCK: Mutex<()> = Mutex::new(());

// Rust archive paths are far shorter than 4 KiB; cap host-controlled allocation accordingly.
const MAX_SYSROOT_ENTRY_NAME_LEN: usize = 4096;
const MAX_SYSROOT_ARCHIVE_READ_LEN: usize = 512 * 1024;

pub(crate) struct SysrootArchiveReader<C, F> {
    remaining: usize,
    is_cancelled: C,
    read_chunk: F,
}

impl<C, F> SysrootArchiveReader<C, F> {
    pub(crate) fn new(archive_len: usize, is_cancelled: C, read_chunk: F) -> Self {
        Self {
            remaining: archive_len,
            is_cancelled,
            read_chunk,
        }
    }
}

impl<C, F> std::io::Read for SysrootArchiveReader<C, F>
where
    C: FnMut() -> bool,
    F: FnMut(&mut [u8]) -> std::io::Result<()>,
{
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let to_read = std::cmp::min(
            self.remaining,
            std::cmp::min(buffer.len(), MAX_SYSROOT_ARCHIVE_READ_LEN),
        );
        if to_read == 0 {
            return Ok(0);
        }
        if (self.is_cancelled)() {
            return Err(std::io::Error::other(
                "additional sysroot request cancelled",
            ));
        }
        (self.read_chunk)(&mut buffer[..to_read])?;
        self.remaining -= to_read;
        Ok(to_read)
    }
}

pub(crate) fn with_sysroot_load_lock<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = SYSROOT_LOAD_LOCK
        .lock()
        .map_err(|_| "sysroot load lock was poisoned".to_string())?;
    operation()
}

pub(crate) fn sysroot_meta_has_file(status: i32, triple: &str) -> Result<bool, String> {
    match status {
        1 => Ok(true),
        0 => Ok(false),
        -1 => Err(format!("failed to fetch sysroot archive for '{triple}'")),
        _ => Err(format!(
            "invalid sysroot archive status {status} for '{triple}'"
        )),
    }
}

pub(crate) fn sysroot_entry_name_len(name_len: i32) -> Result<usize, String> {
    let name_len = usize::try_from(name_len)
        .map_err(|_| format!("invalid sysroot archive entry name length: {name_len}"))?;
    if name_len > MAX_SYSROOT_ENTRY_NAME_LEN {
        return Err(format!(
            "sysroot archive entry name length {name_len} exceeds maximum {MAX_SYSROOT_ENTRY_NAME_LEN} bytes"
        ));
    }
    Ok(name_len)
}

pub(crate) fn sysroot_entry_path(base_dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name == "." || name == "./" {
        return Ok(base_dir.to_path_buf());
    }
    let mut relative = PathBuf::new();
    for component in Path::new(name).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("unsafe sysroot archive entry: {name}"));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(format!("unsafe sysroot archive entry: {name}"));
    }
    Ok(base_dir.join(relative))
}

pub(crate) fn write_sysroot_entry(
    base_dir: &Path,
    name_bytes: Vec<u8>,
    data: Option<&[u8]>,
) -> Result<(), String> {
    let name = String::from_utf8(name_bytes)
        .map_err(|error| format!("failed to decode sysroot file name: {error}"))?;
    let file_path = sysroot_entry_path(base_dir, &name)?;
    match data {
        None => std::fs::create_dir_all(&file_path)
            .map_err(|error| format!("failed to create sysroot directory '{name}': {error}")),
        Some(data) => {
            if let Some(parent) = file_path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    format!("failed to create parent directory for sysroot file '{name}': {error}")
                })?;
            }
            std::fs::write(&file_path, data)
                .map_err(|error| format!("failed to write sysroot file '{name}': {error}"))
        }
    }
}

pub(crate) fn extract_sysroot_archive<R: std::io::Read>(
    base_dir: &Path,
    archive_reader: R,
) -> Result<(usize, usize), String> {
    let mut archive = tar::Archive::new(archive_reader);
    let mut files_loaded = 0usize;
    let mut total_bytes = 0usize;

    let entries = archive
        .entries()
        .map_err(|error| format!("failed to read sysroot archive entries: {error}"))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("failed to decode sysroot archive entry: {error}"))?;
        let entry_type = entry.header().entry_type();
        let entry_path = entry
            .path()
            .map_err(|error| format!("failed to read sysroot archive path: {error}"))?;
        let entry_name = entry_path.to_string_lossy().to_string();
        let file_path = sysroot_entry_path(base_dir, entry_name.as_ref())?;

        if entry_type.is_dir() {
            std::fs::create_dir_all(&file_path).map_err(|error| {
                format!(
                    "failed to create sysroot directory '{}': {error}",
                    entry_name
                )
            })?;
            continue;
        }
        if !entry_type.is_file() {
            return Err(format!(
                "unsupported sysroot archive entry type for '{}': {:?}",
                entry_name, entry_type
            ));
        }

        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create parent directory for sysroot file '{}': {error}",
                    entry_name
                )
            })?;
        }
        let mut output = std::fs::File::create(&file_path)
            .map_err(|error| format!("failed to create sysroot file '{}': {error}", entry_name))?;
        let copied = std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("failed to extract sysroot file '{}': {error}", entry_name))?
            as usize;
        files_loaded += 1;
        total_bytes += copied;
    }
    let mut archive_reader = archive.into_inner();
    std::io::copy(&mut archive_reader, &mut std::io::sink())
        .map_err(|error| format!("failed to finish reading sysroot archive: {error}"))?;
    Ok((files_loaded, total_bytes))
}

#[cfg(test)]
mod tests {
    use super::{
        SysrootArchiveReader, extract_sysroot_archive, sysroot_entry_name_len, sysroot_entry_path,
        sysroot_meta_has_file, with_sysroot_load_lock, write_sysroot_entry,
    };
    use std::fs;
    use std::io::Read;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "rubrc-sysroot-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn accepts_maximum_sysroot_entry_name_length() {
        assert_eq!(sysroot_entry_name_len(4096).unwrap(), 4096);
    }

    #[test]
    fn rejects_oversized_sysroot_entry_name_length() {
        let error = sysroot_entry_name_len(4097).unwrap_err();
        assert!(error.contains("4097"), "unexpected error: {error}");
        assert!(error.contains("4096"), "unexpected error: {error}");
    }

    #[test]
    fn archive_reader_streams_only_the_reported_bytes() {
        let source = b"streamed archive";
        let mut source_offset = 0usize;
        let mut requested_lengths = Vec::new();
        let mut output = Vec::new();
        {
            let mut reader = SysrootArchiveReader::new(
                source.len(),
                || false,
                |buffer: &mut [u8]| {
                    requested_lengths.push(buffer.len());
                    let end = source_offset + buffer.len();
                    buffer.copy_from_slice(&source[source_offset..end]);
                    source_offset = end;
                    Ok(())
                },
            );
            let mut buffer = [0u8; 3];
            reader.read_to_end(&mut output).unwrap();
            assert_eq!(reader.read(&mut buffer).unwrap(), 0);
        }

        assert_eq!(output, source);
        assert_eq!(source_offset, source.len());
        assert!(
            requested_lengths
                .iter()
                .all(|length| *length <= source.len())
        );
    }

    #[test]
    fn archive_reader_stops_before_archive_eof_when_chunk_callback_cancels() {
        use std::cell::Cell;

        let chunks = Cell::new(0);
        let mut reader = SysrootArchiveReader::new(
            1024 * 1024,
            || chunks.get() == 1,
            |_buffer: &mut [u8]| {
                chunks.set(chunks.get() + 1);
                Ok(())
            },
        );
        let error = std::io::copy(&mut reader, &mut std::io::sink()).unwrap_err();
        assert_eq!(error.to_string(), "additional sysroot request cancelled");
        assert_eq!(chunks.get(), 1);
    }

    #[test]
    fn rejects_absolute_parent_and_nested_escape_paths() {
        let base = PathBuf::from("/sysroot/lib");
        for name in ["/absolute", "..", "../escape", "nested/../../escape"] {
            assert!(
                sysroot_entry_path(&base, name).is_err(),
                "accepted unsafe entry {name}"
            );
        }
    }

    #[test]
    fn accepts_archive_root_directory_marker() {
        let base = PathBuf::from("/sysroot/lib");
        assert_eq!(sysroot_entry_path(&base, ".").unwrap(), base);
    }

    #[test]
    fn rejects_invalid_utf8_file_names() {
        let error = write_sysroot_entry(&PathBuf::from("/sysroot/lib"), vec![0xff], Some(&[1]))
            .unwrap_err();
        assert!(error.contains("decode"), "unexpected error: {error}");
    }

    #[test]
    fn propagates_directory_creation_failure() {
        let base = temp_path("directory-error");
        fs::write(&base, b"not a directory").unwrap();
        let result = write_sysroot_entry(&base, b"nested".to_vec(), None);
        let _ = fs::remove_file(&base);
        assert!(result.is_err());
    }

    #[test]
    fn propagates_file_write_failure() {
        let base = temp_path("write-error");
        fs::create_dir_all(base.join("existing-directory")).unwrap();
        let result = write_sysroot_entry(
            &base,
            b"existing-directory".to_vec(),
            Some(b"file contents"),
        );
        let _ = fs::remove_dir_all(&base);
        assert!(result.is_err());
    }

    #[test]
    fn serializes_complete_sysroot_transactions() {
        let start = Arc::new(Barrier::new(5));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let workers = (0..4)
            .map(|_| {
                let start = Arc::clone(&start);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                std::thread::spawn(move || {
                    start.wait();
                    with_sysroot_load_lock(|| {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(current, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(5));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        start.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_host_archive_status_fails_the_extraction() {
        assert!(sysroot_meta_has_file(1, "rust-src").unwrap());
        assert!(!sysroot_meta_has_file(0, "rust-src").unwrap());
        let error = sysroot_meta_has_file(-1, "rust-src").unwrap_err();
        assert!(error.contains("rust-src"), "unexpected error: {error}");
    }

    #[test]
    fn extracts_safe_tar_entries_into_the_sysroot_base() {
        let base = temp_path("extract-archive");
        fs::create_dir_all(&base).unwrap();

        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        let file_data = b"fn main() {}\n";
        header.set_size(file_data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "core/src/lib.rs", &file_data[..])
            .unwrap();
        let archive_data = archive.into_inner().unwrap();

        let (files_loaded, total_bytes) =
            extract_sysroot_archive(&base, archive_data.as_slice()).unwrap();
        assert_eq!(files_loaded, 1);
        assert_eq!(total_bytes, file_data.len());
        assert_eq!(
            fs::read(base.join("core/src/lib.rs")).unwrap(),
            file_data.to_vec()
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_unsafe_tar_entry_paths() {
        let base = temp_path("extract-unsafe");
        fs::create_dir_all(&base).unwrap();

        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        let file_data = b"unsafe";
        header.set_size(file_data.len() as u64);
        header.set_mode(0o644);
        let path = b"../escape.rs";
        header.as_mut_bytes()[..path.len()].copy_from_slice(path);
        header.set_cksum();
        archive.append(&header, &file_data[..]).unwrap();
        let archive_data = archive.into_inner().unwrap();

        let error = extract_sysroot_archive(&base, archive_data.as_slice()).unwrap_err();
        assert!(error.contains("unsafe"), "unexpected error: {error}");

        let _ = fs::remove_dir_all(&base);
    }
}
