use crate::sysroot_extraction::{SysrootArchiveReader, extract_sysroot_archive};
use std::cell::{Cell, RefCell};
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const B: usize = 64 * 1024;
const MAX_READ: usize = 512 * 1024;

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * 31 + i / 251) % 256) as u8).collect()
}

fn assert_requests(lengths: &[usize], n: usize) {
    assert_eq!(lengths.iter().sum::<usize>(), n);
    assert!(lengths.iter().all(|&n| n > 0 && n <= MAX_READ));
    #[cfg(feature = "sysroot-read-coalescing")]
    {
        assert_eq!(lengths.len(), n.div_ceil(B));
        for (i, &len) in lengths.iter().enumerate() {
            assert_eq!(len, (n - i * B).min(B));
        }
    }
}

#[test]
fn exact_bytes_counts_and_order_for_small_large_and_variable_reads() {
    for n in [
        0,
        1,
        B - 1,
        B,
        B + 1,
        2 * B,
        2 * B + 17,
        9 * B + 13,
        1024 * 1024,
    ] {
        for schedule in [
            vec![1],
            vec![512],
            vec![8192],
            vec![B],
            vec![MAX_READ + 19],
            vec![1, 511, 7, 8192, B + 7, 3, MAX_READ + 19],
        ] {
            let input = pattern(n);
            let mut offset = 0;
            let mut lengths = Vec::new();
            // Models the existing wrapper's append-on-fetch side effect, NOT a real mount.
            let mut appended = Vec::new();
            let checks = Cell::new(0);
            let mut output = Vec::new();
            {
                let mut reader = SysrootArchiveReader::new(
                    n,
                    || {
                        checks.set(checks.get() + 1);
                        false
                    },
                    |buffer: &mut [u8]| {
                        lengths.push(buffer.len());
                        buffer.copy_from_slice(&input[offset..offset + buffer.len()]);
                        appended.extend_from_slice(buffer);
                        offset += buffer.len();
                        Ok(())
                    },
                );
                let mut buffer = vec![0; *schedule.iter().max().unwrap()];
                let mut step = 0;
                loop {
                    let before = checks.get();
                    assert_eq!(reader.read(&mut []).unwrap(), 0);
                    assert_eq!(checks.get(), before);
                    let got = reader
                        .read(&mut buffer[..schedule[step % schedule.len()]])
                        .unwrap();
                    if got == 0 {
                        assert_eq!(checks.get(), before);
                        break;
                    }
                    assert_eq!(checks.get(), before + 1);
                    output.extend_from_slice(&buffer[..got]);
                    step += 1;
                }
                let before = checks.get();
                for _ in 0..3 {
                    assert_eq!(reader.read(&mut buffer).unwrap(), 0);
                }
                assert_eq!(checks.get(), before);
            }
            assert_eq!(output, input, "N={n}, schedule={schedule:?}");
            assert_eq!(appended, input);
            assert_eq!(offset, n);
            assert_requests(&lengths, n);
        }
    }
}

#[test]
fn cancellation_before_first_fetch_empty_and_eof_do_not_probe() {
    let calls = Cell::new(0);
    let probes = Cell::new(0);
    let mut reader = SysrootArchiveReader::new(
        1,
        || {
            probes.set(probes.get() + 1);
            true
        },
        |_: &mut [u8]| {
            calls.set(calls.get() + 1);
            Ok(())
        },
    );
    assert_eq!(reader.read(&mut []).unwrap(), 0);
    assert_eq!(probes.get(), 0);
    let mut out = [42];
    let err = reader.read(&mut out).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "additional sysroot request cancelled");
    assert_eq!(out, [42]);
    assert_eq!(probes.get(), 1);
    assert_eq!(calls.get(), 0);

    let mut reader = SysrootArchiveReader::new(
        0,
        || panic!("EOF probe"),
        |_: &mut [u8]| -> io::Result<()> { panic!("EOF fetch") },
    );
    assert_eq!(reader.read(&mut out).unwrap(), 0);
    assert_eq!(reader.read(&mut []).unwrap(), 0);
}

