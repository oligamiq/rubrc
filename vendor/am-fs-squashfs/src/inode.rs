//! SquashFS inode parsing.
//!
//! Every inode begins with a 16-byte common header (type, permissions,
//! uid/gid index, mtime, inode number), followed by type-specific fields.
//! SquashFS has a "basic" and an "extended" variant of each type; the
//! extended forms add nlink / xattr / 64-bit sizing. This module unifies
//! both into a single [`Inode`] carrying whatever the read paths need.
//!
//! Field layouts mirror `squashfs_fs.h` (`squashfs_*_inode` structs).

use crate::error::{Error, Result};
use crate::metablock::MetaCursor;
use crate::superblock::{Superblock, SQUASHFS_INVALID_FRAG};
use fs_core::BlockRead;

// Inode type ids (squashfs_fs.h).
pub const TYPE_BASIC_DIR: u16 = 1;
pub const TYPE_BASIC_FILE: u16 = 2;
pub const TYPE_BASIC_SYMLINK: u16 = 3;
pub const TYPE_BASIC_BLKDEV: u16 = 4;
pub const TYPE_BASIC_CHRDEV: u16 = 5;
pub const TYPE_BASIC_FIFO: u16 = 6;
pub const TYPE_BASIC_SOCKET: u16 = 7;
pub const TYPE_EXT_DIR: u16 = 8;
pub const TYPE_EXT_FILE: u16 = 9;
pub const TYPE_EXT_SYMLINK: u16 = 10;
pub const TYPE_EXT_BLKDEV: u16 = 11;
pub const TYPE_EXT_CHRDEV: u16 = 12;
pub const TYPE_EXT_FIFO: u16 = 13;
pub const TYPE_EXT_SOCKET: u16 = 14;

/// Guard against corrupt inodes claiming absurd block counts / symlink
/// lengths. 16M blocks ≈ 2 TiB at 128 KiB blocks; PATH_MAX is 4 KiB but
/// SquashFS targets are bounded well under 64 KiB.
const MAX_BLOCKS: u64 = 1 << 24;
const MAX_SYMLINK: u32 = 1 << 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    Dir,
    RegFile,
    Symlink,
    CharDev,
    BlockDev,
    Fifo,
    Socket,
    Unknown,
}

impl FileType {
    /// Map any inode type id (basic 1-7 or extended 8-14, and the basic
    /// type stored in directory entries) to a file-type kind.
    pub fn from_type_id(t: u16) -> FileType {
        match t {
            TYPE_BASIC_DIR | TYPE_EXT_DIR => FileType::Dir,
            TYPE_BASIC_FILE | TYPE_EXT_FILE => FileType::RegFile,
            TYPE_BASIC_SYMLINK | TYPE_EXT_SYMLINK => FileType::Symlink,
            TYPE_BASIC_CHRDEV | TYPE_EXT_CHRDEV => FileType::CharDev,
            TYPE_BASIC_BLKDEV | TYPE_EXT_BLKDEV => FileType::BlockDev,
            TYPE_BASIC_FIFO | TYPE_EXT_FIFO => FileType::Fifo,
            TYPE_BASIC_SOCKET | TYPE_EXT_SOCKET => FileType::Socket,
            _ => FileType::Unknown,
        }
    }

    /// Encode to the C-ABI dirent/file-type byte
    /// (UNKNOWN=0, REG=1, DIR=2, CHR=3, BLK=4, FIFO=5, SOCK=6, LNK=7).
    pub fn to_abi(self) -> u8 {
        match self {
            FileType::Unknown => 0,
            FileType::RegFile => 1,
            FileType::Dir => 2,
            FileType::CharDev => 3,
            FileType::BlockDev => 4,
            FileType::Fifo => 5,
            FileType::Socket => 6,
            FileType::Symlink => 7,
        }
    }

