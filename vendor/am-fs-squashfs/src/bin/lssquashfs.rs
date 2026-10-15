//! `lssquashfs` — a tiny CLI for inspecting a SquashFS image with the
//! pure-Rust reader. Mirrors the standalone-binary convention of the
//! sister crates (mkfs_ext4 / mkfs_erofs).
//!
//! Usage:
//!   lssquashfs <image> info               # superblock summary
//!   lssquashfs <image> ls   [path]        # list a directory (default /)
//!   lssquashfs <image> tree [path]        # recursive listing
//!   lssquashfs <image> cat  <path>        # dump a file to stdout
//!   lssquashfs <image> readlink <path>    # print a symlink target

use std::io::Write;
use std::process::exit;
use std::sync::Arc;

use fs_core::{BlockRead, FileDevice};
use fs_squashfs::{FileType, Filesystem, Inode};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: lssquashfs <image> [info|ls|tree|cat|readlink] [path]");
        exit(2);
    }
    let image = &args[1];
    let cmd = args.get(2).map(String::as_str).unwrap_or("ls");
    let path = args.get(3).map(String::as_str).unwrap_or("/");

    let dev = match FileDevice::open(image) {
        Ok(d) => Arc::new(d) as Arc<dyn BlockRead>,
        Err(e) => die(&format!("open {image}: {e}")),
    };
    let fs = match Filesystem::open(dev) {
        Ok(fs) => fs,
        Err(e) => die(&format!("open squashfs {image}: {e}")),
    };

    match cmd {
        "info" => cmd_info(&fs),
        "ls" => cmd_ls(&fs, path),
        "tree" => cmd_tree(&fs, path, 0),
        "cat" => cmd_cat(&fs, path),
        "readlink" => cmd_readlink(&fs, path),
        other => die(&format!("unknown command '{other}'")),
    }
}

fn die(msg: &str) -> ! {
    eprintln!("lssquashfs: {msg}");
    exit(1);
}

fn cmd_info(fs: &Filesystem) {
    let sb = &fs.sb;
    println!("version:       {}.{}", sb.version_major, sb.version_minor);
    println!(
        "compression:   {} (id {})",
        fs.compressor().name(),
        sb.compression_id
    );
    println!("block size:    {}", sb.block_size);
    println!("inodes:        {}", sb.inode_count);
    println!("fragments:     {}", sb.fragment_entry_count);
    println!("ids:           {}", sb.id_count);
    println!("bytes used:    {}", sb.bytes_used);
    println!("mkfs time:     {}", sb.modification_time);
    println!("flags:         {:#06x}", sb.flags);
}

fn cmd_ls(fs: &Filesystem, path: &str) {
    let inode = lookup(fs, path);
    if !inode.is_dir() {
        print_entry(fs, basename(path), &inode);
        return;
    }
    let entries = fs
        .read_dir(&inode)
        .unwrap_or_else(|e| die(&format!("readdir {path}: {e}")));
    for e in entries {
        let child = fs.read_inode(e.inode_ref).unwrap_or_else(|err| {
            die(&format!(
                "read inode for {:?}: {err}",
                String::from_utf8_lossy(&e.name)
            ))
        });
        print_entry(fs, &String::from_utf8_lossy(&e.name), &child);
    }
}

fn cmd_tree(fs: &Filesystem, path: &str, depth: usize) {
    let inode = lookup(fs, path);
    if !inode.is_dir() {
        println!("{}{}", "  ".repeat(depth), basename(path));
        return;
    }
    let entries = fs
        .read_dir(&inode)
        .unwrap_or_else(|e| die(&format!("readdir {path}: {e}")));
    for e in entries {
        let name = String::from_utf8_lossy(&e.name).into_owned();
        let child = fs
            .read_inode(e.inode_ref)
            .unwrap_or_else(|err| die(&format!("read inode: {err}")));
        let marker = if child.is_dir() { "/" } else { "" };
        println!("{}{}{}", "  ".repeat(depth), name, marker);
        if child.is_dir() {
            let sub = if path == "/" {
                format!("/{name}")
            } else {
                format!("{path}/{name}")
            };
            cmd_tree(fs, &sub, depth + 1);
        }
    }
}

fn cmd_cat(fs: &Filesystem, path: &str) {
    let inode = lookup(fs, path);
    if !inode.is_regular_file() {
        die(&format!("cat {path}: not a regular file"));
    }
    let mut buf = vec![0u8; inode.file_size as usize];
    let n = fs
        .read_file(&inode, 0, &mut buf)
        .unwrap_or_else(|e| die(&format!("read {path}: {e}")));
    buf.truncate(n);
    std::io::stdout().write_all(&buf).ok();
}

fn cmd_readlink(fs: &Filesystem, path: &str) {
    let inode = lookup(fs, path);
    let target = fs
        .read_symlink_target(&inode)
        .unwrap_or_else(|e| die(&format!("readlink {path}: {e}")));
    println!("{}", String::from_utf8_lossy(&target));
}

fn lookup(fs: &Filesystem, path: &str) -> Inode {
    fs.lookup_path(path)
        .unwrap_or_else(|e| die(&format!("{path}: {e}")))
}

fn basename(path: &str) -> &str {
    path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("/")
}

fn print_entry(fs: &Filesystem, name: &str, inode: &Inode) {
    let kind = match inode.file_type() {
        FileType::Dir => "d",
        FileType::RegFile => "-",
        FileType::Symlink => "l",
        FileType::CharDev => "c",
        FileType::BlockDev => "b",
        FileType::Fifo => "p",
        FileType::Socket => "s",
        FileType::Unknown => "?",
    };
    let suffix = if inode.is_symlink() {
        let t = fs.read_symlink_target(inode).unwrap_or_default();
        format!(" -> {}", String::from_utf8_lossy(&t))
    } else {
        String::new()
    };
    println!(
        "{}{:04o} {:>10} {}{}",
        kind,
        inode.permissions & 0o7777,
        inode.file_size,
        name,
        suffix
    );
}
