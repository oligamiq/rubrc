import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';

const DIST_DIR = process.argv[2];
const OUT_DIR_ARG = process.argv[3];
if (!DIST_DIR) {
  console.error("Usage: node prepare-vfs-asset.mjs <dist_dir> [out_dir]");
  process.exit(1);
}

const vfsPartBytesStr = process.env.VFS_PART_BYTES ?? "25165824";
const PART_SIZE = Number(vfsPartBytesStr);
if (!Number.isSafeInteger(PART_SIZE) || PART_SIZE < 1 || PART_SIZE > 25165824) {
  console.error("Invalid VFS_PART_BYTES");
  process.exit(1);
}

const brotliQualityStr = process.env.VFS_BROTLI_QUALITY ?? "11";
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

async function findVfsManifests(dir) {
  let manifests = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "v1") {
        manifests.push(...await findVfsManifests(fullPath));
      }
    } else if (entry.isFile() && /^vfs\.core-.*\.wasm\.br\.json$/.test(entry.name)) {
      manifests.push(fullPath);
    }
  }
  return manifests;
}

async function findVfsBr(dir) {
  let brFiles = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "v1") {
        brFiles.push(...await findVfsBr(fullPath));
      }
    } else if (entry.isFile() && /^vfs\.core-.*\.wasm\.br$/.test(entry.name)) {
      brFiles.push(fullPath);
    }
  }
  return brFiles;
}

async function main() {
  const TARGET_DIR = OUT_DIR_ARG ? path.resolve(OUT_DIR_ARG) : path.resolve(DIST_DIR);

  if (OUT_DIR_ARG && path.resolve(DIST_DIR) !== TARGET_DIR) {
    console.log(`Copying original folder to output folder to preserve structure and files...`);
    async function copyDir(src, dest) {
      await fs.promises.mkdir(dest, { recursive: true });
      const entries = await fs.promises.readdir(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          await copyDir(srcPath, destPath);
        } else {
          await fs.promises.copyFile(srcPath, destPath);
        }
      }
    }
    await copyDir(DIST_DIR, TARGET_DIR);
  }

  // Generate _headers file
  const headersPath = path.join(TARGET_DIR, '_headers');
  const headersContent = `/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n`;
  await fs.promises.writeFile(headersPath, headersContent);

  const wasmFiles = await findVfsWasm(TARGET_DIR);
  
  if (wasmFiles.length === 0) {
    let manifests = [];
    try { manifests = await findVfsManifests(TARGET_DIR); } catch (e) {}

    if (manifests.length > 0) {
      console.log("Already processed (WASM file already removed, .br.json exists). Skipping.");
      process.exit(0);
    }
    
    let brFiles = [];
    try { brFiles = await findVfsBr(TARGET_DIR); } catch (e) {}
    if (brFiles.length > 0) {
      console.error("Error: Found .br cache but .wasm file is missing, cannot determine original size for manifest.");
      process.exit(1);
    }

    console.error("Error: Expected exactly 1 vfs.core wasm file, but found 0");
    process.exit(1);
  } else if (wasmFiles.length > 1) {
    console.error(`Error: Expected exactly 1 vfs.core wasm file, but found ${wasmFiles.length}`);
    process.exit(1);
  }

  const wasmFile = wasmFiles[0];
  const outDir = path.dirname(wasmFile);
  const baseName = path.basename(wasmFile);

  const finalManifestPath = path.join(outDir, `${baseName}.br.json`);
  if (fs.existsSync(finalManifestPath)) {
    console.log(`Already compressed (${baseName}.br.json exists). Skipping.`);
    await fs.promises.unlink(wasmFile);
    process.exit(0);
  }

  const stats = await fs.promises.stat(wasmFile);
  const originalSize = stats.size;

  const splitter = new SplitterStream(baseName, outDir);
  
  const manifestName = `${baseName}.br.json`;
  const manifestPath = path.join(outDir, manifestName);
  const manifestTmpPath = `${manifestPath}.tmp`;

  const publishedFiles = [];
  try {
    const cachedBrPath = path.join(outDir, `${baseName}.br`);
    
    if (fs.existsSync(cachedBrPath)) {
      console.log(`Found cached ${baseName}.br. Using it for splitting...`);
      const brStats = await fs.promises.stat(cachedBrPath);
      const readStream = fs.createReadStream(cachedBrPath);
      let bytesRead = 0;
      readStream.on('data', (chunk) => {
        bytesRead += chunk.length;
        const percent = ((bytesRead / brStats.size) * 100).toFixed(1);
        process.stdout.write(`\r[Progress] Splitting cached .br: ${percent}% (${bytesRead}/${brStats.size} bytes)`);
      });
      readStream.on('end', () => {
        process.stdout.write(`\n[Progress] Splitting complete.\n`);
      });
      await pipeline(readStream, splitter);
    } else {
      const brotliProc = spawn('brotli', ['-q', BROTLI_QUALITY.toString(), '-c']);
      brotliProc.stderr.on('data', (d) => console.error(`brotli stderr: ${d}`));

      const readStream = fs.createReadStream(wasmFile);
      let bytesRead = 0;
      readStream.on('data', (chunk) => {
        bytesRead += chunk.length;
        const percent = ((bytesRead / originalSize) * 100).toFixed(1);
        process.stdout.write(`\r[Progress] Reading & Compressing: ${percent}% (${bytesRead}/${originalSize} bytes)`);
      });
      readStream.on('end', () => {
        process.stdout.write(`\n[Progress] Read complete. Waiting for Brotli to finalize compression...\n`);
      });

      const p1 = pipeline(readStream, brotliProc.stdin);
      const p2 = pipeline(brotliProc.stdout, splitter);
      const procPromise = new Promise((resolve, reject) => {
        brotliProc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`brotli command failed with exit code ${code}. Please check stderr logs.`));
        });
        brotliProc.on('error', (err) => {
          if (err.code === 'ENOENT') {
            reject(new Error("The 'brotli' command was not found. Please ensure the native 'brotli' CLI is installed locally."));
          } else {
            reject(new Error(`Failed to execute brotli command: ${err.message}`));
          }
        });
      });

      await Promise.all([p1, p2, procPromise]);
    }

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

    const manifest = {
      version: 1,
      encoding: "br",
      originalFile: baseName,
      originalSize: originalSize,
      compressedSize: splitter.compressedSize,
      parts: splitter.parts.map(p => ({ file: p.file, size: p.size })),
    };

    await fs.promises.writeFile(manifestTmpPath, JSON.stringify(manifest, null, 2));

    const oldFiles = await fs.promises.readdir(outDir);
    for (const file of oldFiles) {
      if (file === manifestName || file.startsWith(`${baseName}.br.part-`)) {
        if (!file.endsWith('.tmp')) {
          await fs.promises.unlink(path.join(outDir, file));
        }
      }
    }

    for (const p of splitter.parts) {
      const finalPath = path.join(outDir, p.file);
      await fs.promises.rename(p.tmpFile, finalPath);
      publishedFiles.push(finalPath);
      if (process.env.VFS_TEST_FAIL_AFTER_FIRST_PART_RENAME === "1" && publishedFiles.length === 1) {
        throw new Error("Injected failure after first part rename");
      }
    }

    await fs.promises.rename(manifestTmpPath, manifestPath);
    publishedFiles.push(manifestPath);

    await fs.promises.unlink(wasmFile);

    console.log(`Successfully compressed and split ${baseName}`);
  } catch (err) {
    console.error("Compression/splitting failed:", err);
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
