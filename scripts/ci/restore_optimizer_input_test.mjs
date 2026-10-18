import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { restoreOptimizerInput } from "./restore_optimizer_input.mjs";

async function fixture(t, corrupt = false, expectedMismatch = false) {
  await mkdir("/tmp/opencode", { recursive: true });
  const root = await mkdtemp("/tmp/opencode/optimizer-input-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, "preview", "assets");
  await mkdir(assets, { recursive: true });
  const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const compressed = brotliCompressSync(corrupt ? Buffer.from("different bytes") : bytes);
  const split = Math.floor(compressed.length / 2);
  await writeFile(join(assets, "core.part-0"), compressed.subarray(0, split));
  await writeFile(join(assets, "core.part-1"), compressed.subarray(split));
  await writeFile(join(assets, "core.wasm.br.json"), JSON.stringify({
    originalFile: `vfs.core-${hash}.wasm`, originalSize: bytes.length,
    parts: [{ file: "core.part-0" }, { file: "core.part-1" }],
  }));
  await writeFile(join(root, "preview", "__rubrc_measurement_build.json"), JSON.stringify({
    sourceSha: "a".repeat(40), analyzerSha: "b".repeat(40), coreOptimization: "none",
  }));
  const checksums = join(root, "checksums.txt");
  await writeFile(checksums, `${expectedMismatch ? "0".repeat(64) : hash}  dist/vfs.core.wasm\n`);
  return { root, bytes, hash, checksums, output: join(root, "dist", "vfs.core.wasm") };
}

test("restore the exact original core from ordered Brotli parts and CI checksum", async t => {
  const f = await fixture(t);
  const result = await restoreOptimizerInput(join(f.root, "preview"), f.checksums, f.output);
  assert.equal(result.sha256, f.hash);
  assert.deepEqual(await readFile(f.output), f.bytes);
  assert.equal(result.sourceSha, "a".repeat(40));
});

test("reject disagreement between the preview manifest and CI checksum", async t => {
  const f = await fixture(t, false, true);
  await assert.rejects(restoreOptimizerInput(join(f.root, "preview"), f.checksums, f.output), /checksum mismatch/);
});

test("reject corrupt decoded bytes without replacing an existing input", async t => {
  const f = await fixture(t, true);
  await mkdir(join(f.root, "dist"));
  await writeFile(f.output, "preserve this input");
  await assert.rejects(restoreOptimizerInput(join(f.root, "preview"), f.checksums, f.output), /checksum mismatch/);
  assert.equal(await readFile(f.output, "utf8"), "preserve this input");
  assert.deepEqual(await readdir(join(f.root, "dist")), ["vfs.core.wasm"]);
});
