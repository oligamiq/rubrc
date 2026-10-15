//! Indirect lookup tables (id table, fragment table).
//!
//! SquashFS stores several tables (uid/gid ids, fragment locations, the
//! export inode map) indirectly: at `table_start` there is a raw
//! little-endian array of `u64` pointers — NOT a metadata block — one per
//! metadata block that holds the table's entries. Each pointer is the
//! absolute byte offset of a metadata block. Concatenating those
//! decompressed blocks yields the entry array.
//!
//! Entry sizes here (id = 4 bytes, fragment = 16 bytes) both divide the
//! 8 KiB metadata size evenly, so a single entry never straddles a
//! metadata-block boundary — we can decompress all blocks, concatenate,
//! and slice by index.

use crate::error::{Error, Result};
use crate::metablock::read_block;
use crate::superblock::{Superblock, METADATA_SIZE};
use fs_core::BlockRead;

/// Data-block size word convention (shared by file block_sizes and
/// fragment entries): bit 24 set → stored UNCOMPRESSED; low 24 bits → the
/// on-disk size of the (possibly compressed) block.
pub const DATA_COMPRESSED_BIT: u32 = 1 << 24;
pub const DATA_SIZE_MASK: u32 = (1 << 24) - 1;

/// On-disk byte length of a data block from its size word.
pub fn data_on_disk_size(raw: u32) -> u32 {
    raw & DATA_SIZE_MASK
}

/// Whether a data block's payload is compressed (bit 24 clear).
pub fn data_is_compressed(raw: u32) -> bool {
    raw & DATA_COMPRESSED_BIT == 0
}

/// One fragment-table entry: where a packed fragment block lives + its
/// on-disk size word (same convention as [`data_on_disk_size`]).
#[derive(Debug, Clone, Copy)]
pub struct FragmentEntry {
    pub start: u64,
    pub size: u32,
}

/// Read + concatenate an indirect table's metadata blocks. `total_bytes`
/// is `n_entries * entry_size`; we pull `ceil(total_bytes / 8192)` block
/// pointers from `table_start` and return the concatenated decompressed
/// bytes (length >= `total_bytes`).
fn read_indirect_table<R: BlockRead + ?Sized>(
    dev: &R,
    sb: &Superblock,
    table_start: u64,
    total_bytes: usize,
) -> Result<Vec<u8>> {
    if total_bytes == 0 {
        return Ok(Vec::new());
    }
    let n_blocks = total_bytes.div_ceil(METADATA_SIZE);
    // The pointer array is raw u64s on disk, immediately at table_start.
    let mut ptr_bytes = vec![0u8; n_blocks * 8];
    dev.read_at(table_start, &mut ptr_bytes)?;

    let mut out = Vec::with_capacity(total_bytes);
    for i in 0..n_blocks {
        let p = u64::from_le_bytes(ptr_bytes[i * 8..i * 8 + 8].try_into().unwrap());
        let (block, _next) = read_block(dev, sb, p)?;
        out.extend_from_slice(&block);
    }
    if out.len() < total_bytes {
        return Err(Error::BadMetadata("indirect table shorter than expected"));
    }
    Ok(out)
}

/// Read the uid/gid id table → a vector of `id_count` u32 ids. `uid_idx` /
/// `gid_idx` in an inode index into this.
pub fn read_id_table<R: BlockRead + ?Sized>(dev: &R, sb: &Superblock) -> Result<Vec<u32>> {
    let n = sb.id_count as usize;
    if n == 0 {
        return Ok(Vec::new());
    }
    let bytes = read_indirect_table(dev, sb, sb.id_table_start, n * 4)?;
    let mut ids = Vec::with_capacity(n);
    for i in 0..n {
        ids.push(u32::from_le_bytes(
            bytes[i * 4..i * 4 + 4].try_into().unwrap(),
        ));
    }
    Ok(ids)
}

/// Read the fragment table → one [`FragmentEntry`] per
/// `fragment_entry_count`. A file's `fragment_index` indexes into this.
pub fn read_fragment_table<R: BlockRead + ?Sized>(
    dev: &R,
    sb: &Superblock,
) -> Result<Vec<FragmentEntry>> {
    let n = sb.fragment_entry_count as usize;
    if n == 0 {
        return Ok(Vec::new());
    }
    // Each on-disk fragment entry is 16 bytes: u64 start, u32 size, u32 unused.
    let bytes = read_indirect_table(dev, sb, sb.fragment_table_start, n * 16)?;
    let mut frags = Vec::with_capacity(n);
    for i in 0..n {
        let o = i * 16;
        let start = u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
        let size = u32::from_le_bytes(bytes[o + 8..o + 12].try_into().unwrap());
        frags.push(FragmentEntry { start, size });
    }
    Ok(frags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_size_word_decoding() {
        // Compressed 1234-byte block: bit 24 clear.
        assert_eq!(data_on_disk_size(1234), 1234);
        assert!(data_is_compressed(1234));
        // Uncompressed 4096-byte block: bit 24 set.
        let raw = 4096 | DATA_COMPRESSED_BIT;
        assert_eq!(data_on_disk_size(raw), 4096);
        assert!(!data_is_compressed(raw));
        // Sparse block: size word 0.
        assert_eq!(data_on_disk_size(0), 0);
    }

    #[test]
    fn empty_tables_short_circuit() {
        use crate::metablock::tests::MemDev;
        use crate::superblock::tests::synth_sb;
        use std::sync::Mutex;
        let dev = MemDev(Mutex::new(vec![0u8; 96]));
        let sb = Superblock::parse(&synth_sb(17, 0, 0)).unwrap();
        // id_count and fragment_entry_count are 0 in the synth SB.
        assert!(read_id_table(&dev, &sb).unwrap().is_empty());
        assert!(read_fragment_table(&dev, &sb).unwrap().is_empty());
    }
}
