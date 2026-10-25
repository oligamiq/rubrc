import {test} from 'node:test';
import assert from 'node:assert/strict';
import {vfsFeatures, validateGate, validateResolution, experimentalVfsManifest} from './wvl_experiment.mjs';

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
  assert.throws(() => validateResolution(metadata, '/wvl', 'baseline'), /feature/);
  assert.throws(() => validateResolution(metadata, '/other', 'waiter-aware'), /checkout/);
  metadata.resolve.nodes[1].features.pop();
  assert.doesNotThrow(() => validateResolution(metadata, '/wvl', 'baseline'));
});
