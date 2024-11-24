import { type Inode, PreopenDirectory, File, Directory } from '@bjorn3/browser_wasi_shim';
import { WASIFarm } from '@oligami/browser_wasi_shim-threads';
import { parseTarGzip } from 'nanotar';

export const load_sysroot_part = async (
  triple: string,
): Promise<Directory> => {
  const zipped_sysroot = await fetch(
    `https://oligamiq.github.io/rust_wasm/v0.1.0/${triple}.tar.gz`,
  );
  const files = await parseTarGzip(await zipped_sysroot.arrayBuffer());
  const dir = new Map<string, Inode>();
  console.group("Loading sysroot");
  for (const file of files){
    if (!file.data) {
      throw new Error("File data not found");
    }
    if (file.name.includes("/")) {
      const parts = file.name.split("/");
      const created_dir = dir.get(parts[0]);
      if (created_dir instanceof Directory) {
        created_dir.contents.set(parts.slice(1).join("/"), new File(file.data));
      } else {
        dir.set(parts[0], new Directory([
          [parts.slice(1).join("/"), new File(file.data)]
        ]));
      }
    } else {
      dir.set(file.name, new File(file.data));
    }

    console.log(file.name);
  }
  console.groupEnd();
  return new Directory(dir);
}

const toMap = (arr: Array<[string, Inode]>) => {
  const map = new Map<string, Inode>();
  for (const [key, value] of arr) {
    map.set(key, value);
  }
  return map;
};

export const load_default_sysroot = async (): Promise<PreopenDirectory> => {
  const sysroot_part = await load_sysroot_part('wasm32-wasip1-threads');
  const sysroot = new PreopenDirectory(
    "/sysroot",
    toMap([
      ["lib", new Directory([
        ["rustlib", new Directory([
          ["wasm32-wasip1-threads", new Directory([
            ["lib", sysroot_part]
          ])]
        ])]
      ])]
    ])
  );
  return sysroot;
};

export const get_default_sysroot_wasi_farm = async (): Promise<WASIFarm> => {
  const fds = [await load_default_sysroot()];
  const farm = new WASIFarm(
    undefined,
    undefined,
    undefined,
    fds,
    {
      allocator_size: 1024 * 1024 * 1024,
    },
  );
  return farm;
}
