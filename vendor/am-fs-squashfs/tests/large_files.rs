//! Large-file read tests: multi-block files, mid-file offset reads, and the
//! full-block-then-fragment-tail mix.
//!
//! The committed `test-disks/squashfs-basic.sqfs` fixture's
//! `/sub/deep/big.bin` (20000 bytes over 4096-byte blocks: 4 full blocks
//! then a tail fragment) gives non-`#[ignore]` multi-block coverage that
//! runs under a plain `cargo test`. The larger / multi-megabyte /
//! per-compressor cases need `mksquashfs` and are `#[ignore]`-gated; run
//! them with:
//!
//! ```sh
//! cargo test --release --test large_files -- --ignored
//! ```

mod common;

use common::*;

const BIG_LEN: usize = 20000;

// ===========================================================================
// Committed-fixture coverage (no external tools)
// ===========================================================================

#[test]
fn committed_big_bin_full_content() {
    let fs = open_image_path(&basic_fixture_path());
    let got = read_whole_file(&fs, "/sub/deep/big.bin");
    assert_eq!(got.len(), BIG_LEN);
    assert_eq!(got, basic_big_bin(), "multi-block + fragment content");
}

#[test]
fn committed_big_bin_offset_reads_at_every_boundary() {
    let fs = open_image_path(&basic_fixture_path());
    let inode = fs.lookup_path("/sub/deep/big.bin").unwrap();
    let want = basic_big_bin();

    // 4096-byte blocks: probe just-before / on / just-after each boundary,
    // the start of the tail fragment (16384), and mid-fragment.
    for &off in &[
        0usize, 1, 4095, 4096, 4097, 8191, 8192, 12288, 16383, 16384, 16385, 18000, 19999,
    ] {
        let len = 256.min(BIG_LEN - off);
        let mut buf = vec![0u8; len];
        let n = fs.read_file(&inode, off as u64, &mut buf).unwrap();
        assert_eq!(n, len, "short read at offset {off}");
        assert_eq!(buf, &want[off..off + len], "content at offset {off}");
    }
}

#[test]
fn committed_big_bin_read_crossing_block_into_fragment() {
    // A single window 16000..17000 spans the last full block (ends 16384)
    // into the fragment tail — the block→fragment seam.
    let fs = open_image_path(&basic_fixture_path());
    let inode = fs.lookup_path("/sub/deep/big.bin").unwrap();
    let want = basic_big_bin();
    let mut buf = vec![0u8; 1000];
    let n = fs.read_file(&inode, 16000, &mut buf).unwrap();
    assert_eq!(n, 1000);
    assert_eq!(buf, &want[16000..17000]);
}

// ===========================================================================
// Oracle-built large files (require mksquashfs) — exercise the default
// 128 KiB block size so files span many full blocks before the tail.
// ===========================================================================

/// Build a single-file image of `size` bytes (LCG pattern) with the given
/// compressor and read it all back + spot-check offsets. Returns early
/// (skips) when `mksquashfs` isn't installed.
fn assert_large_file_round_trip(comp: &str, size: usize) {
    if !mksquashfs_available() {
        eprintln!("skipping {comp}/{size}: mksquashfs not on PATH");
        return;
    }
    let tree = dir(vec![("big.bin", file(&pattern(size)))]);
    let art = build_with_mksquashfs(comp, &tree);
    let fs = open_image(art.bytes.clone());
    let want = pattern(size);

    // Full read-back.
    let got = read_whole_file(&fs, "/big.bin");
    assert_eq!(got.len(), size, "[{comp}] big.bin length");
    assert_eq!(got, want, "[{comp}] big.bin full content");

    // Mid-file offset reads around 128 KiB block boundaries.
    let inode = fs.lookup_path("/big.bin").unwrap();
    let bs = fs.sb.block_size as usize;
    for &off in &[0usize, 1, bs - 1, bs, bs + 1, 2 * bs, size / 2] {
        if off >= size {
            continue;
        }
        let len = 777.min(size - off);
        let mut buf = vec![0u8; len];
        let n = fs.read_file(&inode, off as u64, &mut buf).unwrap();
        assert_eq!(n, len, "[{comp}] short read at {off}");
        assert_eq!(buf, &want[off..off + len], "[{comp}] content at {off}");
    }

    // Strict cross-check against unsquashfs itself.
    if unsquashfs_available() {
        let via_oracle = unsquashfs_extract_file(&art.path, "/big.bin");
        assert_eq!(via_oracle, got, "[{comp}] driver vs unsquashfs");
    }
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn large_file_300k_gzip() {
    // ~2.3 blocks at the default 128 KiB block size: multiple full blocks
    // plus a tail fragment.
    assert_large_file_round_trip("gzip", 300_000);
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn large_file_1m_gzip() {
    assert_large_file_round_trip("gzip", 1024 * 1024);
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn large_file_block_aligned_gzip() {
    // Exactly two full 128 KiB blocks, no tail fragment — the file ends on
    // a block boundary so there is no fragment at all.
    assert_large_file_round_trip("gzip", 2 * 128 * 1024);
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn large_file_one_byte_over_block_gzip() {
    // One byte past a single full block: forces a 1-byte tail fragment.
    assert_large_file_round_trip("gzip", 128 * 1024 + 1);
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn large_file_across_all_compressors() {
    // 500 KiB spans several full blocks + a tail across every codec, so
    // the multi-block read path is proven against real output from each.
    for comp in ["gzip", "xz", "lz4", "zstd", "lzo"] {
        assert_large_file_round_trip(comp, 500 * 1024);
    }
}

/// A file with several files of mixed sizes in one image — proves the
/// driver tracks each file's own block list + fragment independently when
/// many files share a fragment block.
#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn mixed_block_and_fragment_files_gzip() {
    if !mksquashfs_available() {
        eprintln!("skipping: mksquashfs not on PATH");
        return;
    }
    let bs = 128 * 1024;
    let sizes: &[(&str, usize)] = &[
        ("tiny", 5),                 // pure fragment
        ("one_block", bs),           // exactly one full block, no fragment
        ("block_plus_tail", bs + 7), // one full block + tiny fragment
        ("multi", 3 * bs + 1234),    // several blocks + fragment
    ];
    let entries: Vec<(&str, Node)> = sizes
        .iter()
        .map(|(name, sz)| (*name, file(&pattern(*sz))))
        .collect();
    let art = build_with_mksquashfs("gzip", &dir(entries));
    let fs = open_image(art.bytes);

    for (name, sz) in sizes {
        let got = read_whole_file(&fs, &format!("/{name}"));
        assert_eq!(got.len(), *sz, "{name} length");
        assert_eq!(got, pattern(*sz), "{name} content");
    }
}
