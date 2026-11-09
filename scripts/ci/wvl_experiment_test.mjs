import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {STRONG_PROFILE} from './optimization_settings.mjs';
import {vfsFeatures, validateGate, validateResolution, experimentalVfsManifest,
  batchingSetting, parseBatchingEvidence, validateBatchingEvidence} from './wvl_experiment.mjs';

test('feature forwarding is added only to the experimental checkout manifest', () => {
  const original = '[features]\ndefault = []\n[dependencies]\nwasi_virt_layer = "0.10.0"\n';
  const changed = experimentalVfsManifest(original);
  assert.ok(changed.includes('waiter-aware-memory-lock = ["wasi_virt_layer/waiter-aware-memory-lock"]'));
  assert.ok(changed.endsWith('[dependencies]\nwasi_virt_layer = "0.10.0"\n'));
  assert.throws(() => experimentalVfsManifest(changed), /already/);
  assert.throws(() => experimentalVfsManifest('[dependencies]\n'), /features/);
});

test('VFS feature arguments are explicit and reject unknown modes', () => {
  assert.deepEqual(vfsFeatures('baseline'), []);
  assert.deepEqual(vfsFeatures('waiter-aware'), ['--features', 'waiter-aware-memory-lock']);
  for (const mode of ['batching-off', 'batching-on']) {
    assert.deepEqual(vfsFeatures(mode), ['--features', 'waiter-aware-memory-lock']);
  }
  assert.equal(batchingSetting('batching-off'), 'off');
  assert.equal(batchingSetting('batching-on'), 'on');
  assert.equal(batchingSetting('waiter-aware'), 'off');
  assert.throws(() => batchingSetting('automatic'), /mode/);
  assert.throws(() => vfsFeatures('enabled'), /mode/);
});

test('gate must be a successful WVL lock run at the pinned revision', () => {
  const revision = 'a'.repeat(40);
  const run = {head_sha: revision, event: 'push', conclusion: 'success', path: '.github/workflows/memory-lock.yml',
    head_repository: {full_name: 'oligamiq/wasi_virt_layer'}};
  assert.doesNotThrow(() => validateGate(revision, run));
  for (const change of [{head_sha: 'b'.repeat(40)}, {conclusion: 'failure'},
    {path: '.github/workflows/release.yml'}, {event: 'pull_request'}, {head_repository: {full_name: 'other/repo'}}]) {
    assert.throws(() => validateGate(revision, {...run, ...change}));
  }
});

test('metadata must resolve the VFS direct dependency to the pinned checkout and correct feature', () => {
  const metadata = {packages: [
    {id: 'vfs', name: 'vfs'}, {id: 'wvl', name: 'wasi_virt_layer', manifest_path: '/wvl/wasi_virt_layer/Cargo.toml'}],
    resolve: {nodes: [{id: 'vfs', deps: [{name: 'wasi_virt_layer', pkg: 'wvl'}]},
      {id: 'wvl', features: ['threads', 'own-memory', 'waiter-aware-memory-lock']}]}};
  assert.doesNotThrow(() => validateResolution(metadata, '/wvl', 'waiter-aware'));
  for (const mode of ['batching-off', 'batching-on']) {
    assert.doesNotThrow(() => validateResolution(metadata, '/wvl', mode));
  }
  assert.throws(() => validateResolution(metadata, '/wvl', 'baseline'), /feature/);
  assert.throws(() => validateResolution(metadata, '/other', 'waiter-aware'), /checkout/);
  metadata.resolve.nodes[1].features.pop();
  assert.doesNotThrow(() => validateResolution(metadata, '/wvl', 'baseline'));
  for (const mode of ['batching-off', 'batching-on']) {
    assert.throws(() => validateResolution(metadata, '/wvl', mode), /feature/);
  }
});

const batchingEvidence = enabled => ({enabled, scalarAccesses: 10,
  acquires: enabled ? 6 : 10, elidedAcquires: enabled ? 4 : 0, maxBatchOperators: 64});

