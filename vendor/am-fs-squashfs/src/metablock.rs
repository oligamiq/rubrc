//! SquashFS metadata-block reader.
//!
//! Inodes, directory listings, and the indirect lookup tables are all
//! stored in **metadata blocks**: each is at most 8 KiB when decompressed
//! and is preceded on disk by a `u16` little-endian header —
//!
//! - bit 15 (`0x8000`) set  → the payload is stored UNCOMPRESSED
//! - bits 0..14             → the on-disk size of the (possibly
//!   compressed) payload that follows the 2-byte header
//!
//! A single inode or directory record can straddle a metadata-block
//! boundary, so [`MetaCursor`] presents a flat byte stream that pulls and
//! decompresses successive metadata blocks on demand.

use crate::decompress;
use crate::error::{Error, Result};
use crate::superblock::{Superblock, METADATA_SIZE};
use fs_core::BlockRead;

const COMPRESSED_BIT: u16 = 0x8000;
const SIZE_MASK: u16 = 0x7FFF;

/// Read + decompress one metadata block whose 2-byte header sits at
/// absolute byte offset `abs`. Returns the decompressed payload and the
/// absolute offset of the *next* metadata block.
pub fn read_block<R: BlockRead + ?Sized>(
    dev: &R,
    sb: &Superblock,
    abs: u64,
) -> Result<(Vec<u8>, u64)> {
    let mut hdr = [0u8; 2];
    dev.read_at(abs, &mut hdr)?;
    let raw = u16::from_le_bytes(hdr);
    let on_disk = (raw & SIZE_MASK) as usize;
    let is_compressed = raw & COMPRESSED_BIT == 0;
    if on_disk == 0 || on_disk > METADATA_SIZE {
        return Err(Error::BadMetadata("metadata block size out of range"));
    }

    let mut payload = vec![0u8; on_disk];
    dev.read_at(abs + 2, &mut payload)?;

    let out = if is_compressed {
        decompress::decompress(sb.compressor()?, &payload, METADATA_SIZE)?
    } else {
        // Uncompressed metadata blocks are stored verbatim, still capped
        // at the 8 KiB metadata size.
        if payload.len() > METADATA_SIZE {
            return Err(Error::BadMetadata("uncompressed metadata block too large"));
        }
        payload
    };
    Ok((out, abs + 2 + on_disk as u64))
}

/// A flat reader over a run of consecutive metadata blocks, starting at a
/// given absolute byte offset and in-block offset. Decompresses blocks
/// lazily as the caller reads past the current buffer.
pub struct MetaCursor<'a, R: BlockRead + ?Sized> {
    dev: &'a R,
    sb: &'a Superblock,
    /// Absolute offset of the NEXT metadata block to pull.
    next_abs: u64,
    /// Decompressed bytes accumulated so far, minus what's been consumed.
    buf: Vec<u8>,
    /// Read cursor within `buf`.
    pos: usize,
}

impl<'a, R: BlockRead + ?Sized> MetaCursor<'a, R> {
    /// Start a cursor at the metadata block beginning at absolute offset
    /// `start_abs`, positioned `in_block` bytes into that decompressed
    /// block (this is exactly how a SquashFS metadata reference decodes:
    /// `start_abs = table_start + (ref >> 16)`, `in_block = ref & 0xFFFF`).
    pub fn new(dev: &'a R, sb: &'a Superblock, start_abs: u64, in_block: u16) -> Result<Self> {
        let (block, next) = read_block(dev, sb, start_abs)?;
        if in_block as usize > block.len() {
            return Err(Error::BadMetadata(
                "metadata reference offset past block end",
            ));
        }
        Ok(MetaCursor {
            dev,
            sb,
            next_abs: next,
            buf: block,
            pos: in_block as usize,
        })
    }

    /// Pull one more metadata block onto the tail of `buf`.
    fn refill(&mut self) -> Result<()> {
        let (block, next) = read_block(self.dev, self.sb, self.next_abs)?;
        if block.is_empty() {
            return Err(Error::BadMetadata(
                "empty metadata block while reading record",
            ));
        }
        // Drop already-consumed bytes to keep the buffer bounded, then
        // append the freshly-decompressed block.
        self.buf.drain(..self.pos);
        self.pos = 0;
        self.buf.extend_from_slice(&block);
        self.next_abs = next;
        Ok(())
    }

