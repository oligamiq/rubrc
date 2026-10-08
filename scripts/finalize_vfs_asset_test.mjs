import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeVfsAsset } from "./finalize_vfs_asset.mjs";

test("bundled VFS bytes must be identical to the compiled module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rubrc-vfs-asset-"));
  try {
    const source = join(dir, "source.wasm");
    const dist = join(dir, "dist");
    await mkdir(join(dist, "assets"), { recursive: true });
    const output = join(dist, "assets/vfs.core-test.wasm");
    const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 255, 128]);
    await writeFile(source, bytes);
    await writeFile(output, Buffer.alloc(bytes.length));
    await finalizeVfsAsset({ source, dist });
    assert.deepEqual(await readFile(output), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
