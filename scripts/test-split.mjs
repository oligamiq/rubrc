import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const TEMP_DIR = path.join(process.cwd(), 'temp_test_dist');

async function createRandomFile(filePath, size) {
  const buffer = crypto.randomBytes(size);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function runPrepare(envOverrides = {}) {
  return execFileSync(process.execPath, ['scripts/prepare-vfs-asset.mjs', TEMP_DIR], {
    env: { ...process.env, ...envOverrides },
    stdio: 'pipe',
    encoding: 'utf-8'
  });
}

function runVerify() {
  return execFileSync(process.execPath, ['scripts/verify-vfs-asset.mjs', TEMP_DIR], {
    stdio: 'pipe',
    encoding: 'utf-8'
  });
}

async function testSplit() {
  try {
    await fs.promises.rm(TEMP_DIR, { recursive: true, force: true });

    // 1. Target Wasm == 0 -> fail
    console.log("Test: Target Wasm == 0");
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    try {
      runPrepare();
      throw new Error("Should have failed with 0 Wasm files");
    } catch (e) {
      if (!e.stderr.includes("Expected exactly 1")) throw e;
    }

    // 2. Target Wasm == 2 -> fail
    console.log("Test: Target Wasm == 2");
    await fs.promises.writeFile(path.join(TEMP_DIR, 'vfs.core-1.wasm'), "dummy");
    await fs.promises.writeFile(path.join(TEMP_DIR, 'vfs.core-2.wasm'), "dummy");
    try {
      runPrepare();
      throw new Error("Should have failed with 2 Wasm files");
    } catch (e) {
      if (!e.stderr.includes("Expected exactly 1")) throw e;
    }

    // Cleanup for next tests
    await fs.promises.rm(TEMP_DIR, { recursive: true, force: true });

    // 3. VFS_PART_BYTES=0 -> fail
    console.log("Test: VFS_PART_BYTES = 0");
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(TEMP_DIR, 'vfs.core-dummy.wasm'), "dummy");
    try {
      runPrepare({ VFS_PART_BYTES: "0" });
      throw new Error("Should have failed with VFS_PART_BYTES=0");
    } catch (e) {
      if (!e.stderr.includes("Invalid VFS_PART_BYTES")) throw e;
    }

    // 4. VFS_PART_BYTES > 25165824 -> fail
    console.log("Test: VFS_PART_BYTES > 25165824");
    try {
      runPrepare({ VFS_PART_BYTES: "25165825" });
      throw new Error("Should have failed with VFS_PART_BYTES > 25165824");
    } catch (e) {
      if (!e.stderr.includes("Invalid VFS_PART_BYTES")) throw e;
    }

    // 5. Normal multi-part generation & SHA-256 match
    console.log("Test: Normal multi-part generation & SHA-256 match");
    await fs.promises.rm(TEMP_DIR, { recursive: true, force: true });
    const originalSize = 2.5 * 1024 * 1024;
    const wasmPath = path.join(TEMP_DIR, 'vfs.core-test.wasm');
    const originalSha256 = await createRandomFile(wasmPath, originalSize);
    // Create dummy v1 to pass verifier
    const v1Path = path.join(TEMP_DIR, 'v1');
    await fs.promises.mkdir(v1Path, { recursive: true });
    await fs.promises.writeFile(path.join(v1Path, 'index.html'), "hello");

    runPrepare({ VFS_PART_BYTES: "65536", VFS_BROTLI_QUALITY: "1" });

    runVerify();

    const manifestPath = path.join(TEMP_DIR, 'vfs.core-test.wasm.br.json');
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
    if (manifest.parts.length < 2) throw new Error("Expected multiple parts");

    let compressedData = [];
    for (const part of manifest.parts) {
      compressedData.push(await fs.promises.readFile(path.join(TEMP_DIR, part.file)));
    }
    const fullCompressedBuffer = Buffer.concat(compressedData);
    const decompressedBuffer = zlib.brotliDecompressSync(fullCompressedBuffer);
    const decompressedSha256 = crypto.createHash('sha256').update(decompressedBuffer).digest('hex');
    if (originalSha256 !== decompressedSha256) throw new Error("SHA-256 mismatch");

    // 6. Stale part cleanup
    console.log("Test: Stale part cleanup");
    // We have parts generated. Now re-create the Wasm and run with a larger part size to produce fewer parts.
    await createRandomFile(wasmPath, originalSize);
    runPrepare({ VFS_PART_BYTES: "1048576", VFS_BROTLI_QUALITY: "1" });

    runVerify(); // Verify should pass, meaning old extra parts were deleted

    const manifest2 = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
    if (manifest2.parts.length >= manifest.parts.length) {
      throw new Error("Expected fewer parts in second run");
    }

    // 7. Extra part in dir -> verifier fails
    console.log("Test: Extra part in dir -> verifier fails");
    const extraPartPath = path.join(TEMP_DIR, 'vfs.core-test.wasm.br.part-999');
    await fs.promises.writeFile(extraPartPath, "fake");
    try {
      runVerify();
      throw new Error("Verifier should have failed with orphan part");
    } catch (e) {
      if (!e.stderr.includes("VFS part file set does not match manifest")) throw e;
    }
    await fs.promises.unlink(extraPartPath);

    // 8. File > 25 MiB in v1 -> verifier fails
    console.log("Test: File > 25 MiB in v1 -> verifier fails");
    const hugeFilePath = path.join(v1Path, 'huge.txt');
    // Using truncate to create a sparse file quickly
    const fd = await fs.promises.open(hugeFilePath, 'w');
    await fd.truncate(30 * 1024 * 1024);
    await fd.close();

    try {
      runVerify();
      throw new Error("Verifier should have failed with huge file");
    } catch (e) {
      if (!e.stderr.includes("exceeds Cloudflare Pages absolute limit")) throw e;
    }
    await fs.promises.unlink(hugeFilePath);

    // 9. Extra part-1000 -> verifier fails
    console.log("Test: Extra part-1000 -> verifier fails");
    const part1000Path = path.join(TEMP_DIR, 'vfs.core-test.wasm.br.part-1000');
    await fs.promises.writeFile(part1000Path, "fake");
    try {
      runVerify();
      throw new Error("Verifier should have failed with part-1000");
    } catch (e) {
      if (!e.stderr.includes("VFS part file set does not match manifest")) throw e;
    }
    await fs.promises.unlink(part1000Path);

    // 10. Duplicate valid part in subdir -> verifier fails
    console.log("Test: Duplicate valid part in subdir -> verifier fails");
    const subdirPath = path.join(TEMP_DIR, 'duplicate');
    await fs.promises.mkdir(subdirPath, { recursive: true });
    const duplicatePartPath = path.join(subdirPath, 'vfs.core-test.wasm.br.part-000');
    await fs.promises.writeFile(duplicatePartPath, "fake");
    try {
      runVerify();
      throw new Error("Verifier should have failed with duplicate part in subdir");
    } catch (e) {
      if (!e.stderr.includes("VFS part file set does not match manifest")) throw e;
    }
    await fs.promises.rm(subdirPath, { recursive: true, force: true });

    // 11. Extra part-bad -> verifier fails
    console.log("Test: Extra part-bad -> verifier fails");
    const partBadPath = path.join(TEMP_DIR, 'vfs.core-test.wasm.br.part-bad');
    await fs.promises.writeFile(partBadPath, "fake");
    try {
      runVerify();
      throw new Error("Verifier should have failed with part-bad");
    } catch (e) {
      if (!e.stderr.includes("VFS part file set does not match manifest")) throw e;
    }
    await fs.promises.unlink(partBadPath);

    // 11. Manifest file name != originalFile -> verifier fails
    console.log("Test: Manifest file name != originalFile -> verifier fails");
    const badManifestPath = path.join(TEMP_DIR, 'vfs.core-badname.wasm.br.json');
    await fs.promises.writeFile(badManifestPath, await fs.promises.readFile(manifestPath, 'utf-8'));
    await fs.promises.unlink(manifestPath);
    try {
      runVerify();
      throw new Error("Verifier should have failed with manifest name mismatch");
    } catch (e) {
      if (!e.stderr.includes("does not match originalFile")) throw e;
    }
    await fs.promises.rename(badManifestPath, manifestPath);

    // 12. Runtime validator reject test
    console.log("Test: Runtime validator reject test");
    function runtimeValidate(man) {
      for (let i = 0; i < man.parts.length; i++) {
        const part = man.parts[i];
        const expected = `${man.originalFile}.br.part-${i.toString().padStart(3, "0")}`;
        if (part.file !== expected) throw new Error("bad part name");
        if (part.size > 25165824) throw new Error("bad size");
      }
    }
    const runtimeManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
    runtimeManifest.parts[0].file = "data:something";
    try {
      runtimeValidate(runtimeManifest);
      throw new Error("Should have thrown on data:");
    } catch(e) {
      if (!e.message.includes("bad part name")) throw e;
    }
    runtimeManifest.parts[0].file = `${runtimeManifest.originalFile}.br.part-000`;
    runtimeManifest.parts[0].size = 25165825;
    try {
      runtimeValidate(runtimeManifest);
      throw new Error("Should have thrown on size limit");
    } catch(e) {
      if (!e.message.includes("bad size")) throw e;
    }

    // 13. Rename rollback on failure
    console.log("Test: Rename rollback on failure");
    await fs.promises.rm(TEMP_DIR, { recursive: true, force: true });
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    const rbWasm = path.join(TEMP_DIR, 'vfs.core-rb.wasm');
    await createRandomFile(rbWasm, 1024);

    // We want to generate multiple parts so we set part bytes small.
    try {
      runPrepare({ VFS_PART_BYTES: "512", VFS_TEST_FAIL_AFTER_FIRST_PART_RENAME: "1" });
      throw new Error("Should have failed during rename");
    } catch(e) {
      if (!e.stderr.includes("Injected failure after first part rename")) throw e;
    }

    const rbFiles = await fs.promises.readdir(TEMP_DIR);
    if (!rbFiles.includes('vfs.core-rb.wasm')) {
      throw new Error("Rollback failed: original Wasm was deleted");
    }
    const leftOvers = rbFiles.filter(f => f !== 'vfs.core-rb.wasm');
    if (leftOvers.length > 0) {
      throw new Error("Rollback failed, left files behind: " + leftOvers.join(', '));
    }

    // 13. Trailing whitespace check
    console.log("Test: Trailing whitespace check");
    const checkFiles = [
      '.github/workflows/static.yml',
      'package.json',
      'page/src/worker_process/util_cmd.ts',
      'scripts/prepare-vfs-asset.mjs',
      'scripts/test-split.mjs',
      'scripts/verify-vfs-asset.mjs'
    ];
    for (const f of checkFiles) {
      const content = await fs.promises.readFile(path.join(process.cwd(), f), 'utf-8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (/[ \t]+$/.test(lines[i])) {
          throw new Error(`Trailing whitespace in ${f} at line ${i + 1}`);
        }
      }
    }

    console.log("All tests passed successfully!");
  } finally {
    try { await fs.promises.rm(TEMP_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}

testSplit().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