    /// Ensure at least `n` unread bytes are available, pulling blocks as
    /// needed.
    fn ensure(&mut self, n: usize) -> Result<()> {
        while self.buf.len() - self.pos < n {
            self.refill()?;
        }
        Ok(())
    }

    /// Read exactly `n` bytes, advancing the cursor.
    pub fn read_exact(&mut self, n: usize) -> Result<Vec<u8>> {
        self.ensure(n)?;
        let out = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Ok(out)
    }

    pub fn read_u16(&mut self) -> Result<u16> {
        let b = self.read_exact(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn read_i16(&mut self) -> Result<i16> {
        Ok(self.read_u16()? as i16)
    }

    pub fn read_u32(&mut self) -> Result<u32> {
        let b = self.read_exact(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn read_u64(&mut self) -> Result<u64> {
        let b = self.read_exact(8)?;
        Ok(u64::from_le_bytes(b.try_into().unwrap()))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::superblock::tests::synth_sb;
    use crate::superblock::Superblock;
    use flate2::{Compress, Compression, FlushCompress};
    use std::sync::Mutex;

    pub(crate) struct MemDev(pub Mutex<Vec<u8>>);
    impl BlockRead for MemDev {
        fn read_at(&self, offset: u64, buf: &mut [u8]) -> fs_core::Result<()> {
            let v = self.0.lock().unwrap();
            let start = offset as usize;
            let end = start + buf.len();
            if end > v.len() {
                return Err(fs_core::Error::ShortRead {
                    offset,
                    want: buf.len(),
                    got: v.len().saturating_sub(start),
                });
            }
            buf.copy_from_slice(&v[start..end]);
            Ok(())
        }
        fn size_bytes(&self) -> u64 {
            self.0.lock().unwrap().len() as u64
        }
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut enc = Compress::new(Compression::default(), true);
        let mut out = vec![0u8; data.len() + 64];
        enc.compress(data, &mut out, FlushCompress::Finish).unwrap();
        out.truncate(enc.total_out() as usize);
        out
    }

    /// Emit a metadata block (header + payload) for `payload`, compressed.
    pub(crate) fn emit_meta(payload: &[u8]) -> Vec<u8> {
        let comp = zlib(payload);
        let mut out = Vec::new();
        out.extend_from_slice(&(comp.len() as u16).to_le_bytes());
        out.extend_from_slice(&comp);
        out
    }

    /// Emit an UNCOMPRESSED metadata block (sets bit 15).
    fn emit_meta_raw(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&((payload.len() as u16) | COMPRESSED_BIT).to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    fn sb() -> Superblock {
        Superblock::parse(&synth_sb(17, 0, 0)).unwrap()
    }

    #[test]
    fn read_compressed_block() {
        let payload = b"the quick brown fox".repeat(20);
        let img = emit_meta(&payload);
        let dev = MemDev(Mutex::new(img.clone()));
        let (out, next) = read_block(&dev, &sb(), 0).unwrap();
        assert_eq!(out, payload);
        assert_eq!(next as usize, img.len());
    }

    #[test]
    fn read_uncompressed_block() {
        let payload = b"raw bytes";
        let img = emit_meta_raw(payload);
        let dev = MemDev(Mutex::new(img));
        let (out, _next) = read_block(&dev, &sb(), 0).unwrap();
        assert_eq!(out, payload);
    }

    #[test]
    fn cursor_spans_block_boundary() {
        // Two metadata blocks; a record straddles the seam.
        let first = vec![0xAAu8; 100];
        let second = {
            let mut v = vec![0xBBu8; 100];
            v[0] = 0xCC;
            v
        };
        let mut img = emit_meta(&first);
        img.extend_from_slice(&emit_meta(&second));
        let dev = MemDev(Mutex::new(img));
        let s = sb();
        let mut cur = MetaCursor::new(&dev, &s, 0, 98).unwrap();
        // Read 4 bytes starting 98 into block 0: 2 from block 0 (0xAA),
        // then 2 from block 1 (0xCC, 0xBB).
        let got = cur.read_exact(4).unwrap();
        assert_eq!(got, vec![0xAA, 0xAA, 0xCC, 0xBB]);
    }

    #[test]
    fn rejects_zero_size_header() {
        let img = vec![0u8, 0u8]; // size 0
        let dev = MemDev(Mutex::new(img));
        assert!(matches!(
            read_block(&dev, &sb(), 0),
            Err(Error::BadMetadata(_))
        ));
    }
}
