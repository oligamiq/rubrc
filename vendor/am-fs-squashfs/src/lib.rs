//! Pure-Rust SquashFS reader (read-only).
//!
//! SquashFS is a compressed, **read-only** filesystem — a peer format to
//! ext4/ntfs/erofs, not built on top of any of them. This crate reads
//! SquashFS 4.0 images (the only on-disk version `mksquashfs` from
//! squashfs-tools has emitted for over a decade) over any
//! [`fs_core::BlockRead`], and exposes a stable C ABI (`fs_squashfs_*`)
//! via [`capi`] so FFI consumers (an FSKit extension, C, Go) can link
//! `libfs_squashfs.a` and `#include "fs_squashfs.h"`.
//!
//! **Compression**: every standard SquashFS compressor is decoded —
//! gzip (zlib-wrapped DEFLATE, id 1), xz (`.xz` streams, id 4), lz4
//! (LZ4 block format, id 5), zstd (id 6), and lzo (LZO1X, id 3) via a
//! clean-room decoder. Legacy `lzma` (id 2) is best-effort. Unknown
//! ids surface as [`Error::UnsupportedCompression`].
//!
//! There is no write path: SquashFS cannot be modified in place (you
//! regenerate the whole image with `mksquashfs`), so the C ABI is the
//! read subset of the sister drivers' surface — no mkfs / create / write.
//!
//! Spec: the SquashFS on-disk format, as documented in
//! `linux/Documentation/filesystems/squashfs.rst` and the squashfs-tools
//! `squashfs_fs.h` field layout. Field names mirror those structs.
//! Independent clean-room implementation.
//!
//! Layout of the reader:
//! - [`superblock`] — parse + validate the 96-byte superblock
//! - [`decompress`] — codec dispatch (gzip / xz / lz4 / zstd / lzo)
//! - [`metablock`] — 8 KiB metadata-block reader + cross-block cursor
//! - [`table`] — indirect lookup tables (id table, fragment table)
//! - [`inode`] — all SquashFS inode shapes (basic + extended)
//! - [`dir`] — directory listing parser
//! - [`fs`] — top-level handle: path lookup, dir listing, file/symlink read
//! - [`capi`] — C ABI exports matching `include/fs_squashfs.h`

#![deny(unsafe_op_in_unsafe_fn)]

pub mod decompress;
pub mod dir;
pub mod error;
pub mod fs;
pub mod inode;
pub mod metablock;
pub mod superblock;
pub mod table;

// C ABI exports — surface defined in `include/fs_squashfs.h`.
pub mod capi;

pub use decompress::Compressor;
pub use dir::DirEntry;
pub use error::{Error, Result};
pub use fs::Filesystem;
pub use inode::{FileType, Inode};
pub use superblock::Superblock;
