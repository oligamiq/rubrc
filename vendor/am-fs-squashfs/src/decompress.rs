//! Codec dispatch for SquashFS compressed blocks.
//!
//! SquashFS compresses both metadata blocks and data blocks with a single
//! archive-wide compressor, named by `superblock.compression_id`. Every
//! standard compressor `mksquashfs` can emit is decoded here:
//!
//! | id | name | on-disk framing in SquashFS                              |
//! |----|------|----------------------------------------------------------|
//! | 1  | gzip | zlib stream (2-byte header + DEFLATE + Adler-32)         |
//! | 2  | lzma | legacy `.lzma` "alone" stream (best-effort)              |
//! | 3  | lzo  | LZO1X stream, decoded by the `am-lzo1x` crate           |
//! | 4  | xz   | `.xz` container stream                                   |
//! | 5  | lz4  | LZ4 *block* format (no frame; size from block geometry)  |
//! | 6  | zstd | standard zstd frame                                      |
//!
//! Each block is compressed independently. The uncompressed length is
//! bounded by the superblock block size (data blocks) or the fixed 8 KiB
//! metadata size (metadata blocks); callers pass that bound as `max_out`
//! so the codecs that need an output ceiling (lz4) can size their buffer.
//!
//! On-disk framing notes (verified against real `mksquashfs` output):
//!   * gzip blocks are the **zlib** stream format (NOT raw DEFLATE and NOT
//!     the gzip file wrapper), so we decode with `Decompress::new(true)`.
//!   * xz blocks are full `.xz` container streams — `lzma_rs::xz_decompress`
//!     reads them directly; SquashFS does not apply BCJ filters.
//!   * lz4 blocks are the raw LZ4 *block* format (the in-frame payload),
//!     not the LZ4 *frame* format, and the decompressed length is known
//!     from the SquashFS block geometry rather than a frame header.
//!   * zstd blocks are ordinary zstd frames with the content size in the
//!     frame header.

use std::io::{BufReader, Read};

use flate2::{Decompress, FlushDecompress, Status};

use crate::error::{Error, Result};
use lzo1x;

/// SquashFS compression ids from `squashfs_fs.h`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compressor {
    Gzip,
    Lzma,
    Lzo,
    Xz,
    Lz4,
    Zstd,
}

impl Compressor {
    /// Parse the on-disk `compression_id`. Unknown ids are rejected.
    pub fn from_id(id: u16) -> Result<Self> {
        match id {
            1 => Ok(Compressor::Gzip),
            2 => Ok(Compressor::Lzma),
            3 => Ok(Compressor::Lzo),
            4 => Ok(Compressor::Xz),
            5 => Ok(Compressor::Lz4),
            6 => Ok(Compressor::Zstd),
            other => Err(Error::UnsupportedCompression(other)),
        }
    }

    /// Short human name, surfaced through the volume-info C ABI.
    pub fn name(&self) -> &'static str {
        match self {
            Compressor::Gzip => "gzip",
            Compressor::Lzma => "lzma",
            Compressor::Lzo => "lzo",
            Compressor::Xz => "xz",
            Compressor::Lz4 => "lz4",
            Compressor::Zstd => "zstd",
        }
    }

    /// True if this build can actually decode the codec. Every standard
    /// codec is decoded; legacy `lzma` (id 2) is best-effort but still
    /// reported as supported so the read path attempts it.
    pub fn is_supported(&self) -> bool {
        true
    }
}

/// Decompress one SquashFS block. `input` is the raw on-disk (compressed)
/// bytes; `max_out` is the upper bound on the decompressed length (8 KiB
/// for metadata blocks, the archive block size for data blocks). Returns
/// the decompressed bytes.
pub fn decompress(comp: Compressor, input: &[u8], max_out: usize) -> Result<Vec<u8>> {
    match comp {
        Compressor::Gzip => decompress_zlib(input, max_out),
        Compressor::Xz => decompress_xz(input, max_out),
        Compressor::Lzma => decompress_lzma_alone(input, max_out),
        Compressor::Lz4 => decompress_lz4(input, max_out),
        Compressor::Zstd => decompress_zstd(input, max_out),
        Compressor::Lzo => {
            // The codec crate has its own error type; map it onto ours
            // rather than leaking a dependency's type through this API.
            lzo1x::decompress(input, max_out).map_err(|e| {
                Error::BadMetadata(match e {
                    lzo1x::Error::Malformed => "malformed LZO1X stream",
                })
            })
        }
    }
}

