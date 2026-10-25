import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join, resolve, basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createBrotliDecompress} from 'node:zlib';
import {assertVfsMemoryCoverage} from '../startup_measurement_support.mjs';

const ORDER = ['baseline', 'waiter-aware', 'waiter-aware', 'baseline'];
const IDENTITY = ['sourceSha', 'analyzerSha', 'wvlRevision', 'memoryLockMode',
  'coreOptimization', 'coreOptimizationRequested', 'vfsInitialHeapBytes', 'vfsMemoryTelemetry'];
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function validatePair(baseline, candidate) {
  assert.equal(baseline.memoryLockMode, 'baseline', 'baseline mode required');
  assert.equal(candidate.memoryLockMode, 'waiter-aware', 'candidate mode required');
  for (const field of ['sourceSha', 'analyzerSha', 'wvlRevision']) {
    assert.match(baseline[field] ?? '', /^[a-f0-9]{40}$/, `invalid ${field} revision`);
    assert.match(candidate[field] ?? '', /^[a-f0-9]{40}$/, `invalid ${field} revision`);
    assert.equal(baseline[field], candidate[field], `${field} mismatch`);
  }
  for (const build of [baseline, candidate]) {
    assert.equal(build.coreOptimization, 'O1', 'actual O1 required');
    assert.equal(build.coreOptimizationRequested, 'O1', 'requested O1 required');
    assert.equal(build.vfsInitialHeapBytes, 536870912, 'identical 512 MiB heap required');
    assert.equal(build.vfsMemoryTelemetry, 1, 'capacity coverage required');
  }
}

export async function verifyArchive(archive, checksumFile) {
  const expected = (await readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0];
  assert.match(expected, /^[a-f0-9]{64}$/, 'invalid archive checksum');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  assert.equal(hash.digest('hex'), expected, 'archive checksum mismatch');
  return expected;
}

export async function verifyPreviewArtifacts(root, checksumFile) {
  const checksums = new Map((await readFile(checksumFile, 'utf8')).trim().split(/\r?\n/).map(line => {
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
    assert.ok(match, 'invalid build checksum record');
    return [match[2], match[1]];
  }));
  const coreSha = checksums.get('dist/vfs.core.wasm');
  const lspSha = checksums.get('crates/vfs/lsp_opt.wasm');
  const cacheSha = checksums.get('target/std.salsa');
  for (const hash of [coreSha, lspSha, cacheSha]) assert.match(hash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(checksums.get('page/src/worker_process/vfs_bindings/vfs.core.wasm'), coreSha, 'bindings/core checksum mismatch');
  const assets = join(root, 'assets');
  const names = (await readdir(assets)).filter(name => name.endsWith('.wasm.br.json'));
  assert.equal(names.length, 1, 'one core manifest required');
  const core = JSON.parse(await readFile(join(assets, names[0]), 'utf8'));
  const cache = JSON.parse(await readFile(join(root, 'std-cache.json'), 'utf8'));
  assert.equal(core.originalFile, `vfs.core-${coreSha}.wasm`, 'core manifest/build checksum mismatch');
  assert.equal(cache.hash, cacheSha, 'cache manifest/build checksum mismatch');
  async function verifyParts(directory, parts, bytes, expected, brotli) {
    assert.ok(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 1024 ** 3, 'invalid payload size');
    assert.ok(Array.isArray(parts) && parts.length > 0, 'missing payload parts');
    async function* chunks() {
      for (const part of parts) {
        assert.equal(basename(part.file), part.file, 'unsafe part filename');
        assert.ok(part.file !== '.' && part.file !== '..');
        let readBytes = 0;
        for await (const chunk of createReadStream(join(directory, part.file))) {
          readBytes += chunk.length;
          yield chunk;
        }
        assert.equal(readBytes, part.size, 'part size mismatch');
      }
    }
    const hash = createHash('sha256');
    let count = 0;
    await pipeline(Readable.from(chunks()), ...(brotli ? [createBrotliDecompress()] : []), new Writable({
      write(chunk, _encoding, done) {
        count += chunk.length;
        if (count > bytes) return done(new Error('payload exceeds expected size'));
        hash.update(chunk);
        done();
      },
    }));
    assert.equal(count, bytes, 'payload size mismatch');
    assert.equal(hash.digest('hex'), expected, 'payload checksum mismatch');
  }
  await verifyParts(assets, core.parts, core.originalSize, coreSha, true);
  await verifyParts(root, cache.parts, cache.size, cacheSha, false);
  return {coreSha, lspSha, cacheSha};
}

export function summarizeSession(rows, expected) {
  assert.equal(rows.filter(row => row.kind === 'failure').length, 0, 'session failure');
  const builds = rows.filter(row => row.kind === 'build');
  assert.equal(builds.length, 1, 'one build identity required');
  for (const key of IDENTITY) assert.equal(builds[0][key], expected[key], `session identity ${key}`);
  const visits = rows.filter(row => row.kind === 'startup');
  assert.deepEqual(visits.map(row => row.visit), ['cold', 'reload'], 'both startup visits required');
  for (const row of visits) {
    assert.equal(row.startup.phase, 'ready');
    assert.deepEqual(row.missingAssets, []);
    assert.deepEqual(row.workerSetupErrors, []);
    for (const stage of ['loaded', 'merged']) {
      assert.ok(row.cacheReports.some(report => report.startsWith(`[stdlib-cache] ${stage}:`)), `cache ${stage} required`);
    }
    for (const key of ['semanticWarmMs', 'postSysrootMs', 'elapsedMs']) {
      assert.ok(Number.isFinite(row[key]) && row[key] >= 0, `invalid timing ${key}`);
    }
  }
  const editors = rows.filter(row => row.kind === 'interactions');
  assert.equal(editors.length, 1, 'one editor acceptance required');
  const editor = editors[0];
  assert.ok(editor.completionCount > 0, 'completion results required');
  assert.ok(editor.diagnostics.includes("expected u32, found &'static str"), 'type-error diagnostic required');
  for (const key of ['completionMs', 'diagnosticMs']) assert.ok(Number.isFinite(editor[key]) && editor[key] >= 0);
  assert.equal(visits[0].parallelism, visits[1].parallelism, 'worker configuration changed');
  return {
    mode: expected.memoryLockMode, build: expected,
    parallelism: visits[0].parallelism,
    semanticMedianMs: median(visits.map(row => row.semanticWarmMs)),
    visits: visits.map(row => ({visit: row.visit, elapsedMs: row.elapsedMs,
      postSysrootMs: row.postSysrootMs, semanticWarmMs: row.semanticWarmMs})),
    completionMs: editor.completionMs, diagnosticMs: editor.diagnosticMs,
    calibration: rows.find(row => row.kind === 'calibration'),
  };
}

export function compareSessions(sessions) {
  assert.deepEqual(sessions.map(row => row.mode), ORDER, 'A-B-B-A session order required');
  for (const session of sessions) {
    assert.equal(session.parallelism, sessions[0].parallelism, 'paired worker count mismatch');
    assert.equal(session.calibration?.browser, sessions[0].calibration?.browser, 'paired browser mismatch');
  }
  const baseline = sessions.filter(row => row.mode === 'baseline').map(row => row.semanticMedianMs);
  const candidate = sessions.filter(row => row.mode === 'waiter-aware').map(row => row.semanticMedianMs);
  const distribution = values => ({medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values)});
  const decision = Math.max(...candidate) < Math.min(...baseline) ? 'improved'
    : Math.min(...candidate) > Math.max(...baseline) ? 'regressed' : 'inconclusive';
  return {decision,
    baseline: distribution(baseline), candidate: distribution(candidate), sessions};
}

