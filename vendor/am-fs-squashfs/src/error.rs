//! Errors returned by the SquashFS reader.
//!
//! Modelled on the sister crates: a single `Error` enum that wraps the
//! underlying `fs_core::Error`, plus a [`Error::to_errno`] mapping the C
//! ABI uses to populate `fs_squashfs_last_errno()`.

use fs_core::Error as BlockError;

/// POSIX errno values surfaced through the C ABI. Kept local (a tiny
/// hand-rolled set) so the crate doesn't take a libc dependency just to
/// name a handful of constants.
pub mod errno {
    use std::os::raw::c_int;
    pub const EIO: c_int = 5;
    pub const ENOENT: c_int = 2;
    pub const ENOTDIR: c_int = 20;
    pub const EINVAL: c_int = 22;
    pub const ENOTSUP: c_int = 45; // macOS/BSD ENOTSUP
    pub const ERANGE: c_int = 34;
}

#[derive(Debug)]
pub enum Error {
    /// Underlying block device returned an error.
    Block(BlockError),
    /// Bytes at offset 0 don't carry the "hsqs" magic.
    NotSquashfs,
    /// Superblock parse rejected the on-disk values (bad version, impossible
    /// block size, truncated, …). The string carries a short reason.
    BadSuperblock(&'static str),
    /// A metadata block header / payload failed sanity checks.
    BadMetadata(&'static str),
    /// An inode was malformed or its type isn't one we implement.
    BadInode(&'static str),
    /// A directory listing didn't pass dirent-array sanity checks.
    BadDirent(&'static str),
    /// The image uses a compressor this build doesn't support. Carries the
    /// on-disk compression id (1=gzip, 2=lzma, 3=lzo, 4=xz, 5=lz4, 6=zstd).
    UnsupportedCompression(u16),
    /// Lookup for a name that isn't present in a directory.
    NotFound,
    /// Path component traversal hit a non-directory.
    NotADirectory,
    /// Read past the end of a file.
    OutOfRange,
}

impl Error {
    /// Map to a POSIX errno for the C ABI's `last_errno` companion.
    pub fn to_errno(&self) -> std::os::raw::c_int {
        use errno::*;
        match self {
            Error::Block(_) => EIO,
            Error::NotSquashfs => EINVAL,
            Error::BadSuperblock(_) => EINVAL,
            Error::BadMetadata(_) => EIO,
            Error::BadInode(_) => EIO,
            Error::BadDirent(_) => EIO,
            Error::UnsupportedCompression(_) => ENOTSUP,
            Error::NotFound => ENOENT,
            Error::NotADirectory => ENOTDIR,
            Error::OutOfRange => ERANGE,
        }
    }
}

impl From<BlockError> for Error {
    fn from(e: BlockError) -> Self {
        Error::Block(e)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Block(e) => write!(f, "block device: {e:?}"),
            Error::NotSquashfs => write!(f, "not a SquashFS image (magic mismatch at byte 0)"),
            Error::BadSuperblock(s) => write!(f, "malformed superblock: {s}"),
            Error::BadMetadata(s) => write!(f, "malformed metadata block: {s}"),
            Error::BadInode(s) => write!(f, "malformed inode: {s}"),
            Error::BadDirent(s) => write!(f, "malformed directory: {s}"),
            Error::UnsupportedCompression(id) => {
                write!(f, "unsupported SquashFS compressor id {id}")
            }
            Error::NotFound => write!(f, "not found"),
            Error::NotADirectory => write!(f, "not a directory"),
            Error::OutOfRange => write!(f, "read past end of file"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_and_errno_cover_each_variant() {
        let cases: &[(Error, std::os::raw::c_int, &str)] = &[
            (Error::NotSquashfs, errno::EINVAL, "magic mismatch"),
            (
                Error::BadSuperblock("bad version"),
                errno::EINVAL,
                "superblock",
            ),
            (Error::BadMetadata("short"), errno::EIO, "metadata"),
            (Error::BadInode("short"), errno::EIO, "inode"),
            (Error::BadDirent("short"), errno::EIO, "directory"),
            (
                Error::UnsupportedCompression(4),
                errno::ENOTSUP,
                "compressor id 4",
            ),
            (Error::NotFound, errno::ENOENT, "not found"),
            (Error::NotADirectory, errno::ENOTDIR, "not a directory"),
            (Error::OutOfRange, errno::ERANGE, "past end"),
        ];
        for (e, want_errno, want_sub) in cases {
            assert_eq!(e.to_errno(), *want_errno, "errno for {e:?}");
            assert!(e.to_string().contains(want_sub), "display {e:?} -> {}", e);
        }
    }

    #[test]
    fn from_block_error_wraps() {
        let be = BlockError::ShortRead {
            offset: 1,
            want: 4,
            got: 0,
        };
        let e: Error = be.into();
        assert!(matches!(e, Error::Block(_)));
        assert_eq!(e.to_errno(), errno::EIO);
    }
}