fn decompress_zlib(input: &[u8], max_out: usize) -> Result<Vec<u8>> {
    let mut out = vec![0u8; max_out];
    // `true` = the stream carries a zlib header (SquashFS gzip blocks do).
    let mut dec = Decompress::new(true);
    let status = dec
        .decompress(input, &mut out, FlushDecompress::Finish)
        .map_err(|_| Error::BadMetadata("zlib decompression failed"))?;
    // The returned `Status` is load-bearing, not decoration. A truncated
    // block is not an `Err`: the decoder consumes what it was given, emits
    // what it can, and reports `Ok(Status::Ok)` / `Ok(Status::BufError)` —
    // "I would like more input". Only `StreamEnd` means the whole stream
    // was decoded. Discarding the status returned that partial output as a
    // successful short block, which every caller then treats as real data.
    if status != Status::StreamEnd {
        return Err(Error::BadMetadata("zlib stream did not finish"));
    }
    let produced = dec.total_out() as usize;
    if produced > max_out {
        return Err(Error::BadMetadata("decompressed block exceeds max size"));
    }
    out.truncate(produced);
    Ok(out)
}

fn decompress_xz(input: &[u8], max_out: usize) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(max_out.min(1 << 20));
    let mut reader = BufReader::new(input);
    lzma_rs::xz_decompress(&mut reader, &mut out)
        .map_err(|_| Error::BadMetadata("xz decompression failed"))?;
    if out.len() > max_out {
        return Err(Error::BadMetadata("decompressed block exceeds max size"));
    }
    Ok(out)
}

/// Legacy `lzma` (id 2): the old `.lzma` "alone" stream format (5-byte
/// properties + 8-byte uncompressed size + LZMA1 payload). SquashFS only
/// emitted this from very old `mksquashfs`; modern archives use xz. Decoded
/// best-effort via `lzma_rs::lzma_decompress`.
fn decompress_lzma_alone(input: &[u8], max_out: usize) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(max_out.min(1 << 20));
    let mut reader = BufReader::new(input);
    lzma_rs::lzma_decompress(&mut reader, &mut out)
        .map_err(|_| Error::BadMetadata("lzma decompression failed"))?;
    if out.len() > max_out {
        return Err(Error::BadMetadata("decompressed block exceeds max size"));
    }
    Ok(out)
}

fn decompress_lz4(input: &[u8], max_out: usize) -> Result<Vec<u8>> {
    // SquashFS stores the raw LZ4 *block* payload; the uncompressed length
    // is the SquashFS block geometry (`max_out`), not an LZ4 frame header.
    let mut out = vec![0u8; max_out];
    let written = lz4_flex::block::decompress_into(input, &mut out)
        .map_err(|_| Error::BadMetadata("lz4 decompression failed"))?;
    out.truncate(written);
    Ok(out)
}