const readRows = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);

async function runPair(baselineRoot, candidateRoot, baselineChecksums, candidateChecksums, output) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUBRC_MEASURE_CDP) {
    throw new Error('paired browser measurement requires hosted CI and local runner browsers');
  }
  const roots = {baseline: resolve(baselineRoot), 'waiter-aware': resolve(candidateRoot)};
  const builds = {};
  for (const mode of Object.keys(roots)) builds[mode] = JSON.parse(await readFile(join(roots[mode], '__rubrc_measurement_build.json'), 'utf8'));
  validatePair(builds.baseline, builds['waiter-aware']);
  const artifacts = {
    baseline: await verifyPreviewArtifacts(roots.baseline, baselineChecksums),
    'waiter-aware': await verifyPreviewArtifacts(roots['waiter-aware'], candidateChecksums),
  };
  assert.equal(artifacts.baseline.lspSha, artifacts['waiter-aware'].lspSha, 'analyzer binary mismatch');
  assert.notEqual(artifacts.baseline.coreSha, artifacts['waiter-aware'].coreSha, 'candidate core did not change');
  await mkdir(output, {recursive: true});
  const {stdout} = await promisify(execFile)('lscpu', [], {timeout: 5000});
  await writeFile(join(output, 'runner-cpu.txt'), stdout);
  const sessions = [];
  for (const [index, mode] of ORDER.entries()) {
    const directory = resolve(output, `${index + 1}-${mode}`);
    const env = {...process.env, RUBRC_MEASURE_ROOT: roots[mode], RUBRC_MEASURE_OUTPUT: directory,
      RUBRC_MEASURE_PROFILE: 'normal', RUBRC_RUNTIME_PROFILE: 'memory'};
    delete env.RUBRC_MEASURE_REPORTED_CPUS;
    await new Promise((resolve, reject) => {
      const child = spawn('timeout', ['--kill-after=30s', '25m', process.execPath, 'scripts/measure_startup_device.mjs'], {env, stdio: 'inherit'});
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`session ${index + 1} ${mode} failed: ${code ?? signal}`)));
    });
    const session = summarizeSession(await readRows(join(directory, 'normal.jsonl')), builds[mode]);
    for (const visit of ['cold', 'reload']) {
      assertVfsMemoryCoverage(builds[mode], JSON.parse(await readFile(join(directory, `normal-${visit}-memory.json`), 'utf8')));
    }
    const runtime = await readRows(join(directory, 'runtime-profile.jsonl'));
    const outcome = runtime.find(row => row.kind === 'profile-outcome');
    assert.ok(outcome && outcome.processSamples > 0, 'OS memory coverage required');
    assert.deepEqual(outcome.errors, []);
    session.peakRendererRssKiB = Math.max(...runtime.filter(row => row.kind === 'process-memory')
      .flatMap(row => row.processes.filter(process => process.kind === 'renderer').map(process => process.rssKiB)));
    assert.ok(Number.isFinite(session.peakRendererRssKiB) && session.peakRendererRssKiB > 0);
    sessions.push(session);
    await writeFile(join(output, 'sessions.json'), JSON.stringify(sessions, null, 2));
  }
  const comparison = compareSessions(sessions);
  comparison.artifacts = artifacts;
  await writeFile(join(output, 'comparison.json'), JSON.stringify(comparison, null, 2));
  console.log(JSON.stringify(comparison));
  return comparison;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'verify-archive' && args.length === 2) console.log(await verifyArchive(...args));
  else if (mode === 'run' && args.length === 5) {
    const result = await runPair(...args);
    if (result.decision !== 'improved') process.exitCode = 2;
  } else throw new Error('usage: paired_startup.mjs verify-archive <archive> <checksum> | run <baseline> <candidate> <baseline-checksums> <candidate-checksums> <output>');
}
