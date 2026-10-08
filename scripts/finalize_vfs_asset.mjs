import { createReadStream } from "node:fs";
import { copyFile, readdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export async function finalizeVfsAsset({ source, dist }) {
  const directory = join(dist, "assets");
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) =>
      entry.isFile() && /^vfs\.core-.*\.wasm$/.test(entry.name)
    );
  if (matches.length !== 1) {
    throw new Error(`Expected one bundled VFS module, found ${matches.length}`);
  }
  const output = join(directory, matches[0].name);
  const expected = await digest(source);
  // Keep the filename referenced by the generated JS, but bypass the bundler's
  // large binary-asset buffer. The compiled module must be copied losslessly.
  const temporary = `${output}.verified-tmp`;
  try {
    await copyFile(source, temporary);
    if (await digest(temporary) !== expected) {
      throw new Error("VFS asset copy failed SHA-256 verification");
    }
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return { output, sha256: expected };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await finalizeVfsAsset({
    source: fileURLToPath(
      new URL(
        "../page/src/worker_process/vfs_bindings/vfs.core.wasm",
        import.meta.url,
      ),
    ),
    dist: fileURLToPath(new URL("../page/dist", import.meta.url)),
  });
  console.log(`VFS asset verified: ${result.sha256}`);
}