#[test]
fn cancellation_with_unfetched_or_final_cached_tail_never_delivers_more() {
    for n in [B, B + 1, 2 * B + 17] {
        let cancelled = Cell::new(false);
        let calls = Cell::new(0);
        let fetched = Cell::new(0);
        let mut reader = SysrootArchiveReader::new(
            n,
            || cancelled.get(),
            |out: &mut [u8]| {
                calls.set(calls.get() + 1);
                fetched.set(fetched.get() + out.len());
                out.fill(7);
                Ok(())
            },
        );
        assert_eq!(reader.read(&mut [0]).unwrap(), 1);
        #[cfg(feature = "sysroot-read-coalescing")]
        assert_eq!(fetched.get(), B);
        cancelled.set(true);
        assert_eq!(reader.read(&mut []).unwrap(), 0);
        let mut out = [42; 17];
        let err = reader.read(&mut out).unwrap_err();
        assert_eq!(err.to_string(), "additional sysroot request cancelled");
        assert_eq!(out, [42; 17]);
        assert_eq!(calls.get(), 1);
    }
}

#[test]
fn cancellation_during_callback_is_seen_at_next_logical_read_not_in_flight() {
    let cancelled = Cell::new(false);
    let calls = Cell::new(0);
    let mut reader = SysrootArchiveReader::new(
        B,
        || cancelled.get(),
        |out: &mut [u8]| {
            calls.set(calls.get() + 1);
            cancelled.set(true);
            out.fill(9);
            Ok(())
        },
    );
    let mut first = [0];
    assert_eq!(reader.read(&mut first).unwrap(), 1);
    assert_eq!(first, [9]);
    assert!(reader.read(&mut [0]).is_err());
    assert_eq!(calls.get(), 1);

    // Existing semantics permit success if cancellation is only observable at true EOF.
    cancelled.set(false);
    let mut reader = SysrootArchiveReader::new(
        1,
        || cancelled.get(),
        |out: &mut [u8]| {
            out[0] = 5;
            cancelled.set(true);
            Ok(())
        },
    );
    assert_eq!(reader.read(&mut first).unwrap(), 1);
    assert!(cancelled.get());
    assert_eq!(reader.read(&mut first).unwrap(), 0);
}

#[test]
fn cancellation_before_last_refill_does_not_fetch_it() {
    let cancelled = Cell::new(false);
    let calls = Cell::new(0);
    let mut reader = SysrootArchiveReader::new(
        B + 1,
        || cancelled.get(),
        |out: &mut [u8]| {
            calls.set(calls.get() + 1);
            out.fill(0);
            Ok(())
        },
    );
    reader.read_exact(&mut vec![0; B]).unwrap();
    cancelled.set(true);
    assert!(reader.read(&mut [0]).is_err());
    assert_eq!(calls.get(), 1);
}

#[test]
fn callback_failure_preserves_error_and_copy_does_not_retry() {
    for fail_at in [1, 2, 3] {
        let calls = Cell::new(0);
        let successful = Cell::new(0);
        let mut reader = SysrootArchiveReader::new(
            4 * B,
            || false,
            |out: &mut [u8]| {
                calls.set(calls.get() + 1);
                if calls.get() == fail_at {
                    out.fill(99); // A failed callback may have partially written the cache.
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "injected short host read",
                    ));
                }
                out.fill(7);
                successful.set(successful.get() + out.len());
                Ok(())
            },
        );
        let mut output = Vec::new();
        let error = io::copy(&mut reader, &mut output).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(error.to_string(), "injected short host read");
        assert_eq!(calls.get(), fail_at);
        assert_eq!(output.len(), successful.get());
        assert!(output.iter().all(|&x| x == 7));
        #[cfg(feature = "sysroot-read-coalescing")]
        assert_eq!(successful.get(), (fail_at - 1) * B);
    }
}

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "rubrc-coalescing-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        // create_dir (not create_dir_all) rejects an existing path before cleanup is armed.
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        // Only the uniquely created direct child of temp_dir above is removed.
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn fixture() -> (Vec<u8>, Vec<u8>) {
    let large = pattern(2 * B + 17);
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Directory);
    header.set_size(0);
    header.set_mode(0o755);
    header.set_cksum();
    builder
        .append_data(&mut header, "nested/", io::empty())
        .unwrap();
    for (path, data) in [
        ("nested/empty", &[][..]),
        ("nested/small", &b"abc"[..]),
        ("nested/large", large.as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, data).unwrap();
    }
    let mut bytes = builder.into_inner().unwrap();
    bytes.extend_from_slice(&pattern(B + 37)); // Must drain beyond tar terminators.
    (bytes, large)
}

