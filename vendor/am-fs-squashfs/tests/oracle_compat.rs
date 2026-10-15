//! Oracle-validated compression tests.
//!
//! For each standard SquashFS compressor, build a fixture tree with the
//! real `mksquashfs -comp <c>` and read every path back through the
//! pure-Rust driver, asserting exact bytes. This is the ground truth that
//! proves the codec dispatch (gzip / xz / lz4 / zstd / lzo) decodes real
//! `mksquashfs` output, not just our own synthetic streams.
//!
//! Every test here is `#[ignore]`-gated so `cargo test` stays green on a
//! host without `squashfs-tools`. Run them with:
//!
//! ```sh
//! cargo test --release -- --ignored
//! ```

mod common;

use common::*;

/// The fixture tree, shared across every compressor:
///   /hello.txt          small file (lands in a tail fragment)
///   /sub/note.md        nested small file
///   /sub/deep/big.bin   ~300 KiB pseudo-random -> multiple data blocks
///   /link               symlink -> hello.txt
fn fixture_tree() -> Node {
    dir(vec![
        ("hello.txt", file(b"hi\n")),
        (
            "sub",
            dir(vec![
                ("note.md", file(b"# note\nsome words here\n")),
                ("deep", dir(vec![("big.bin", file(&pattern(300_000)))])),
            ]),
        ),
        ("link", symlink("hello.txt")),
    ])
}

/// Run the full read-back assertion suite against an image built with the
/// given compressor.
fn assert_reads_back(comp: &str) {
    if !mksquashfs_available() {
        eprintln!("skipping {comp}: mksquashfs not on PATH");
        return;
    }
    let art = build_with_mksquashfs(comp, &fixture_tree());
    let fs = open_image(art.bytes.clone());

    // Report the compressor the driver detected matches what we asked for.
    assert_eq!(
        fs.compressor().name(),
        comp,
        "driver detected wrong compressor for -comp {comp}"
    );

    // ---- root listing ----
    assert_eq!(
        sorted_dir_names(&fs, "/"),
        vec!["hello.txt", "link", "sub"],
        "[{comp}] root listing"
    );
    assert_eq!(
        sorted_dir_names(&fs, "/sub"),
        vec!["deep", "note.md"],
        "[{comp}] /sub listing"
    );

    // ---- small (fragment) file ----
    assert_eq!(
        read_whole_file(&fs, "/hello.txt"),
        b"hi\n",
        "[{comp}] fragment file"
    );

    // ---- nested small file ----
    assert_eq!(
        read_whole_file(&fs, "/sub/note.md"),
        b"# note\nsome words here\n",
        "[{comp}] nested file"
    );

    // ---- multi-block large file: full content + mid-file offset read ----
    let expect = pattern(300_000);
    let big = read_whole_file(&fs, "/sub/deep/big.bin");
    assert_eq!(big.len(), 300_000, "[{comp}] big.bin length");
    assert_eq!(big, expect, "[{comp}] big.bin full content");

    let big_inode = fs.lookup_path("/sub/deep/big.bin").unwrap();
    let mut mid = vec![0u8; 1000];
    fs.read_file(&big_inode, 200_000, &mut mid).unwrap();
    assert_eq!(
        &mid[..],
        &expect[200_000..201_000],
        "[{comp}] big.bin mid-file offset read"
    );

    // ---- symlink target ----
    let link = fs.lookup_path("/link").unwrap();
    assert!(link.is_symlink(), "[{comp}] /link is a symlink");
    assert_eq!(
        fs.read_symlink_target(&link).unwrap(),
        b"hello.txt",
        "[{comp}] symlink target"
    );

    // ---- cross-check the multi-block file against unsquashfs itself ----
    if unsquashfs_available() {
        let viaunsquash = unsquashfs_extract_file(&art.path, "/sub/deep/big.bin");
        assert_eq!(
            viaunsquash, big,
            "[{comp}] driver vs unsquashfs disagree on big.bin"
        );
    }

    // ---- missing path surfaces an error ----
    assert!(fs.lookup_path("/nope").is_err(), "[{comp}] missing path");
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn oracle_gzip() {
    assert_reads_back("gzip");
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn oracle_xz() {
    assert_reads_back("xz");
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn oracle_lz4() {
    assert_reads_back("lz4");
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn oracle_zstd() {
    assert_reads_back("zstd");
}

#[test]
#[ignore = "requires squashfs-tools (mksquashfs); run with -- --ignored"]
fn oracle_lzo() {
    assert_reads_back("lzo");
}
