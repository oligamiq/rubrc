import {
  type Inode,
  PreopenDirectory,
  File,
  Directory,
} from "@bjorn3/browser_wasi_shim";

import { fetch_compressed_stream } from "./brotli_stream";
import { parseTar } from "./parse_tar";

export const load_sysroot_part = async (triple: string): Promise<Directory> => {
  const decompressed_stream = await fetch_compressed_stream(
    `https://oligamiq.github.io/rust_wasm/v0.2.0/${triple}.tar.br`,
  );

  const dir = new Map<string, Inode>();
  console.group("Loading sysroot");

  await parseTar(decompressed_stream, (file) => {
    const parts = file.name.split("/");
    let current_dir_contents = dir;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      let next_dir = current_dir_contents.get(part);
      if (!(next_dir instanceof Directory)) {
        next_dir = new Directory([]);
        current_dir_contents.set(part, next_dir);
      }
      current_dir_contents = next_dir.contents;
    }

    const last_part = parts[parts.length - 1];
    if (file.type === "directory") {
      if (last_part && !current_dir_contents.has(last_part)) {
        current_dir_contents.set(last_part, new Directory([]));
      }
    } else if (file.data) {
      current_dir_contents.set(last_part, new File(file.data));
    }

    console.log(file.name);
  });
  console.groupEnd();
  return new Directory(dir);
};
