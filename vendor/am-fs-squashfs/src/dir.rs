//! SquashFS directory-listing parser.
//!
//! A directory's listing (read from the directory table) is a sequence of
//! *directory headers*, each followed by its entries:
//!
//! Header (12 bytes): `u32 count` (entries that follow, minus one),
//! `u32 start` (the inode-table metadata-block offset shared by these
//! entries — the high part of each child's inode reference), `u32
//! inode_number` (base; each entry stores a signed delta).
//!
//! Entry (8 bytes + name): `u16 offset` (low 16 bits of the inode
//! reference), `i16 inode_offset` (delta to the header's base inode
//! number), `u16 type` (basic inode type 1-7), `u16 name_size` (name
//! length minus one), then `name_size + 1` bytes of name.
//!
//! This module parses a fully-materialised listing buffer; assembling that
//! buffer from the directory table is [`crate::fs`]'s job.

use crate::error::{Error, Result};

/// SquashFS caps names at 256 bytes.
const SQUASHFS_NAME_LEN: usize = 256;

/// One resolved directory entry.
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: Vec<u8>,
    /// Metadata reference to the child inode (feed to [`crate::Inode::read`]).
    pub inode_ref: u64,
    /// Basic inode type id (1-7) recorded in the entry.
    pub type_id: u16,
    /// Child inode number (header base + signed per-entry delta).
    pub inode_number: u32,
}

/// Parse a directory listing buffer into entries (linear order). `.` and
/// `..` are implicit in SquashFS and are NOT included.
pub fn parse_listing(buf: &[u8]) -> Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    let mut p = 0usize;

    while p < buf.len() {
        // A trailing run shorter than a header is malformed; but an exact
        // end is fine (handled by the while condition).
        if p + 12 > buf.len() {
            return Err(Error::BadDirent("truncated directory header"));
        }
        let count = u32::from_le_bytes(buf[p..p + 4].try_into().unwrap());
        let start = u32::from_le_bytes(buf[p + 4..p + 8].try_into().unwrap());
        let base_inode = u32::from_le_bytes(buf[p + 8..p + 12].try_into().unwrap());
        p += 12;

        // `count` is entries-minus-one; a header describes at most 256.
        let entries = (count as usize)
            .checked_add(1)
            .ok_or(Error::BadDirent("directory header count overflow"))?;
        if entries > 256 {
            return Err(Error::BadDirent("directory header count > 256"));
        }

        for _ in 0..entries {
            if p + 8 > buf.len() {
                return Err(Error::BadDirent("truncated directory entry header"));
            }
            let offset = u16::from_le_bytes(buf[p..p + 2].try_into().unwrap());
            let inode_offset = i16::from_le_bytes(buf[p + 2..p + 4].try_into().unwrap());
            let type_id = u16::from_le_bytes(buf[p + 4..p + 6].try_into().unwrap());
            let name_size = u16::from_le_bytes(buf[p + 6..p + 8].try_into().unwrap());
            p += 8;

            let name_len = name_size as usize + 1;
            if name_len > SQUASHFS_NAME_LEN {
                return Err(Error::BadDirent("entry name too long"));
            }
            if p + name_len > buf.len() {
                return Err(Error::BadDirent("truncated directory entry name"));
            }
            let name = buf[p..p + name_len].to_vec();
            p += name_len;

            let inode_ref = ((start as u64) << 16) | (offset as u64);
            // The per-entry delta is a signed i16 added to the header base.
            let inode_number = (base_inode as i64 + inode_offset as i64) as u32;

            out.push(DirEntry {
                name,
                inode_ref,
                type_id,
                inode_number,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Build a one-header listing with the given (name, type, offset,
    /// inode_delta) entries sharing metadata-block `start`/`base_inode`.
    pub(crate) fn synth_listing(
        start: u32,
        base_inode: u32,
        entries: &[(&[u8], u16, u16, i16)],
    ) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&((entries.len() as u32) - 1).to_le_bytes());
        b.extend_from_slice(&start.to_le_bytes());
        b.extend_from_slice(&base_inode.to_le_bytes());
        for (name, type_id, offset, delta) in entries {
            b.extend_from_slice(&offset.to_le_bytes());
            b.extend_from_slice(&delta.to_le_bytes());
            b.extend_from_slice(&type_id.to_le_bytes());
            b.extend_from_slice(&((name.len() as u16) - 1).to_le_bytes());
            b.extend_from_slice(name);
        }
        b
    }

    #[test]
    fn parses_single_header() {
        let buf = synth_listing(5, 100, &[(b"hello.txt", 2, 0x40, 0), (b"sub", 1, 0x80, 3)]);
        let entries = parse_listing(&buf).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, b"hello.txt");
        assert_eq!(entries[0].type_id, 2);
        assert_eq!(entries[0].inode_ref, (5u64 << 16) | 0x40);
        assert_eq!(entries[0].inode_number, 100);
        assert_eq!(entries[1].name, b"sub");
        assert_eq!(entries[1].inode_ref, (5u64 << 16) | 0x80);
        assert_eq!(entries[1].inode_number, 103);
    }

    #[test]
    fn empty_buffer_yields_no_entries() {
        assert!(parse_listing(&[]).unwrap().is_empty());
    }

    #[test]
    fn negative_inode_delta() {
        let buf = synth_listing(0, 100, &[(b"a", 2, 0, -10)]);
        let e = parse_listing(&buf).unwrap();
        assert_eq!(e[0].inode_number, 90);
    }

    #[test]
    fn rejects_truncated_name() {
        let mut buf = synth_listing(0, 1, &[(b"abcdef", 2, 0, 0)]);
        buf.truncate(buf.len() - 2); // chop part of the name
        assert!(matches!(parse_listing(&buf), Err(Error::BadDirent(_))));
    }

    #[test]
    fn rejects_truncated_header() {
        assert!(matches!(parse_listing(&[0u8; 5]), Err(Error::BadDirent(_))));
    }
}
