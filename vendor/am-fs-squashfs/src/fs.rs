//! Top-level read-only SquashFS filesystem handle.
//!
//! Ties the superblock, metadata reader, inode/dir parsers, and lookup
//! tables together into a path-addressable read API:
//! [`Filesystem::open`] → [`Filesystem::lookup_path`] →
//! [`Filesystem::read_file`] / [`Filesystem::read_dir`] /
//! [`Filesystem::read_symlink_target`].

use std::sync::Arc;

use crate::decompress::{self, Compressor};
use crate::dir::{self, DirEntry};
use crate::error::{Error, Result};
use crate::inode::Inode;
use crate::metablock::MetaCursor;
use crate::superblock::{self, Superblock};
use crate::table::{self, FragmentEntry};
use fs_core::BlockRead;

pub struct Filesystem {
    dev: Arc<dyn BlockRead>,
    pub sb: Superblock,
    comp: Compressor,
    /// uid/gid id table — inode `uid_idx` / `gid_idx` index into this.
    id_table: Vec<u32>,
    /// Fragment table — a file's `fragment_index` indexes into this.
    fragments: Vec<FragmentEntry>,
}

impl Filesystem {
    /// Open a SquashFS image over a block device. Reads + validates the
    /// superblock, rejects unsupported compressors up front (every
    /// metadata read needs the codec), and loads the small id + fragment
    /// tables once.
    pub fn open(dev: Arc<dyn BlockRead>) -> Result<Self> {
        let sb = superblock::read(&*dev)?;
        let comp = sb.compressor()?;
        if !comp.is_supported() {
            return Err(Error::UnsupportedCompression(sb.compression_id));
        }
        let id_table = table::read_id_table(&*dev, &sb)?;
        let fragments = table::read_fragment_table(&*dev, &sb)?;
        Ok(Filesystem {
            dev,
            sb,
            comp,
            id_table,
            fragments,
        })
    }

    /// The archive-wide compressor.
    pub fn compressor(&self) -> Compressor {
        self.comp
    }

    /// Resolve a uid index to its real uid (0 if out of range).
    pub fn resolve_uid(&self, idx: u16) -> u32 {
        self.id_table.get(idx as usize).copied().unwrap_or(0)
    }
    /// Resolve a gid index to its real gid (0 if out of range).
    pub fn resolve_gid(&self, idx: u16) -> u32 {
        self.id_table.get(idx as usize).copied().unwrap_or(0)
    }

    pub fn read_inode(&self, inode_ref: u64) -> Result<Inode> {
        Inode::read(&*self.dev, &self.sb, inode_ref)
    }

    pub fn root_inode(&self) -> Result<Inode> {
        self.read_inode(self.sb.root_inode_ref)
    }

    /// List a directory's entries (linear order; `.`/`..` are implicit and
    /// not returned).
    pub fn read_dir(&self, inode: &Inode) -> Result<Vec<DirEntry>> {
        if !inode.is_dir() {
            return Err(Error::NotADirectory);
        }
        let listing_len = inode.dir_listing_len();
        if listing_len == 0 {
            return Ok(Vec::new());
        }
        let start_abs = self.sb.directory_table_start + inode.dir_start_block as u64;
        let mut cur = MetaCursor::new(&*self.dev, &self.sb, start_abs, inode.dir_block_offset)?;
        let buf = cur.read_exact(listing_len)?;
        dir::parse_listing(&buf)
    }

    /// Look up a single name in a directory (linear scan).
    pub fn lookup(&self, dir: &Inode, name: &[u8]) -> Result<Inode> {
        for e in self.read_dir(dir)? {
            if e.name == name {
                return self.read_inode(e.inode_ref);
            }
        }
        Err(Error::NotFound)
    }

    /// Resolve a `/`-separated path from the root. Symlinks are returned
    /// as-is (not followed) — FSKit/the kernel handles symlink expansion
    /// via `readlink`.
    pub fn lookup_path(&self, path: &str) -> Result<Inode> {
        let mut node = self.root_inode()?;
        for comp in path.split('/').filter(|c| !c.is_empty()) {
            if !node.is_dir() {
                return Err(Error::NotADirectory);
            }
            node = self.lookup(&node, comp.as_bytes())?;
        }
        Ok(node)
    }

    /// A symlink's raw target bytes.
    pub fn read_symlink_target(&self, inode: &Inode) -> Result<Vec<u8>> {
        if !inode.is_symlink() {
            return Err(Error::BadInode("read_symlink_target on non-symlink"));
        }
        Ok(inode.symlink_target.clone())
    }

