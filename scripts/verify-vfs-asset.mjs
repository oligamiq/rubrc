import fs from 'node:fs';
import path from 'node:path';

const DIST_DIR = process.argv[2] || 'page/dist';

async function findFiles(dir) {
  let files = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function verify() {
  const allDeploymentFiles = await findFiles(DIST_DIR);
  const v1Path = path.join(DIST_DIR, 'v1') + path.sep;
  const allV2Files = allDeploymentFiles.filter(f => !f.startsWith(v1Path));

  const CF_LIMIT = 26214400; // 25 MiB
  for (const file of allDeploymentFiles) {
    const stats = await fs.promises.stat(file);
    if (stats.size > CF_LIMIT) {
      console.error(`Error: File ${file} exceeds Cloudflare Pages absolute limit of 25 MiB. Size is ${stats.size}`);
      process.exit(1);
    }
  }

  // Verify no raw v2 wasm exists
  const rawWasmFiles = allV2Files.filter(f => path.basename(f).match(/^vfs\.core-.*\.wasm$/));
  if (rawWasmFiles.length > 0) {
    console.error("Error: Uncompressed v2 VFS Wasm remains:", rawWasmFiles);
    process.exit(1);
  }

  // Find manifest
  const manifestFiles = allV2Files.filter(f => path.basename(f).match(/^vfs\.core-.*\.wasm\.br\.json$/));
  if (manifestFiles.length !== 1) {
    console.error(`Error: Expected exactly 1 manifest, found ${manifestFiles.length}`);
    process.exit(1);
  }

  const manifestPath = manifestFiles[0];
  const manifestDir = path.dirname(manifestPath);
  const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(manifestContent);

  if (manifest.version !== 1) {
    console.error(`Error: Invalid manifest version: ${manifest.version}`);
    process.exit(1);
  }
  if (manifest.encoding !== "br") {
    console.error(`Error: Invalid encoding: ${manifest.encoding}`);
    process.exit(1);
  }

  if (typeof manifest.originalFile !== 'string' || !/^vfs\.core-.*\.wasm$/.test(manifest.originalFile) || manifest.originalFile.includes('/') || manifest.originalFile.includes('\\') || manifest.originalFile.includes('..')) {
    console.error(`Error: Invalid originalFile in manifest: ${manifest.originalFile}`);
    process.exit(1);
  }

  if (path.basename(manifestPath) !== `${manifest.originalFile}.br.json`) {
    console.error(`Error: Manifest filename ${path.basename(manifestPath)} does not match originalFile ${manifest.originalFile}`);
    process.exit(1);
  }

  if (!Number.isSafeInteger(manifest.originalSize) || manifest.originalSize <= 0) {
    console.error(`Error: Invalid originalSize in manifest: ${manifest.originalSize}`);
    process.exit(1);
  }

  if (!Number.isSafeInteger(manifest.compressedSize) || manifest.compressedSize <= 0) {
    console.error(`Error: Invalid compressedSize in manifest: ${manifest.compressedSize}`);
    process.exit(1);
  }

  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    console.error(`Error: Manifest parts array is invalid or empty`);
    process.exit(1);
  }

  let totalPartSize = 0;


  for (let i = 0; i < manifest.parts.length; i++) {
    const part = manifest.parts[i];
    const expectedPartName = `${manifest.originalFile}.br.part-${i.toString().padStart(3, '0')}`;


    if (part.file !== expectedPartName) {
      console.error(`Error: Part ${i} name mismatch. Expected ${expectedPartName}, got ${part.file}`);
      process.exit(1);
    }

    if (!Number.isSafeInteger(part.size) || part.size <= 0) {
      console.error(`Error: Invalid size for part ${part.file}: ${part.size}`);
      process.exit(1);
    }

    if (part.size > 25165824) {
      console.error(`Error: Part ${part.file} exceeds project limit of 24 MiB (25165824 bytes). Size is ${part.size}`);
      process.exit(1);
    }

    const partPath = path.join(manifestDir, part.file);
    let stats;
    try {
      stats = await fs.promises.stat(partPath);
      if (!stats.isFile()) throw new Error("Not a file");
    } catch (e) {
      console.error(`Error: Part file missing or not a file: ${partPath}`);
      process.exit(1);
    }

    if (stats.size !== part.size) {
      console.error(`Error: Part size mismatch for ${part.file}. Expected ${part.size}, got ${stats.size}`);
      process.exit(1);
    }

    totalPartSize += part.size;
  }

  if (totalPartSize !== manifest.compressedSize) {
    console.error(`Error: Total part size (${totalPartSize}) does not match compressedSize (${manifest.compressedSize})`);
    process.exit(1);
  }

  // Check for orphan parts (ANY vfs.core-*.wasm.br.part-* across allV2Files)
  const actualVfsPartFiles = allV2Files.filter((file) => {
    const base = path.basename(file);
    return base.startsWith("vfs.core-") && base.includes(".wasm.br.part-");
  });

  const expectedPartPaths = new Set(
    manifest.parts.map((part) => path.resolve(manifestDir, part.file))
  );

  const actualPartPaths = new Set(
    actualVfsPartFiles.map((file) => path.resolve(file))
  );

  if (
    actualVfsPartFiles.length !== expectedPartPaths.size ||
    actualPartPaths.size !== expectedPartPaths.size ||
    [...actualPartPaths].some((file) => !expectedPartPaths.has(file))
  ) {
    const orphans = actualVfsPartFiles.filter(
      (file) => !expectedPartPaths.has(path.resolve(file))
    );

    throw new Error(
      `VFS part file set does not match manifest: ${orphans.join(", ")}`
    );
  }

  // Check v1 exists
  const v1Index = path.join(DIST_DIR, 'v1', 'index.html');
  try {
    const st = await fs.promises.stat(v1Index);
    if (!st.isFile()) throw new Error("Not a file");
  } catch (e) {
    console.error(`Error: v1 snapshot missing at ${v1Index}`);
    process.exit(1);
  }

  console.log("Verification passed successfully.");
}

verify().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
