//! CLI tests for `src/bin/lssquashfs.rs`.
//!
//! Uses `assert_cmd::Command::cargo_bin` to spawn the freshly-built
//! binary against the committed `test-disks/squashfs-basic.sqfs` fixture,
//! so the whole file runs under a plain `cargo test` — no squashfs-tools.
//!
//! Coverage: the `info` / `ls` / `tree` / `cat` / `readlink` subcommands'
//! happy paths plus the error arms (missing path, not-a-file `cat`,
//! unknown command, bad/non-squashfs image, missing args).

mod common;

use assert_cmd::Command;
use common::basic_fixture_path;

/// `lssquashfs <fixture> <args...>`.
fn ls(args: &[&str]) -> assert_cmd::assert::Assert {
    let fixture = basic_fixture_path();
    let mut cmd = Command::cargo_bin("lssquashfs").unwrap();
    cmd.arg(&fixture);
    cmd.args(args);
    cmd.assert()
}

// ---- info --------------------------------------------------------------

#[test]
fn info_prints_superblock_summary() {
    let out = ls(&["info"]).success();
    let stdout = String::from_utf8_lossy(&out.get_output().stdout).into_owned();
    assert!(stdout.contains("version:"), "stdout: {stdout}");
    assert!(stdout.contains("4.0"), "version 4.0: {stdout}");
    assert!(stdout.contains("gzip"), "compressor: {stdout}");
    assert!(stdout.contains("block size:"), "block size: {stdout}");
    assert!(stdout.contains("4096"), "block size 4096: {stdout}");
}

// ---- ls ----------------------------------------------------------------

#[test]
fn ls_root_lists_all_entries() {
    let out = ls(&["ls", "/"]).success();
    let stdout = String::from_utf8_lossy(&out.get_output().stdout).into_owned();
    for name in ["hello.txt", "empty.txt", "link", "sub"] {
        assert!(stdout.contains(name), "missing {name} in:\n{stdout}");
    }
    // The symlink line shows its target.
    assert!(
        stdout.contains("link -> hello.txt"),
        "symlink line:\n{stdout}"
    );
}

#[test]
fn ls_subdir_lists_children() {
    let out = ls(&["ls", "/sub"]).success();
    let stdout = String::from_utf8_lossy(&out.get_output().stdout).into_owned();
    assert!(stdout.contains("note.md"), "stdout:\n{stdout}");
    assert!(stdout.contains("deep"), "stdout:\n{stdout}");
}

#[test]
fn ls_default_path_is_root() {
    // Omitting the path argument defaults to `/`.
    let out = ls(&["ls"]).success();
    let stdout = String::from_utf8_lossy(&out.get_output().stdout).into_owned();
    assert!(stdout.contains("hello.txt"), "stdout:\n{stdout}");
}

#[test]
fn ls_on_a_file_prints_that_one_entry() {
    let out = ls(&["ls", "/hello.txt"]).success();
    let stdout = String::from_utf8_lossy(&out.get_output().stdout).into_owned();
    assert!(stdout.contains("hello.txt"), "stdout:\n{stdout}");
}

// ---- tree --------------------------------------------------------------

#[test]
fn tree_shows_nested_structure() {
    let out = ls(&["tree", "/"]).success();
    let stdout = String::from_utf8_lossy(&out.get_output().stdout).into_owned();
    assert!(stdout.contains("sub/"), "stdout:\n{stdout}");
    assert!(stdout.contains("deep/"), "stdout:\n{stdout}");
    assert!(stdout.contains("big.bin"), "stdout:\n{stdout}");
    assert!(stdout.contains("note.md"), "stdout:\n{stdout}");
}

// ---- cat ---------------------------------------------------------------

#[test]
fn cat_small_file_emits_exact_bytes() {
    let out = ls(&["cat", "/hello.txt"]).success();
    assert_eq!(out.get_output().stdout, b"hi\n");
}

#[test]
fn cat_nested_file_emits_exact_bytes() {
    let out = ls(&["cat", "/sub/note.md"]).success();
    assert_eq!(out.get_output().stdout, b"# note\nsome words here\n");
}

#[test]
fn cat_multiblock_file_emits_full_content() {
    let out = ls(&["cat", "/sub/deep/big.bin"]).success();
    assert_eq!(out.get_output().stdout, common::basic_big_bin());
}

#[test]
fn cat_empty_file_emits_nothing() {
    let out = ls(&["cat", "/empty.txt"]).success();
    assert!(out.get_output().stdout.is_empty());
}

#[test]
fn cat_directory_fails() {
    let out = ls(&["cat", "/sub"]).failure();
    let stderr = String::from_utf8_lossy(&out.get_output().stderr).into_owned();
    assert!(stderr.contains("not a regular file"), "stderr:\n{stderr}");
}

// ---- readlink ----------------------------------------------------------

#[test]
fn readlink_prints_target() {
    let out = ls(&["readlink", "/link"]).success();
    assert_eq!(out.get_output().stdout, b"hello.txt\n");
}

// ---- error arms --------------------------------------------------------

#[test]
fn missing_path_fails() {
    let out = ls(&["cat", "/does-not-exist"]).failure();
    let stderr = String::from_utf8_lossy(&out.get_output().stderr).into_owned();
    assert!(stderr.contains("not found"), "stderr:\n{stderr}");
}

#[test]
fn unknown_command_fails() {
    let out = ls(&["frobnicate"]).failure();
    let stderr = String::from_utf8_lossy(&out.get_output().stderr).into_owned();
    assert!(stderr.contains("unknown command"), "stderr:\n{stderr}");
}

#[test]
fn no_args_exits_two_with_usage() {
    let out = Command::cargo_bin("lssquashfs").unwrap().assert().failure();
    let code = out.get_output().status.code();
    assert_eq!(code, Some(2), "expected exit 2 for no args");
    let stderr = String::from_utf8_lossy(&out.get_output().stderr).into_owned();
    assert!(stderr.contains("usage"), "stderr:\n{stderr}");
}

#[test]
fn bad_image_path_fails() {
    let out = Command::cargo_bin("lssquashfs")
        .unwrap()
        .arg("/tmp/definitely-no-such-squashfs-xyz.sqfs")
        .arg("ls")
        .assert()
        .failure();
    let stderr = String::from_utf8_lossy(&out.get_output().stderr).into_owned();
    assert!(stderr.contains("open"), "stderr:\n{stderr}");
}

#[test]
fn non_squashfs_file_fails() {
    // Point the CLI at this crate's own Cargo.toml — a real file that
    // isn't a SquashFS image. The reader must reject it (not panic).
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let out = Command::cargo_bin("lssquashfs")
        .unwrap()
        .arg(manifest)
        .arg("info")
        .assert()
        .failure();
    let stderr = String::from_utf8_lossy(&out.get_output().stderr).into_owned();
    assert!(
        stderr.contains("squashfs") || stderr.contains("SquashFS") || stderr.contains("magic"),
        "stderr:\n{stderr}"
    );
}
