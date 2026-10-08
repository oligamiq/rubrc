import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./copy_vfs_bindings.mjs', import.meta.url));

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'vfs-bindings-copy-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  writeFileSync(join(source, 'vfs.core.wasm'), wasm);
  writeFileSync(join(source, 'vfs.js'), 'export const marker = 1;\n');
  writeFileSync(join(source, 'worker.ts'), 'const memory = { initial: 12 };\n');
  writeFileSync(join(target, 'inst.ts'), '// application-owned binding\n');
  try {
    run({ root, source, target, wasm });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('bindings copy rejects a single-bit WASM corruption', () => fixture(({ root, source, target, wasm }) => {
  const preload = join(root, 'corrupt-copy.mjs');
  // Inject the observed failure at the filesystem boundary, leaving the real
  // copy script and the original generated WASM unchanged.
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const copy = fs.cpSync;
    fs.cpSync = (...args) => {
      copy(...args);
      const path = join(args[1], 'vfs.core.wasm');
      const bytes = fs.readFileSync(path);
      bytes[4] ^= 4;
      fs.writeFileSync(path, bytes);
    };
    syncBuiltinESMExports();
  `);
  const result = spawnSync(process.execPath, ['--import', preload, script], {
    env: { ...process.env, VFS_BINDINGS_SOURCE_DIR: source, VFS_BINDINGS_TARGET_DIR: target },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'corrupt copied WASM was accepted');
  assert.match(result.stderr, /WASM copy mismatch/);
  assert.deepEqual(readFileSync(join(source, 'vfs.core.wasm')), wasm);
  assert.equal(readFileSync(join(target, 'inst.ts'), 'utf8'), '// application-owned binding\n');
}));

test('bindings copy preserves canonical WASM and application-owned files', () => fixture(({ source, target, wasm }) => {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, VFS_BINDINGS_SOURCE_DIR: source, VFS_BINDINGS_TARGET_DIR: target },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(target, 'vfs.core.wasm')), wasm);
  assert.equal(readFileSync(join(target, 'inst.ts'), 'utf8'), '// application-owned binding\n');
  assert.match(readFileSync(join(target, 'memory_limits.ts'), 'utf8'), /VFS_INITIAL_MEMORY_PAGES = 12/);
}));