    /// Read up to `buf.len()` bytes from a regular file starting at
    /// `offset`. Returns the number of bytes copied (0 at/after EOF;
    /// short when the read crosses EOF). EOF is the *only* reason for a
    /// short return: a data block that decodes to less than its logical
    /// length is corruption, and comes back as an error rather than as
    /// fewer bytes.
    pub fn read_file(&self, inode: &Inode, offset: u64, buf: &mut [u8]) -> Result<usize> {
        if !inode.is_regular_file() {
            return Err(Error::BadInode("read_file on non-file"));
        }
        let size = inode.file_size;
        if offset >= size || buf.is_empty() {
            return Ok(0);
        }
        let to_read = buf.len().min((size - offset) as usize);
        let bs = self.sb.block_size as u64;

        // Precompute each full block's absolute on-disk start once
        // (prefix sum of on-disk sizes) so per-block reads stay O(1).
        let block_offsets = self.block_offsets(inode);

        let mut written = 0usize;
        while written < to_read {
            let abs_pos = offset + written as u64;
            let block_idx = (abs_pos / bs) as usize;
            let block_off = (abs_pos % bs) as usize;

            let block = self.read_logical_block(inode, block_idx, &block_offsets)?;
            if block_off >= block.len() {
                // Nothing to copy and no progress to make. `read_logical_block`
                // returns a block of exactly the length this offset was
                // computed against, so reaching here means the image lied
                // about a block; the loop must not spin, and it must not
                // report the bytes copied so far as a complete read either.
                return Err(Error::BadInode(
                    "data block shorter than the offset read from it",
                ));
            }
            let take = (block.len() - block_off).min(to_read - written);
            buf[written..written + take].copy_from_slice(&block[block_off..block_off + take]);
            written += take;
        }
        Ok(written)
    }

    /// Absolute on-disk start offset of each full data block.
    fn block_offsets(&self, inode: &Inode) -> Vec<u64> {
        let mut offs = Vec::with_capacity(inode.block_sizes.len());
        let mut cursor = inode.blocks_start;
        for &sz in &inode.block_sizes {
            offs.push(cursor);
            cursor += table::data_on_disk_size(sz) as u64;
        }
        offs
    }

    /// Decompress one logical block of a file: a full data block for
    /// `block_idx < block_sizes.len()`, otherwise the tail fragment.
    fn read_logical_block(
        &self,
        inode: &Inode,
        block_idx: usize,
        block_offsets: &[u64],
    ) -> Result<Vec<u8>> {
        let bs = self.sb.block_size as u64;
        let n_full = inode.block_sizes.len();

        if block_idx < n_full {
            let logical_len = bs.min(inode.file_size - block_idx as u64 * bs) as usize;
            let size_word = inode.block_sizes[block_idx];
            if table::data_on_disk_size(size_word) == 0 {
                // Sparse block — all zeros, no on-disk payload.
                return Ok(vec![0u8; logical_len]);
            }
            let block = self.read_data_block(block_offsets[block_idx], size_word, logical_len)?;
            // A full data block's decoded length is not a matter of opinion:
            // the file size and the block geometry fix it exactly. A codec
            // cannot check this for us — a stream that ends cleanly after
            // fewer bytes than it should is well-formed as far as the
            // decoder is concerned — and this is the only place that knows
            // the expected length, so it is the only place that can refuse.
            if block.len() != logical_len {
                return Err(Error::BadInode("data block decoded to the wrong length"));
            }
            Ok(block)
        } else if inode.has_fragment() {
            let frag = self
                .fragments
                .get(inode.fragment_index as usize)
                .ok_or(Error::BadInode("fragment index out of range"))?;
            let frag_block =
                self.read_data_block(frag.start, frag.size, self.sb.block_size as usize)?;
            let tail_len = (inode.file_size - n_full as u64 * bs) as usize;
            let start = inode.fragment_offset as usize;
            let end = start
                .checked_add(tail_len)
                .ok_or(Error::BadInode("fragment offset overflow"))?;
            if end > frag_block.len() {
                return Err(Error::BadInode("fragment tail past fragment block end"));
            }
            Ok(frag_block[start..end].to_vec())
        } else {
            Err(Error::OutOfRange)
        }
    }