fn decompress_zstd(input: &[u8], max_out: usize) -> Result<Vec<u8>> {
    let mut dec = ruzstd::decoding::StreamingDecoder::new(input)
        .map_err(|_| Error::BadMetadata("zstd frame decode init failed"))?;
    let mut out: Vec<u8> = Vec::with_capacity(max_out.min(1 << 20));
    dec.read_to_end(&mut out)
        .map_err(|_| Error::BadMetadata("zstd decompression failed"))?;
    if out.len() > max_out {
        return Err(Error::BadMetadata("decompressed block exceeds max size"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compress, Compression, FlushCompress};

    fn zlib_compress(data: &[u8]) -> Vec<u8> {
        // `true` here = produce a zlib-wrapped stream.
        let mut enc = Compress::new(Compression::default(), true);
        let mut out = vec![0u8; data.len() + 64];
        enc.compress(data, &mut out, FlushCompress::Finish).unwrap();
        out.truncate(enc.total_out() as usize);
        out
    }

    #[test]
    fn from_id_maps_known_codecs() {
        assert_eq!(Compressor::from_id(1).unwrap(), Compressor::Gzip);
        assert_eq!(Compressor::from_id(3).unwrap(), Compressor::Lzo);
        assert_eq!(Compressor::from_id(4).unwrap(), Compressor::Xz);
        assert_eq!(Compressor::from_id(5).unwrap(), Compressor::Lz4);
        assert_eq!(Compressor::from_id(6).unwrap(), Compressor::Zstd);
        assert!(matches!(
            Compressor::from_id(99),
            Err(Error::UnsupportedCompression(99))
        ));
    }

    #[test]
    fn all_known_codecs_supported() {
        for c in [
            Compressor::Gzip,
            Compressor::Lzma,
            Compressor::Lzo,
            Compressor::Xz,
            Compressor::Lz4,
            Compressor::Zstd,
        ] {
            assert!(c.is_supported(), "{} should be supported", c.name());
        }
    }

    #[test]
    fn gzip_round_trip() {
        let original = b"squashfs metadata block payload, repeated repeated repeated repeated";
        let compressed = zlib_compress(original);
        let out = decompress(Compressor::Gzip, &compressed, 8192).unwrap();
        assert_eq!(&out, original);
    }

    #[test]
    fn lz4_round_trip() {
        // lz4_flex block format with the size known out-of-band, exactly
        // as SquashFS stores it.
        let original = b"the quick brown fox jumps over the lazy dog".repeat(8);
        let compressed = lz4_flex::block::compress(&original);
        let out = decompress(Compressor::Lz4, &compressed, original.len()).unwrap();
        assert_eq!(out, original);
    }

    #[test]
    fn unknown_codec_id_errors() {
        assert!(matches!(
            Compressor::from_id(7),
            Err(Error::UnsupportedCompression(7))
        ));
    }

    #[test]
    fn malformed_gzip_errors() {
        let err = decompress(Compressor::Gzip, &[0xFF, 0xFF, 0xFF, 0xFF], 64).unwrap_err();
        assert!(matches!(err, Error::BadMetadata(_)));
    }

    #[test]
    fn truncated_gzip_body_errors_rather_than_returning_short() {
        // A valid zlib header followed by a body that stops early — the
        // shape a clipped or partially-written block has on disk.
        // `malformed_gzip_errors` above does not cover this: it fails the
        // header check, whereas here the decoder starts happily and simply
        // runs out of input. miniz_oxide reports that as `Ok(Status::Ok)` /
        // `Ok(Status::BufError)`, not `Err`, so the whole distinction lives
        // in the status this function used to discard.
        //
        // Content that only half-compresses, so cutting the stream really
        // does cut decoded bytes rather than just the trailing checksum.
        let mut original = Vec::new();
        for i in 0..256u32 {
            original.extend_from_slice(&i.to_le_bytes());
            original.extend_from_slice(b"payload");
        }
        let compressed = zlib_compress(&original);
        for cut in [compressed.len() / 2, compressed.len() - 4] {
            // Named rather than `unwrap_err()` so a regression reports the
            // failure mode under test — a silent short block — instead of
            // an anonymous "called unwrap_err on an Ok value".
            match decompress(Compressor::Gzip, &compressed[..cut], 8192) {
                Err(e) => assert!(matches!(e, Error::BadMetadata(_)), "cut {cut}: {e:?}"),
                Ok(out) => panic!(
                    "truncated gzip block (cut at {cut} of {}) decoded as success: \
                     {} of {} bytes returned with no error",
                    compressed.len(),
                    out.len(),
                    original.len()
                ),
            }
        }
    }
}
