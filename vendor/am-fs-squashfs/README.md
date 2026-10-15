# rust-fs-squashfs

Pure-Rust, **read-only** [SquashFS](https://docs.kernel.org/filesystems/squashfs.html)
driver. A clean-room SquashFS 4.0 reader over the shared
[`am-fs-core`](https://github.com/antimatter-studios/rust-fs-core) block-device
trait, exposing a stable C ABI (`fs_squashfs_*`) for FFI from Swift/FSKit, C, or Go.

SquashFS is a compressed, read-only filesystem — a peer format to ext4/ntfs/erofs,
not built on top of any of them. It cannot be modified in place (you regenerate the
whole image with `mksquashfs`), so this crate has **no write path**: the C ABI is the
read subset of its sister drivers' surface — no mkfs / create / write.

## Status

| Area | Support |
|------|---------|
| On-disk version | SquashFS 4.0 |
| Compression | **gzip** (id 1), **xz** (id 4), **lz4** (id 5), **zstd** (id 6), **lzo** (LZO1X, id 3) |
| Compression (legacy) | `lzma` (id 2) — best-effort |
| Inodes | basic + extended: dir, file, symlink, dev/fifo/socket |
| Data | full blocks, sparse blocks, tail fragments |
| Lookup tables | id (uid/gid), fragment |
| xattrs | not yet surfaced |

Every standard compressor `mksquashfs` can emit is decoded. gzip/xz/zstd use their
container stream formats (zlib / `.xz` / zstd frames); lz4 uses the raw LZ4 block
format with the uncompressed size taken from the block geometry; lzo is a clean-room
LZO1X decoder.

## Crate layout

- `superblock` — 96-byte superblock parse + validate
- `decompress` — codec dispatch (gzip / xz / lz4 / zstd / lzo, all pure-Rust)
- `lzo1x` — clean-room LZO1X decompressor (no liblzo2-derived code)
- `metablock` — 8 KiB metadata-block reader + cross-block cursor
- `table` — indirect lookup tables (id, fragment)
- `inode` — all SquashFS inode shapes
- `dir` — directory-listing parser
- `fs` — top-level handle: path lookup, dir listing, file/symlink read
- `capi` — C ABI exports matching `include/fs_squashfs.h`

## CLI

```sh
cargo run --release --bin lssquashfs -- <image> info
cargo run --release --bin lssquashfs -- <image> tree /
cargo run --release --bin lssquashfs -- <image> cat /path/to/file
```

## Library use

```rust
use std::sync::Arc;
use fs_core::{BlockRead, FileDevice};
use fs_squashfs::Filesystem;

let dev = Arc::new(FileDevice::open("image.sqfs")?) as Arc<dyn BlockRead>;
let fs = Filesystem::open(dev)?;
let inode = fs.lookup_path("/etc/hostname")?;
let mut buf = vec![0u8; inode.file_size as usize];
fs.read_file(&inode, 0, &mut buf)?;
```

## Tests

```sh
cargo test                          # unit + in-crate tests (no external tools)
cargo test --release -- --ignored   # oracle tests: need `squashfs-tools` on PATH
cargo clippy --all-targets -- -D warnings
```

The oracle tests (`tests/oracle_compat.rs`) build a fixture tree with
`mksquashfs -comp {gzip,xz,lz4,zstd,lzo}` and read every path back through the
driver, asserting exact bytes. They are `#[ignore]`-gated so `cargo test` stays
green on a host without `squashfs-tools`; run them with `-- --ignored`.

## License

MIT — see [LICENSE](LICENSE).