    /// Read + decompress one data block. `size_word` carries the on-disk
    /// size + compressed bit; `max_out` bounds the decompressed length.
    fn read_data_block(&self, abs_off: u64, size_word: u32, max_out: usize) -> Result<Vec<u8>> {
        let on_disk = table::data_on_disk_size(size_word) as usize;
        let mut raw = vec![0u8; on_disk];
        self.dev.read_at(abs_off, &mut raw)?;
        if table::data_is_compressed(size_word) {
            decompress::decompress(self.comp, &raw, max_out)
        } else {
            if raw.len() > max_out {
                return Err(Error::BadInode(
                    "uncompressed data block exceeds block size",
                ));
            }
            Ok(raw)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inode::TYPE_BASIC_FILE;
    use crate::metablock::tests::MemDev;
    use crate::superblock::tests::synth_sb;
    use flate2::{Compress, Compression, FlushCompress};
    use std::sync::Mutex;

    const BLOCK_LOG: u16 = 12;
    const BLOCK_SIZE: usize = 1 << BLOCK_LOG;

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut enc = Compress::new(Compression::default(), true);
        let mut out = vec![0u8; data.len() + 64];
        enc.compress(data, &mut out, FlushCompress::Finish).unwrap();
        out.truncate(enc.total_out() as usize);
        out
    }

    /// A `Filesystem` over raw bytes. The file-read path touches only the
    /// superblock and the device, so the lookup tables stay empty.
    fn fs_over(bytes: Vec<u8>) -> Filesystem {
        Filesystem {
            dev: Arc::new(MemDev(Mutex::new(bytes))),
            sb: Superblock::parse(&synth_sb(BLOCK_LOG, 0, 0)).unwrap(),
            comp: Compressor::Gzip,
            id_table: Vec::new(),
            fragments: Vec::new(),
        }
    }

    /// A regular-file inode whose data blocks start at offset 0.
    fn file_inode(file_size: u64, block_sizes: Vec<u32>) -> Inode {
        Inode {
            inode_type: TYPE_BASIC_FILE,
            permissions: 0o644,
            uid_idx: 0,
            gid_idx: 0,
            mtime: 0,
            inode_number: 1,
            nlink: 1,
            file_size,
            dir_start_block: 0,
            dir_block_offset: 0,
            blocks_start: 0,
            fragment_index: crate::superblock::SQUASHFS_INVALID_FRAG,
            fragment_offset: 0,
            block_sizes,
            symlink_target: Vec::new(),
        }
    }

    #[test]
    fn short_data_block_is_an_error_not_a_short_read() {
        // A *well-formed* zlib stream that decodes to far fewer bytes than
        // the block it stands in. No codec can catch this — the stream is
        // valid and ends cleanly — so the only place that can is the read
        // path, which knows how long the block is supposed to be.
        //
        // Reported as a successful 5-byte read before this was fixed:
        // indistinguishable, to a caller, from a legitimate read at EOF.
        let stream = zlib(b"short");
        let mut img = stream.clone();
        img.resize(BLOCK_SIZE, 0); // the rest of the on-disk block slot
        let fs = fs_over(img);
        // Size word: low 24 bits = on-disk length, bit 24 clear = compressed.
        let inode = file_inode(BLOCK_SIZE as u64, vec![stream.len() as u32]);

        let mut buf = vec![0u8; BLOCK_SIZE];
        match fs.read_file(&inode, 0, &mut buf) {
            Err(e) => assert!(matches!(e, Error::BadInode(_)), "{e:?}"),
            Ok(n) => panic!(
                "corrupt data block reported as a successful short read of \
                 {n} bytes (file is {BLOCK_SIZE} bytes)"
            ),
        }
    }

    #[test]
    fn whole_blocks_still_read_back_intact() {
        // The guard above must not reject a healthy file: one full block
        // plus a partial last block, which is the shape every non-fragment
        // file has.
        let payload: Vec<u8> = (0..BLOCK_SIZE + 100).map(|i| (i % 251) as u8).collect();
        let first = zlib(&payload[..BLOCK_SIZE]);
        let last = zlib(&payload[BLOCK_SIZE..]);
        let mut img = first.clone();
        img.extend_from_slice(&last);
        let fs = fs_over(img);
        let inode = file_inode(
            payload.len() as u64,
            vec![first.len() as u32, last.len() as u32],
        );

        let mut buf = vec![0u8; payload.len()];
        let n = fs.read_file(&inode, 0, &mut buf).unwrap();
        assert_eq!(n, payload.len());
        assert_eq!(buf, payload);
    }
}