#[test]
fn full_extraction_drains_same_reader_including_prefetched_and_unfetched_trailing_bytes() {
    let dir = TestDir::new();
    let (bytes, large) = fixture();
    let mut offset = 0;
    let mut lengths = Vec::new();
    let reader = SysrootArchiveReader::new(
        bytes.len(),
        || false,
        |out: &mut [u8]| {
            lengths.push(out.len());
            out.copy_from_slice(&bytes[offset..offset + out.len()]);
            offset += out.len();
            Ok(())
        },
    );
    assert_eq!(
        extract_sysroot_archive(&dir.0, reader).unwrap(),
        (3, large.len() + 3)
    );
    assert_eq!(std::fs::read(dir.0.join("nested/large")).unwrap(), large);
    assert_eq!(std::fs::read(dir.0.join("nested/small")).unwrap(), b"abc");
    assert!(
        std::fs::read(dir.0.join("nested/empty"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(offset, bytes.len());
    assert_requests(&lengths, bytes.len());
}

#[test]
fn truncated_tar_payload_or_short_host_stream_cannot_succeed() {
    let (bytes, _) = fixture();
    for (available, reported) in [(2660, 2660), (B + 3, bytes.len())] {
        let dir = TestDir::new();
        let offset = Cell::new(0);
        let failures = Cell::new(0);
        let reader = SysrootArchiveReader::new(
            reported,
            || false,
            |out: &mut [u8]| {
                let end = offset.get() + out.len();
                if end > available {
                    failures.set(failures.get() + 1);
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "truncated host archive",
                    ));
                }
                out.copy_from_slice(&bytes[offset.get()..end]);
                offset.set(end);
                Ok(())
            },
        );
        let err = extract_sysroot_archive(&dir.0, reader).unwrap_err();
        if available != reported {
            assert!(err.contains("truncated host archive"), "{err}");
            assert_eq!(failures.get(), 1);
        }
    }
}

#[test]
fn extraction_propagates_first_and_later_callback_failure_without_retry() {
    let (bytes, _) = fixture();
    for fail_at in [1, 2] {
        let dir = TestDir::new();
        let mut offset = 0;
        let calls = Cell::new(0);
        let reader = SysrootArchiveReader::new(
            bytes.len(),
            || false,
            |out: &mut [u8]| {
                calls.set(calls.get() + 1);
                if calls.get() == fail_at {
                    return Err(io::Error::other("injected extraction failure"));
                }
                out.copy_from_slice(&bytes[offset..offset + out.len()]);
                offset += out.len();
                Ok(())
            },
        );
        let err = extract_sysroot_archive(&dir.0, reader).unwrap_err();
        assert!(err.contains("injected extraction failure"), "{err}");
        assert_eq!(calls.get(), fail_at);
    }
}

#[test]
fn extraction_rejects_unsupported_type_and_file_creation_failure() {
    let dir = TestDir::new();
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    header.set_link_name("target").unwrap();
    header.set_cksum();
    builder
        .append_data(&mut header, "link", io::empty())
        .unwrap();
    let bytes = builder.into_inner().unwrap();
    let cursor = RefCell::new(io::Cursor::new(bytes.as_slice()));
    let reader = SysrootArchiveReader::new(
        bytes.len(),
        || false,
        |out: &mut [u8]| cursor.borrow_mut().read_exact(out),
    );
    assert!(
        extract_sysroot_archive(&dir.0, reader)
            .unwrap_err()
            .contains("unsupported")
    );

    let (bytes, _) = fixture();
    std::fs::create_dir_all(dir.0.join("nested/empty")).unwrap();
    let cursor = RefCell::new(io::Cursor::new(bytes.as_slice()));
    let reader = SysrootArchiveReader::new(
        bytes.len(),
        || false,
        |out: &mut [u8]| cursor.borrow_mut().read_exact(out),
    );
    assert!(
        extract_sysroot_archive(&dir.0, reader)
            .unwrap_err()
            .contains("failed to create sysroot file")
    );
}

#[test]
#[cfg(feature = "sysroot-read-coalescing")]
fn cancellation_during_final_prefetch_is_observed_in_post_tar_drain() {
    let dir = TestDir::new();
    // Empty tar's first header is a terminator; its final prefetched tail still must be drained.
    let bytes = vec![0; 2048];
    let cancelled = Cell::new(false);
    let calls = Cell::new(0);
    let reader = SysrootArchiveReader::new(
        bytes.len(),
        || cancelled.get(),
        |out: &mut [u8]| {
            assert_eq!(out.len(), bytes.len());
            out.copy_from_slice(&bytes);
            calls.set(calls.get() + 1);
            cancelled.set(true);
            Ok(())
        },
    );
    let err = extract_sysroot_archive(&dir.0, reader).unwrap_err();
    assert!(
        err.contains("additional sysroot request cancelled"),
        "{err}"
    );
    assert!(err.contains("finish reading"), "{err}");
    assert_eq!(calls.get(), 1);
}
