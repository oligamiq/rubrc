import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress } from "node:zlib";

export async function restoreOptimizerInput(root, checksums, output) {
  const build = JSON.parse(await readFile(join(root, "__rubrc_measurement_build.json"), "utf8"));
  if (build.coreOptimization !== "none") throw new Error("replay requires an unoptimized preview");
  if (![build.sourceSha, build.analyzerSha].every(sha => /^[0-9a-f]{40}$/.test(sha))) throw new Error("invalid build identity");
  const assets = join(root, "assets");
  const names = (await readdir(assets)).filter(name => name.endsWith(".wasm.br.json"));
  if (names.length !== 1) throw new Error("expected one VFS core manifest");
  const manifest = JSON.parse(await readFile(join(assets, names[0]), "utf8"));
  const manifestHash = /^vfs\.core-([0-9a-f]{64})\.wasm$/.exec(manifest.originalFile)?.[1];
  const expected = (await readFile(checksums, "utf8")).split(/\r?\n/)
    .find(line => /\s+dist\/vfs\.core\.wasm$/.test(line))?.trim().split(/\s+/)[0];
  if (!manifestHash || !/^[0-9a-f]{64}$/.test(expected ?? "") || expected !== manifestHash) {
    throw new Error("manifest/CI checksum mismatch");
  }
  if (!Number.isSafeInteger(manifest.originalSize) || manifest.originalSize <= 0 || manifest.originalSize > 1024 ** 3) {
    throw new Error("invalid decoded core size");
  }
  if (!Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.some(part =>
    typeof part.file !== "string" || part.file !== basename(part.file) || part.file === "." || part.file === "..")) {
    throw new Error("invalid part filenames");
  }
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".optimizer-input-"));
  const hash = createHash("sha256");
  let bytes = 0;
  async function* parts() { for (const part of manifest.parts) yield* createReadStream(join(assets, part.file)); }
  try {
    await pipeline(Readable.from(parts()), createBrotliDecompress(), new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > manifest.originalSize) return callback(new Error("decoded checksum mismatch: excess bytes"));
        hash.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(join(temporary, "core.wasm"), { flags: "wx" }));
    const sha256 = hash.digest("hex");
    if (sha256 !== expected || bytes !== manifest.originalSize) throw new Error("decoded checksum mismatch");
    await rename(join(temporary, "core.wasm"), output);
    return { sourceSha: build.sourceSha, analyzerSha: build.analyzerSha, inputOptimization: "none", sha256, bytes };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [, , root, checksums, output] = process.argv;
  if (!root || !checksums || !output) throw new Error("usage: restore_optimizer_input <preview> <checksums> <output>");
  console.log(JSON.stringify(await restoreOptimizerInput(root, checksums, output)));
}
