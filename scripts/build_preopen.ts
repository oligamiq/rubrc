import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { Directory, File, PreopenDirectory } from "@bjorn3/browser_wasi_shim";

export async function buildPreopenDirectory(
  name: string,
  path: string,
): Promise<PreopenDirectory> {
  const contents = new Map();
  async function walk(dirPath: string, currentMap: Map<string, any>) {
    for await (const entry of Deno.readDir(dirPath)) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory) {
        const subMap = new Map();
        currentMap.set(entry.name, new Directory(subMap));
        await walk(fullPath, subMap);
      } else if (entry.isFile) {
        const data = await Deno.readFile(fullPath);
        currentMap.set(entry.name, new File(data));
      }
    }
  }
  await walk(path, contents);
  return new PreopenDirectory(name, contents);
}
