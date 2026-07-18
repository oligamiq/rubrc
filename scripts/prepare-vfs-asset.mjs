import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';

const DIST_DIR = process.argv[2];
if (!DIST_DIR) {
  console.error("Usage: node prepare-vfs-asset.mjs <dist_dir>");
  process.exit(1);
}

const vfsPartBytesStr = process.env.VFS_PART_BYTES ?? "25165824";
const PART_SIZE = Number(vfsPartBytesStr);
if (!Number.isSafeInteger(PART_SIZE) || PART_SIZE < 1 || PART_SIZE > 25165824) {
  console.error("Invalid VFS_PART_BYTES");
  process.exit(1);
}

const brotliQualityStr = process.env.VFS_BROTLI_QUALITY ?? "9";
const BROTLI_QUALITY = Number(brotliQualityStr);
if (!Number.isInteger(BROTLI_QUALITY) || BROTLI_QUALITY < 0 || BROTLI_QUALITY > 11) {
  console.error("Invalid VFS_BROTLI_QUALITY");
  process.exit(1);
}

async function findVfsWasm(dir) {
  let wasmFiles = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "v1") {
        wasmFiles.push(...await findVfsWasm(fullPath));
      }
    } else if (entry.isFile() && /^vfs\.core-.*\.wasm$/.test(entry.name)) {
      wasmFiles.push(fullPath);
    }
  }
  return wasmFiles;
}

class SplitterStream extends Writable {
  constructor(baseName, outDir) {
    super();
    this.baseName = baseName;
    this.outDir = outDir;
    this.partIndex = 0;
    this.currentWriteStream = null;
    this.currentPartSize = 0;
    this.parts = [];
    this.compressedSize = 0;
    this.tmpFiles = [];
    this.writeError = null;
  }

  async _write(chunk, encoding, callback) {
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (!this.currentWriteStream) {
          const partName = `${this.baseName}.br.part-${this.partIndex.toString().padStart(3, '0')}`;
          const partTmpName = `${partName}.tmp`;
          const partTmpPath = path.join(this.outDir, partTmpName);
          this.currentWriteStream = fs.createWriteStream(partTmpPath);
          this.currentWriteStream.on('error', (err) => { this.writeError = err; });
          this.tmpFiles.push(partTmpPath);
          this.parts.push({ file: partName, tmpFile: partTmpPath, size: 0 });
        }

        if (this.writeError) throw this.writeError;

        const remainingInPart = PART_SIZE - this.currentPartSize;
        const toWrite = Math.min(chunk.length - offset, remainingInPart);
        const slice = chunk.subarray(offset, offset + toWrite);

        const canContinue = this.currentWriteStream.write(slice);
        this.currentPartSize += toWrite;
        this.compressedSize += toWrite;
        this.parts[this.parts.length - 1].size += toWrite;
        offset += toWrite;

        if (this.writeError) throw this.writeError;

        if (this.currentPartSize >= PART_SIZE) {
          this.currentWriteStream.end();
          await finished(this.currentWriteStream);
          if (this.writeError) throw this.writeError;
          this.currentWriteStream = null;
          this.currentPartSize = 0;
          this.partIndex++;
        } else if (!canContinue) {
          await new Promise((resolve, reject) => {
            const onError = (err) => reject(err);
            this.currentWriteStream.once('drain', () => {
              this.currentWriteStream.removeListener('error', onError);
              resolve();
            });
            this.currentWriteStream.once('error', onError);
          });
        }
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  async _final(callback) {
    try {
      if (this.currentWriteStream) {
        this.currentWriteStream.end();
        await finished(this.currentWriteStream);
        if (this.writeError) throw this.writeError;
        this.currentWriteStream = null;
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

async function main() {
  const wasmFiles = await findVfsWasm(DIST_DIR);
  if (wasmFiles.length !== 1) {
    console.error(`Error: Expected exactly 1 vfs.core wasm file, but found ${wasmFiles.length}`);
    process.exit(1);
  }

  const wasmFile = wasmFiles[0];
  const outDir = path.dirname(wasmFile);
  const baseName = path.basename(wasmFile);

  const stats = await fs.promises.stat(wasmFile);
  const originalSize = stats.size;

  const splitter = new SplitterStream(baseName, outDir);
  const brotli = zlib.createBrotliCompress({
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
    },
  });

  const manifestName = `${baseName}.br.json`;
  const manifestPath = path.join(outDir, manifestName);
  const manifestTmpPath = `${manifestPath}.tmp`;

  const publishedFiles = [];
  try {
    // 1. generate tmp parts
    await pipeline(
      fs.createReadStream(wasmFile),
      brotli,
      splitter
    );

    if (!Number.isSafeInteger(originalSize) || originalSize <= 0) {
      throw new Error("Invalid originalSize");
    }

    if (splitter.parts.length === 0) {
      throw new Error("No parts generated");
    }

    let totalPartsSize = 0;
    for (const p of splitter.parts) {
      const st = await fs.promises.stat(p.tmpFile);
      if (!st.isFile()) throw new Error(`Not a file: ${p.tmpFile}`);
      if (st.size !== p.size) throw new Error(`Size mismatch for ${p.tmpFile}: expected ${p.size}, got ${st.size}`);
      if (p.size > 25165824) throw new Error(`Part size exceeds limit: ${p.size}`);
      totalPartsSize += p.size;
    }

    if (totalPartsSize !== splitter.compressedSize) {
      throw new Error("Total parts size mismatch with compressedSize");
    }

    // 2. generate tmp manifest
    const manifest = {
      version: 1,
      encoding: "br",
      originalFile: baseName,
      originalSize: originalSize,
      compressedSize: splitter.compressedSize,
      parts: splitter.parts.map(p => ({ file: p.file, size: p.size })),
    };

    await fs.promises.writeFile(manifestTmpPath, JSON.stringify(manifest, null, 2));

    // 3. delete old manifest and parts (only after validation)
    const oldFiles = await fs.promises.readdir(outDir);
    for (const file of oldFiles) {
      if (file === manifestName || file.startsWith(`${baseName}.br.part-`)) {
        if (!file.endsWith('.tmp')) {
          await fs.promises.unlink(path.join(outDir, file));
        }
      }
    }

    // 4. rename tmp parts to final
    for (const p of splitter.parts) {
      const finalPath = path.join(outDir, p.file);
      await fs.promises.rename(p.tmpFile, finalPath);
      publishedFiles.push(finalPath);
      if (process.env.VFS_TEST_FAIL_AFTER_FIRST_PART_RENAME === "1" && publishedFiles.length === 1) {
        throw new Error("Injected failure after first part rename");
      }
    }

    // 5. rename manifest to final
    await fs.promises.rename(manifestTmpPath, manifestPath);
    publishedFiles.push(manifestPath);

    // 6. remove original wasm
    await fs.promises.unlink(wasmFile);

    console.log(`Successfully compressed and split ${baseName}`);
  } catch (err) {
    console.error("Compression/splitting failed:", err);
    // cleanup temporary and published files from this run
    for (const file of publishedFiles) {
      try { await fs.promises.unlink(file); } catch(e) {}
    }
    try { await fs.promises.unlink(manifestTmpPath); } catch(e) {}
    for (const tmp of splitter.tmpFiles) {
      try { await fs.promises.unlink(tmp); } catch(e) {}
    }
    process.exit(1);
  }
}

main();
