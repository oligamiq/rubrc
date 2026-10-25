import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const exec = promisify(execFile);
export function experimentalVfsManifest(manifest) {
  assert.ok(!manifest.includes('waiter-aware-memory-lock'), 'experimental feature already configured');
  assert.match(manifest, /^\[features\]$/m, 'VFS features section missing');
  return manifest.replace(/^\[features\]$/m,
    '[features]\nwaiter-aware-memory-lock = ["wasi_virt_layer/waiter-aware-memory-lock"]');
}

export function vfsFeatures(mode) {
  assert.ok(['baseline', 'waiter-aware'].includes(mode), 'invalid memory lock mode');
  return mode === 'waiter-aware' ? ['--features', 'waiter-aware-memory-lock'] : [];
}

export function validateGate(revision, run) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(run.head_sha, revision, 'gate revision mismatch');
  assert.equal(run.conclusion, 'success', 'WVL gate did not pass');
  assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'gate must test the raw revision, not a PR merge');
  assert.equal(run.path, '.github/workflows/memory-lock.yml', 'unexpected gate workflow');
  assert.equal(run.head_repository?.full_name, 'oligamiq/wasi_virt_layer', 'unexpected gate repository');
}

export function validateResolution(metadata, wvlRoot, mode) {
  vfsFeatures(mode);
  const vfs = metadata.packages.find(pkg => pkg.name === 'vfs');
  assert.ok(vfs, 'VFS package missing');
  const node = metadata.resolve.nodes.find(node => node.id === vfs.id);
  const dependency = node?.deps.find(dep => dep.name === 'wasi_virt_layer');
  const library = metadata.packages.find(pkg => pkg.id === dependency?.pkg);
  assert.equal(library?.manifest_path, join(resolve(wvlRoot), 'wasi_virt_layer/Cargo.toml'), 'wrong WVL checkout');
  const features = metadata.resolve.nodes.find(node => node.id === library.id)?.features;
  assert.ok(features?.includes('threads') && features.includes('own-memory'), 'required VFS features missing');
  assert.equal(features.includes('waiter-aware-memory-lock'), mode === 'waiter-aware', 'resolved lock feature mismatch');
}

async function configure(wvlRoot, mode) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'experimental override requires CI checkout');
  const features = vfsFeatures(mode);
  const expected = (await readFile('.github/stdlib-cache-wvl-revision', 'utf8')).trim();
  assert.match(expected, /^[a-f0-9]{40}$/);
  const {stdout: actual} = await exec('git', ['-C', wvlRoot, 'rev-parse', 'HEAD']);
  assert.equal(actual.trim(), expected, 'checked-out WVL revision mismatch');
  const manifest = await readFile('Cargo.toml', 'utf8');
  assert.ok(!manifest.includes('[patch.crates-io]'), 'refusing to replace an existing dependency override');
  // Cargo validates dependency feature references even when disabled. Keep
  // this forwarding feature out of the normal manifest that uses registry 0.10.
  const vfsManifest = experimentalVfsManifest(await readFile('crates/vfs/Cargo.toml', 'utf8'));
  await writeFile('Cargo.toml', `${manifest}\n[patch.crates-io]\nwasi_virt_layer = { path = ${JSON.stringify(join(resolve(wvlRoot), 'wasi_virt_layer'))} }\n`);
  await writeFile('crates/vfs/Cargo.toml', vfsManifest);
  const args = ['metadata', '--format-version', '1', '--manifest-path', 'crates/vfs/Cargo.toml',
    '--filter-platform', 'wasm32-wasip1-threads', ...features];
  const {stdout, stderr} = await exec('cargo', args, {maxBuffer: 32 * 1024 * 1024, timeout: 300000});
  if (stderr) console.error(stderr);
  validateResolution(JSON.parse(stdout), wvlRoot, mode);
  await mkdir('ci-logs', {recursive: true});
  await writeFile('ci-logs/wvl-resolution.json', stdout);
  console.log(JSON.stringify({wvlRevision: expected, memoryLockMode: mode}));
}

async function packageMetadata(mode) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  vfsFeatures(mode);
  const revision = (await readFile('.github/stdlib-cache-wvl-revision', 'utf8')).trim();
  assert.match(revision, /^[a-f0-9]{40}$/);
  const metadata = {
    sourceSha: process.env.GITHUB_SHA,
    analyzerSha: (await readFile('.github/stdlib-cache-analyzer-revision', 'utf8')).trim(),
    wvlRevision: revision, memoryLockMode: mode,
    coreOptimizationRequested: process.env.VFS_CORE_OPT_LEVEL,
    coreOptimization: process.env.ACTUAL_VFS_CORE_OPT_LEVEL,
    vfsMemoryTelemetry: 1, vfsInitialHeapBytes: Number(process.env.RUBRC_VFS_INITIAL_HEAP_BYTES),
  };
  for (const key of ['sourceSha', 'analyzerSha']) assert.match(metadata[key] ?? '', /^[a-f0-9]{40}$/);
  assert.equal(metadata.coreOptimizationRequested, 'O1');
  assert.equal(metadata.coreOptimization, 'O1', 'refusing an unoptimized comparison preview');
  assert.equal(metadata.vfsInitialHeapBytes, 536870912);
  await writeFile('page/dist/__rubrc_measurement_build.json', JSON.stringify(metadata));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'features' && args.length === 1) {
    for (const value of vfsFeatures(args[0])) console.log(value);
  } else if (action === 'gate' && args.length === 2) {
    validateGate((await readFile(args[0], 'utf8')).trim(), JSON.parse(await readFile(args[1], 'utf8')));
  } else if (action === 'configure' && args.length === 2) await configure(...args);
  else if (action === 'package' && args.length === 1) await packageMetadata(args[0]);
  else throw new Error('invalid WVL experiment action/arguments');
}
