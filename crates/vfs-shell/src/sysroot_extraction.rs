use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

static SYSROOT_LOAD_LOCK: Mutex<()> = Mutex::new(());

// Rust archive paths are far shorter than 4 KiB; cap host-controlled allocation accordingly.
const MAX_SYSROOT_ENTRY_NAME_LEN: usize = 4096;

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

#[cfg(test)]
mod tests {
    use super::{
        sysroot_entry_name_len, sysroot_entry_path, sysroot_meta_has_file, with_sysroot_load_lock,
        write_sysroot_entry,
    };
    use std::fs;
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
}
