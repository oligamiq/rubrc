import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {brotliCompressSync} from 'node:zlib';
import {validatePair, summarizeSession, compareSessions, verifyArchive, verifyPreviewArtifacts} from './paired_startup.mjs';

const build = mode => ({sourceSha: 'a'.repeat(40), analyzerSha: 'b'.repeat(40),
  wvlRevision: 'c'.repeat(40), memoryLockMode: mode, coreOptimization: 'O1',
  coreOptimizationRequested: 'O1', vfsInitialHeapBytes: 536870912, vfsMemoryTelemetry: 1});
const rows = (mode, semantic = [100, 110]) => [
  {kind: 'build', ...build(mode)},
  ...['cold', 'reload'].map((visit, index) => ({kind: 'startup', visit,
    startup: {phase: 'ready'}, semanticWarmMs: semantic[index], postSysrootMs: semantic[index] + 30,
    elapsedMs: semantic[index] + 50, missingAssets: [], workerSetupErrors: [],
    cacheReports: ['[stdlib-cache] loaded: ok', '[stdlib-cache] merged: ok'],
    parallelism: 'RA main pool (numThreads): 2 · VTP starts 8 (auto-grow) · browser 4'})),
  {kind: 'interactions', completionCount: 3, completionMs: 20, diagnosticMs: 10,
    diagnostics: "expected u32, found &'static str"},
];

test('pair must be the same source tuple and explicitly opposite lock modes', () => {
  assert.doesNotThrow(() => validatePair(build('baseline'), build('waiter-aware')));
  for (const key of ['sourceSha', 'analyzerSha', 'wvlRevision']) {
    assert.throws(() => validatePair(build('baseline'), {...build('waiter-aware'), [key]: 'd'.repeat(40)}), /mismatch/);
  }
  assert.throws(() => validatePair(build('baseline'), build('baseline')), /mode/);
  assert.throws(() => validatePair(build('baseline'), {...build('waiter-aware'), coreOptimization: 'none'}), /O1/);
  assert.throws(() => validatePair(build('baseline'), {...build('waiter-aware'), vfsInitialHeapBytes: 0}), /heap/);
  assert.throws(() => validatePair({...build('baseline'), wvlRevision: ''}, build('waiter-aware')), /revision/);
});

test('acceptance requires both visits, cache adoption, real editor results and no failures', () => {
  const valid = rows('baseline');
  assert.equal(summarizeSession(valid, build('baseline')).semanticMedianMs, 105);
  assert.throws(() => summarizeSession([...valid, {kind: 'failure'}], build('baseline')), /failure/);
  assert.throws(() => summarizeSession(valid.filter(row => row.visit !== 'reload'), build('baseline')), /visits/);
  assert.throws(() => summarizeSession(valid.map(row => row.kind === 'startup' ? {...row, cacheReports: []} : row), build('baseline')), /cache/);
  assert.throws(() => summarizeSession(valid.map(row => row.kind === 'interactions' ? {...row, completionCount: 0} : row), build('baseline')), /completion/);
  assert.throws(() => summarizeSession(rows('waiter-aware'), build('baseline')), /identity/);
});

test('comparison reports overlap as inconclusive and preserves session order', () => {
  const sessions = [
    summarizeSession(rows('baseline', [100, 120]), build('baseline')),
    summarizeSession(rows('waiter-aware', [70, 80]), build('waiter-aware')),
    summarizeSession(rows('waiter-aware', [75, 85]), build('waiter-aware')),
    summarizeSession(rows('baseline', [110, 130]), build('baseline')),
  ];
  assert.equal(compareSessions(sessions).decision, 'improved');
  sessions[2].semanticMedianMs = 115;
  assert.equal(compareSessions(sessions).decision, 'inconclusive');
  sessions[1].semanticMedianMs = 130;
  sessions[2].semanticMedianMs = 140;
  assert.equal(compareSessions(sessions).decision, 'regressed');
  assert.throws(() => compareSessions(sessions.slice(1)), /order/);
});

test('decoded core and cache must match their manifests and independent build checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rubrc-preview-'));
  try {
    await mkdir(join(root, 'assets'));
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const core = Buffer.from('small test core'), cache = Buffer.from('small test cache');
    const coreHash = digest(core), cacheHash = digest(cache);
    const encoded = brotliCompressSync(core);
    await writeFile(join(root, 'assets/core.part'), encoded);
    await writeFile(join(root, 'assets/core.wasm.br.json'), JSON.stringify({originalFile: `vfs.core-${coreHash}.wasm`,
      originalSize: core.length, parts: [{file: 'core.part', size: encoded.length}]}));
    await writeFile(join(root, 'std.part'), cache);
    await writeFile(join(root, 'std-cache.json'), JSON.stringify({hash: cacheHash, size: cache.length,
      parts: [{file: 'std.part', size: cache.length}]}));
    const checksum = join(root, 'checksums.txt');
    await writeFile(checksum, `${'a'.repeat(64)}  crates/vfs/lsp_opt.wasm\n${coreHash}  dist/vfs.core.wasm\n${coreHash}  page/src/worker_process/vfs_bindings/vfs.core.wasm\n${cacheHash}  target/std.salsa\n`);
    assert.equal((await verifyPreviewArtifacts(root, checksum)).coreSha, coreHash);
    await writeFile(join(root, 'std.part'), Buffer.from('corrupt'));
    await assert.rejects(verifyPreviewArtifacts(root, checksum));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('archive verification rejects corruption before extraction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rubrc-pair-'));
  try {
    const archive = join(root, 'preview.tar.gz');
    const checksum = join(root, 'preview-sha256.txt');
    const bytes = Buffer.from('fixture archive bytes');
    await writeFile(archive, bytes);
    await writeFile(checksum, `${createHash('sha256').update(bytes).digest('hex')}  preview.tar.gz\n`);
    await verifyArchive(archive, checksum);
    await writeFile(archive, Buffer.from('corrupt'));
    await assert.rejects(verifyArchive(archive, checksum), /checksum/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