test('lowering evidence requires one observed record and real candidate elisions', () => {
  for (const enabled of [false, true]) {
    const setting = enabled ? 'on' : 'off';
    const evidence = batchingEvidence(enabled);
    const line = `[wvl-memory-lock-batching] ${JSON.stringify(evidence)}`;
    assert.deepEqual(parseBatchingEvidence(`other output\n${line}\n`, setting), evidence);
    assert.throws(() => parseBatchingEvidence('', setting), /exactly one/);
    assert.throws(() => parseBatchingEvidence(`${line}\n${line}`, setting), /exactly one/);
    assert.throws(() => validateBatchingEvidence(evidence, enabled ? 'off' : 'on'), /mode/);
  }
  assert.throws(() => parseBatchingEvidence('[wvl-memory-lock-batching] {broken}', 'on'), SyntaxError);
  assert.throws(() => validateBatchingEvidence({...batchingEvidence(false), enabled: true}, 'on'), /elisions/);
  assert.throws(() => validateBatchingEvidence({...batchingEvidence(true), enabled: false}, 'off'), /must not elide/);
  assert.throws(() => validateBatchingEvidence(batchingEvidence(false), 'auto'), /setting/);
});

test('packaging binds actual lowering evidence to the waiter-aware preview identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rubrc-batching-package-'));
  try {
    for (const path of ['.github', 'ci-logs', 'page/dist']) await mkdir(join(root, path), {recursive: true});
    await writeFile(join(root, '.github/stdlib-cache-wvl-revision'), 'a'.repeat(40));
    await writeFile(join(root, '.github/stdlib-cache-analyzer-revision'), 'b'.repeat(40));
    await writeFile(join(root, 'ci-logs/optimization-evidence.json'), JSON.stringify({profile: STRONG_PROFILE,
      acceptedWvlOutputs: 7, optimizerCommands: 9, rustCommands: 3}));
    const env = {...process.env, GITHUB_ACTIONS: 'true', GITHUB_SHA: 'c'.repeat(40),
      RUBRC_OPTIMIZATION_PROFILE: STRONG_PROFILE.name, VFS_CORE_OPT_LEVEL: 'O3',
      ACTUAL_VFS_CORE_OPT_LEVEL: 'O3', RUBRC_VFS_INITIAL_HEAP_BYTES: '536870912'};
    const script = fileURLToPath(new URL('./wvl_experiment.mjs', import.meta.url));
    const run = (setting, overrides = {}) => execFileSync(process.execPath, [script, 'package', `batching-${setting}`],
      {cwd: root, env: {...env, WVL_MEMORY_LOCK_BATCHING: setting, ...overrides}, stdio: 'pipe'});
    for (const setting of ['off', 'on']) {
      const evidence = batchingEvidence(setting === 'on');
      await writeFile(join(root, 'ci-logs/build.log'), `[wvl-memory-lock-batching] ${JSON.stringify(evidence)}\n`);
      run(setting);
      const metadata = JSON.parse(await readFile(join(root, 'page/dist/__rubrc_measurement_build.json'), 'utf8'));
      const bytes = await readFile(join(root, 'page/dist/__rubrc_memory_lock_batching_evidence.json'));
      assert.equal(metadata.memoryLockMode, 'waiter-aware');
      assert.equal(metadata.memoryLockBatching, setting);
      assert.deepEqual(JSON.parse(bytes), evidence);
      assert.equal(metadata.memoryLockBatchingEvidenceSha256, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(await readFile(join(root, 'ci-logs/memory-lock-batching-evidence.json')), bytes);
      assert.throws(() => run(setting, {WVL_MEMORY_LOCK_BATCHING: setting === 'on' ? 'off' : 'on'}), /environment mismatch/);
    }
    await writeFile(join(root, 'ci-logs/build.log'), 'no lowering proof\n');
    assert.throws(() => run('on'), /exactly one/);
    await writeFile(join(root, 'ci-logs/build.log'), `[wvl-memory-lock-batching] ${JSON.stringify(batchingEvidence(false))}\n`);
    assert.throws(() => run('on'), /mode mismatch/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('lowering evidence rejects missing, invalid and inconsistent counters', () => {
  for (const key of ['scalarAccesses', 'acquires', 'elidedAcquires']) {
    for (const value of [undefined, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateBatchingEvidence({...batchingEvidence(true), [key]: value}, 'on'), /counter/);
    }
  }
  assert.throws(() => validateBatchingEvidence({...batchingEvidence(true), acquires: 7}, 'on'), /counter mismatch/);
  assert.throws(() => validateBatchingEvidence({...batchingEvidence(true), maxBatchOperators: 128}, 'on'), /budget/);
  assert.throws(() => validateBatchingEvidence({enabled: false, scalarAccesses: 0, acquires: 0,
    elidedAcquires: 0, maxBatchOperators: 64}, 'off'), /missing scalar/);
});
