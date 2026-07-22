import { Directory, File, type Inode } from "@bjorn3/browser_wasi_shim";
import { populateWebRustSrc } from "./web_sysroot.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("rust-src entries populate the child-module sysroot path", () => {
  const bytes = new TextEncoder().encode("core library");
  const sysroot = new Map<string, Inode>();
  populateWebRustSrc(sysroot, [
    {
      name: new TextEncoder().encode("core/src/lib.rs"),
      data: bytes,
      isDirectory: false,
    },
  ]);

  let inode: Inode | undefined = new Directory(sysroot);
  for (const part of "lib/rustlib/src/rust/library/core/src/lib.rs".split(
    "/",
  )) {
    inode = inode instanceof Directory ? inode.contents.get(part) : undefined;
  }
  if (!(inode instanceof File)) {
    throw new Error("exact child-module core path is missing");
  }
  assert(
    new TextDecoder().decode(inode.data) === "core library",
    "child-module core bytes differ from the archive",
  );
  assert(bytes.length === 12, "archive entry bytes were mutated");
});