    /// POSIX `S_IF*` high bits for assembling a full `st_mode`.
    pub fn mode_bits(self) -> u16 {
        match self {
            FileType::Dir => 0o040000,
            FileType::RegFile => 0o100000,
            FileType::Symlink => 0o120000,
            FileType::CharDev => 0o020000,
            FileType::BlockDev => 0o060000,
            FileType::Fifo => 0o010000,
            FileType::Socket => 0o140000,
            FileType::Unknown => 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Inode {
    pub inode_type: u16,
    /// Permission bits only (no type bits).
    pub permissions: u16,
    pub uid_idx: u16,
    pub gid_idx: u16,
    pub mtime: u32,
    pub inode_number: u32,
    pub nlink: u32,

    /// Logical size: for files the byte length; for symlinks the target
    /// length; for directories the on-disk listing size (which includes a
    /// 3-byte fudge — see [`Inode::dir_listing_len`]).
    pub file_size: u64,

    // ----- directory -----
    /// Offset of the dir listing's first metadata block, relative to
    /// `directory_table_start`.
    pub dir_start_block: u32,
    /// Offset within that decompressed metadata block.
    pub dir_block_offset: u16,

    // ----- regular file -----
    /// Absolute byte offset where the file's data blocks begin.
    pub blocks_start: u64,
    /// Fragment table index, or [`SQUASHFS_INVALID_FRAG`] if none.
    pub fragment_index: u32,
    /// Byte offset of this file's tail within the decompressed fragment.
    pub fragment_offset: u32,
    /// Per-block on-disk size words (see `table::data_*`).
    pub block_sizes: Vec<u32>,

    // ----- symlink -----
    pub symlink_target: Vec<u8>,
}

impl Inode {
    pub fn file_type(&self) -> FileType {
        FileType::from_type_id(self.inode_type)
    }
    pub fn is_dir(&self) -> bool {
        matches!(self.file_type(), FileType::Dir)
    }
    pub fn is_regular_file(&self) -> bool {
        matches!(self.file_type(), FileType::RegFile)
    }
    pub fn is_symlink(&self) -> bool {
        matches!(self.file_type(), FileType::Symlink)
    }

    /// True if a file has a packed tail fragment.
    pub fn has_fragment(&self) -> bool {
        self.is_regular_file() && self.fragment_index != SQUASHFS_INVALID_FRAG
    }

    /// The real byte length of a directory's on-disk listing. SquashFS
    /// stores `file_size = real_len + 3`; a value <= 3 means the directory
    /// has no explicit entries.
    pub fn dir_listing_len(&self) -> usize {
        (self.file_size as usize).saturating_sub(3)
    }

    /// Read + parse the inode at the given metadata reference.
    /// `inode_ref` high 48 bits = metadata-block offset relative to
    /// `inode_table_start`; low 16 bits = offset within that block.
    pub fn read<R: BlockRead + ?Sized>(dev: &R, sb: &Superblock, inode_ref: u64) -> Result<Inode> {
        let start_abs = sb.inode_table_start + (inode_ref >> 16);
        let in_block = (inode_ref & 0xFFFF) as u16;
        let mut cur = MetaCursor::new(dev, sb, start_abs, in_block)?;

        // ----- 16-byte common header -----
        let inode_type = cur.read_u16()?;
        let permissions = cur.read_u16()?;
        let uid_idx = cur.read_u16()?;
        let gid_idx = cur.read_u16()?;
        let mtime = cur.read_u32()?;
        let inode_number = cur.read_u32()?;

        let mut inode = Inode {
            inode_type,
            permissions,
            uid_idx,
            gid_idx,
            mtime,
            inode_number,
            nlink: 1,
            file_size: 0,
            dir_start_block: 0,
            dir_block_offset: 0,
            blocks_start: 0,
            fragment_index: SQUASHFS_INVALID_FRAG,
            fragment_offset: 0,
            block_sizes: Vec::new(),
            symlink_target: Vec::new(),
        };

        let block_size = sb.block_size as u64;
        match inode_type {
            TYPE_BASIC_DIR => {
                inode.dir_start_block = cur.read_u32()?;
                inode.nlink = cur.read_u32()?;
                inode.file_size = cur.read_u16()? as u64;
                inode.dir_block_offset = cur.read_u16()?;
                let _parent = cur.read_u32()?;
            }
            TYPE_EXT_DIR => {
                inode.nlink = cur.read_u32()?;
                inode.file_size = cur.read_u32()? as u64;
                inode.dir_start_block = cur.read_u32()?;
                let _parent = cur.read_u32()?;
                let _index_count = cur.read_u16()?;
                inode.dir_block_offset = cur.read_u16()?;
                let _xattr = cur.read_u32()?;
                // Directory-index entries (fast-lookup hints) follow inline,
                // but we do a linear scan of the listing, so they're ignored.
            }
            TYPE_BASIC_FILE => {
                inode.blocks_start = cur.read_u32()? as u64;
                inode.fragment_index = cur.read_u32()?;
                inode.fragment_offset = cur.read_u32()?;
                inode.file_size = cur.read_u32()? as u64;
                let n = block_count(inode.file_size, block_size, inode.fragment_index)?;
                inode.block_sizes = read_block_sizes(&mut cur, n)?;
            }
            TYPE_EXT_FILE => {
                inode.blocks_start = cur.read_u64()?;
                inode.file_size = cur.read_u64()?;
                let _sparse = cur.read_u64()?;
                inode.nlink = cur.read_u32()?;
                inode.fragment_index = cur.read_u32()?;
                inode.fragment_offset = cur.read_u32()?;
                let _xattr = cur.read_u32()?;
                let n = block_count(inode.file_size, block_size, inode.fragment_index)?;
                inode.block_sizes = read_block_sizes(&mut cur, n)?;
            }
            TYPE_BASIC_SYMLINK => {
                inode.nlink = cur.read_u32()?;
                let target_size = cur.read_u32()?;
                inode.symlink_target = read_symlink(&mut cur, target_size)?;
                inode.file_size = target_size as u64;
            }
            TYPE_EXT_SYMLINK => {
                inode.nlink = cur.read_u32()?;
                let target_size = cur.read_u32()?;
                inode.symlink_target = read_symlink(&mut cur, target_size)?;
                inode.file_size = target_size as u64;
                let _xattr = cur.read_u32()?;
            }
            TYPE_BASIC_BLKDEV | TYPE_BASIC_CHRDEV => {
                inode.nlink = cur.read_u32()?;
                let _rdev = cur.read_u32()?;
            }
            TYPE_EXT_BLKDEV | TYPE_EXT_CHRDEV => {
                inode.nlink = cur.read_u32()?;
                let _rdev = cur.read_u32()?;
                let _xattr = cur.read_u32()?;
            }
            TYPE_BASIC_FIFO | TYPE_BASIC_SOCKET => {
                inode.nlink = cur.read_u32()?;
            }
            TYPE_EXT_FIFO | TYPE_EXT_SOCKET => {
                inode.nlink = cur.read_u32()?;
                let _xattr = cur.read_u32()?;
            }
            other => {
                return Err(Error::BadInode(match other {
                    0 => "inode type 0",
                    _ => "unknown inode type",
                }));
            }
        }
        Ok(inode)
    }
}

/// Number of full data blocks for a file. With a tail fragment the
/// remainder lives in the fragment so we floor; without one we ceil.
fn block_count(file_size: u64, block_size: u64, fragment_index: u32) -> Result<u64> {
    let n = if fragment_index == SQUASHFS_INVALID_FRAG {
        file_size.div_ceil(block_size)
    } else {
        file_size / block_size
    };
    if n > MAX_BLOCKS {
        return Err(Error::BadInode("file block count exceeds sanity bound"));
    }
    Ok(n)
}

fn read_block_sizes<R: BlockRead + ?Sized>(cur: &mut MetaCursor<R>, n: u64) -> Result<Vec<u32>> {
    let mut v = Vec::with_capacity(n as usize);
    for _ in 0..n {
        v.push(cur.read_u32()?);
    }
    Ok(v)
}

fn read_symlink<R: BlockRead + ?Sized>(cur: &mut MetaCursor<R>, size: u32) -> Result<Vec<u8>> {
    if size > MAX_SYMLINK {
        return Err(Error::BadInode("symlink target exceeds sanity bound"));
    }
    cur.read_exact(size as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_type_mapping_basic_and_extended() {
        assert_eq!(FileType::from_type_id(TYPE_BASIC_DIR), FileType::Dir);
        assert_eq!(FileType::from_type_id(TYPE_EXT_DIR), FileType::Dir);
        assert_eq!(FileType::from_type_id(TYPE_BASIC_FILE), FileType::RegFile);
        assert_eq!(FileType::from_type_id(TYPE_EXT_FILE), FileType::RegFile);
        assert_eq!(FileType::from_type_id(TYPE_EXT_SYMLINK), FileType::Symlink);
        assert_eq!(FileType::from_type_id(99), FileType::Unknown);
    }

    #[test]
    fn abi_and_mode_bits() {
        assert_eq!(FileType::Dir.to_abi(), 2);
        assert_eq!(FileType::RegFile.to_abi(), 1);
        assert_eq!(FileType::Symlink.to_abi(), 7);
        assert_eq!(FileType::Dir.mode_bits(), 0o040000);
        assert_eq!(FileType::Symlink.mode_bits(), 0o120000);
    }

    #[test]
    fn block_count_with_and_without_fragment() {
        // 4 KiB blocks, file 10000 bytes.
        // No fragment: ceil(10000/4096) = 3 blocks.
        assert_eq!(block_count(10000, 4096, SQUASHFS_INVALID_FRAG).unwrap(), 3);
        // With fragment: floor(10000/4096) = 2 full blocks + a fragment.
        assert_eq!(block_count(10000, 4096, 0).unwrap(), 2);
    }

    #[test]
    fn block_count_rejects_absurd() {
        assert!(block_count(u64::MAX, 4096, SQUASHFS_INVALID_FRAG).is_err());
    }

    #[test]
    fn dir_listing_len_subtracts_three() {
        let mut ino = Inode {
            inode_type: TYPE_BASIC_DIR,
            permissions: 0o755,
            uid_idx: 0,
            gid_idx: 0,
            mtime: 0,
            inode_number: 1,
            nlink: 2,
            file_size: 3,
            dir_start_block: 0,
            dir_block_offset: 0,
            blocks_start: 0,
            fragment_index: SQUASHFS_INVALID_FRAG,
            fragment_offset: 0,
            block_sizes: Vec::new(),
            symlink_target: Vec::new(),
        };
        // file_size == 3 -> empty listing.
        assert_eq!(ino.dir_listing_len(), 0);
        ino.file_size = 27;
        assert_eq!(ino.dir_listing_len(), 24);
    }
}
