import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {brotliCompressSync} from 'node:zlib';
import {validatePair, summarizeSession, compareSessions, verifyArchive, verifyPreviewArtifacts,
  verifyBatchingPreview} from './paired_startup.mjs';
import {STRONG_PROFILE} from './optimization_settings.mjs';

const build = mode => ({sourceSha: 'a'.repeat(40), analyzerSha: 'b'.repeat(40),
  wvlRevision: 'c'.repeat(40), memoryLockMode: mode, coreOptimization: 'O1',
  coreOptimizationRequested: 'O1', vfsInitialHeapBytes: 536870912, vfsMemoryTelemetry: 1});

test('strong comparison rejects lower, missing or mixed optimization profiles', () => {
  const strong = mode => ({...build(mode), coreOptimization: 'O3', coreOptimizationRequested: 'O3',
    optimizationProfile: STRONG_PROFILE, optimizationEvidenceSha256: 'e'.repeat(64)});
  assert.doesNotThrow(() => validatePair(strong('baseline'), strong('waiter-aware')));
  assert.throws(() => validatePair(strong('baseline'), build('waiter-aware')), /profile/);
  assert.throws(() => validatePair(strong('baseline'), {...strong('waiter-aware'), coreOptimization: 'O1'}), /O3/);
  assert.throws(() => validatePair(strong('baseline'), {...strong('waiter-aware'), optimizationEvidenceSha256: undefined}), /evidence/);
  assert.throws(() => validatePair(strong('baseline'), {...strong('waiter-aware'), optimizationProfile:
    {...STRONG_PROFILE, rust: {...STRONG_PROFILE.rust, lto: 'thin'}}}), /profile/);
});
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

const batchingBuild = setting => ({...build('waiter-aware'), memoryLockBatching: setting,
  memoryLockBatchingEvidenceSha256: 'f'.repeat(64), coreOptimization: 'O3', coreOptimizationRequested: 'O3',
  optimizationProfile: STRONG_PROFILE, optimizationEvidenceSha256: 'e'.repeat(64)});
const batchingRows = (setting, semantic) => rows('waiter-aware', semantic).map(row =>
  row.kind === 'build' ? {kind: 'build', ...batchingBuild(setting)} : row);

test('batching pair requires the same waiter-aware library and opposite verified settings', () => {
  const off = batchingBuild('off'), on = batchingBuild('on');
  assert.doesNotThrow(() => validatePair(off, on, {requireBatching: true}));
  assert.throws(() => validatePair(build('baseline'), build('waiter-aware'), {requireBatching: true}), /batching metadata/);
  assert.throws(() => validatePair(off, {...on, memoryLockMode: 'baseline'}), /waiter-aware/);
  assert.throws(() => validatePair({...off, memoryLockMode: 'baseline'}, on), /waiter-aware/);
  assert.throws(() => validatePair(off, {...on, memoryLockBatching: 'off'}), /must be on/);
  assert.throws(() => validatePair({...off, memoryLockBatching: 'on'}, on), /must be off/);
  for (const missing of [undefined, null, 'auto']) {
    assert.throws(() => validatePair(off, {...on, memoryLockBatching: missing}), /must be on/);
  }
  assert.throws(() => validatePair(off, {...on, memoryLockBatchingEvidenceSha256: undefined}), /batching evidence/);
  assert.throws(() => validatePair(off, {...on, wvlRevision: 'd'.repeat(40)}), /mismatch/);
  assert.throws(() => validatePair(off, {...on, optimizationProfile: undefined}), /profile/);
  assert.throws(() => validatePair(off, {...on, coreOptimization: 'O1'}), /O3/);
});

test('batching sessions retain A-B-B-A order and bind setting plus evidence identity', () => {
  const sessions = [
    summarizeSession(batchingRows('off', [100, 120]), batchingBuild('off')),
    summarizeSession(batchingRows('on', [70, 80]), batchingBuild('on')),
    summarizeSession(batchingRows('on', [75, 85]), batchingBuild('on')),
    summarizeSession(batchingRows('off', [110, 130]), batchingBuild('off')),
  ];
  assert.deepEqual(sessions.map(row => row.mode), ['batching-off', 'batching-on', 'batching-on', 'batching-off']);
  assert.equal(compareSessions(sessions).decision, 'improved');
  sessions[2].semanticMedianMs = 115;
  assert.equal(compareSessions(sessions).decision, 'inconclusive');
  sessions[1].semanticMedianMs = 130;
  sessions[2].semanticMedianMs = 140;
  assert.equal(compareSessions(sessions).decision, 'regressed');
  assert.throws(() => compareSessions([sessions[1], sessions[0], ...sessions.slice(2)]), /order/);
  assert.throws(() => summarizeSession(batchingRows('on'), batchingBuild('off')), /identity/);
  assert.throws(() => summarizeSession(batchingRows('on'), {...batchingBuild('on'),
    memoryLockBatchingEvidenceSha256: 'd'.repeat(64)}), /identity/);
});

test('batching preview verifies evidence digest, mode and actual elisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rubrc-batching-'));
  try {
    const evidence = {enabled: true, scalarAccesses: 10, acquires: 6, elidedAcquires: 4, maxBatchOperators: 64};
    const bytes = JSON.stringify(evidence);
    const metadata = {...batchingBuild('on'), memoryLockBatchingEvidenceSha256:
      createHash('sha256').update(bytes).digest('hex')};
    const path = join(root, '__rubrc_memory_lock_batching_evidence.json');
    await writeFile(path, bytes);
    assert.deepEqual(await verifyBatchingPreview(root, metadata), evidence);
    await assert.rejects(verifyBatchingPreview(root, {...metadata, memoryLockBatching: 'off'}), /mode/);
    await assert.rejects(verifyBatchingPreview(root, {...metadata, memoryLockBatchingEvidenceSha256: undefined}), /checksum/);
    await writeFile(path, JSON.stringify({...evidence, acquires: 10, elidedAcquires: 0}));
    await assert.rejects(verifyBatchingPreview(root, metadata), /checksum/);
    const noElisions = JSON.stringify({...evidence, acquires: 10, elidedAcquires: 0});
    await assert.rejects(verifyBatchingPreview(root, {...metadata, memoryLockBatchingEvidenceSha256:
      createHash('sha256').update(noElisions).digest('hex')}), /elisions/);
  } finally { await rm(root, {recursive: true, force: true}); }
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
