import { Directory, File, type Inode } from "@bjorn3/browser_wasi_shim";
import type { SysrootArchiveEntry } from "./sysroot_archive.ts";

const RUST_SRC_PREFIX = "lib/rustlib/src/rust/library";

export function populateWebRustSrc(
  sysroot: Map<string, Inode>,
  entries: readonly SysrootArchiveEntry[],
): void {
  for (const entry of entries) {
    const parts = [
      ...RUST_SRC_PREFIX.split("/"),
      ...new TextDecoder().decode(entry.name).split("/"),
    ];
    let contents = sysroot;
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      if (last && !entry.isDirectory) {
        contents.set(part, new File(entry.data));
        continue;
      }

      const existing = contents.get(part);
      if (existing !== undefined && !(existing instanceof Directory)) {
        throw new Error(`rust-src directory conflicts with file: ${part}`);
      }
      const directory = existing ?? new Directory(new Map<string, Inode>());
      contents.set(part, directory);
      contents = (directory as Directory).contents;
    }
  }
}
