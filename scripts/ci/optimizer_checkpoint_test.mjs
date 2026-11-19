import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCheckpointedOptimizer, validateCacheProof, verifyCacheEntry} from './optimizer_checkpoint.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const toolSource = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
if (process.env.FAKE_NO_OUTPUT) process.exit(0);
let input, output;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--output') output = args[++i];
  else if (args[i].startsWith('--output=')) output = args[i].slice(9);
  else if (!args[i].startsWith('-')) input = args[i];
}
const bytes = fs.readFileSync(input);
fs.writeFileSync(output, Buffer.concat([bytes, Buffer.from([255, 0, 128])]));
`;

async function fixture(t) {
  // CI/test callers set TMPDIR to a workspace directory. No global /tmp path.
  const root = await mkdtemp(join(tmpdir(), 'optimizer-checkpoint-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const program = join(root, 'fake-wasm-opt.cjs');
  await writeFile(program, toolSource, {mode: 0o755});
  const input = join(root, 'input.wasm');
  const output = join(root, 'output.wasm');
  const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 254, 128, 0]);
  await writeFile(input, bytes);
  const env = {...process.env, FAKE_LOG: join(root, 'calls.jsonl'), GITHUB_SHA: 'a'.repeat(40),
    RUBRC_MEMORY_LOCK_MODE: 'baseline', RUBRC_OPTIMIZATION_PROFILE: 'strong-compatible-v1',
    BINARYEN_CORES: '1', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2', RUBRC_BUILD_PHASE: 'build', RUBRC_OPT_STAGE: 'wvl'};
  const options = {program, args: ['-O3', '--no-inline=foo.*', '--enable-threads', input, '-o', output],
    cacheDir: join(root, 'cache'), traceDir: join(root, 'trace'), env, budget: null};
  const expected = Buffer.concat([bytes, Buffer.from([255, 0, 128])]);
  async function calls() {
    try { return (await readFile(env.FAKE_LOG, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  return {root, input, output, bytes, expected, options, calls, run: overrides => runCheckpointedOptimizer({...options, ...overrides})};
}

async function manifest(f, proof, change) {
  const path = join(f.options.cacheDir, proof.key, 'manifest.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  change(value);
  await writeFile(path, JSON.stringify(value));
}

async function missing(path) {
  await assert.rejects(readFile(path), {code: 'ENOENT'});
}

test('miss uses exact program args and env; hit verifies and preserves binary bytes without running', async t => {
  const f = await fixture(t);
  const first = await f.run();
  assert.equal(first.status, 0);
  assert.equal(first.signal, null);
  assert.equal(first.cacheProof.hit, false);
  assert.deepEqual(await f.calls(), [f.options.args]);
  assert.deepEqual(await readFile(f.output), f.expected);
  const proof = first.cacheProof;
  assert.deepEqual(proof.identity, {
    schemaVersion: 1, inputSha256: digest(f.bytes), programSha256: digest(toolSource),
    args: ['-O3', '--no-inline=foo.*', '--enable-threads', '$INPUT', '-o', '$OUTPUT'],
    sourceSha: 'a'.repeat(40), mode: 'baseline', profile: 'strong-compatible-v1', binaryenCores: '1', stage: 'wvl',
  });
  assert.equal(proof.key, digest(JSON.stringify(proof.identity)));
  assert.equal(proof.outputSha256, digest(f.expected));
  assert.deepEqual(proof.producer, {status: 0, signal: null, elapsedMs: first.elapsedMs,
    runId: '100', runAttempt: '2', phase: 'build', stage: 'wvl'});
  await writeFile(f.output, 'replace me');
  const second = await f.run({budget: 0, env: {...f.options.env, GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1'}});
  assert.equal(second.cacheProof.hit, true);
  assert.deepEqual(second.cacheProof, {...proof, hit: true});
  assert.deepEqual(await readFile(f.output), f.expected);
  assert.equal((await f.calls()).length, 1);
  assert.deepEqual(await verifyCacheEntry(f.options.cacheDir, second.cacheProof), second.cacheProof);
  assert.deepEqual(await readdir(f.options.cacheDir), [proof.key]);
});

test('canonical input/output and identical program path changes reuse content-addressed entry', async t => {
  const f = await fixture(t);
  const first = await f.run();
  const moved = join(f.root, 'other directory');
  await mkdir(moved);
  const input = join(moved, 'different input.wasm');
  const output = join(moved, 'different output.wasm');
  const program = join(moved, 'another-tool.cjs');
  await copyFile(f.input, input);
  await copyFile(f.options.program, program);
  await chmod(program, 0o755);
  const args = [...f.options.args];
  args[3] = input;
  args[5] = output;
  const second = await f.run({program, args, budget: 0});
  assert.equal(second.cacheProof.key, first.cacheProof.key);
  assert.equal(second.cacheProof.hit, true);
  assert.deepEqual(await readFile(output), f.expected);
  assert.equal((await f.calls()).length, 1);
});

for (const changed of ['input', 'flags', 'flag order', 'program', 'source', 'mode', 'profile', 'cores', 'stage']) {
  test(`${changed} changes invalidate the cache key`, async t => {
    const f = await fixture(t);
    const first = await f.run();
    let overrides = {};
    if (changed === 'input') await writeFile(f.input, 'different input');
    if (changed === 'flags') overrides.args = f.options.args.map(arg => arg === '-O3' ? '-O4' : arg);
    if (changed === 'flag order') overrides.args = [f.options.args[1], f.options.args[0], ...f.options.args.slice(2)];
    if (changed === 'program') await writeFile(f.options.program, `${toolSource}\n// changed executable\n`);
    const field = {source: 'GITHUB_SHA', mode: 'RUBRC_MEMORY_LOCK_MODE', profile: 'RUBRC_OPTIMIZATION_PROFILE', cores: 'BINARYEN_CORES', stage: 'RUBRC_OPT_STAGE'}[changed];
    if (field) overrides.env = {...f.options.env, [field]: 'changed'};
    const second = await f.run(overrides);
    assert.equal(second.cacheProof.hit, false);
    assert.notEqual(second.cacheProof.key, first.cacheProof.key);
    assert.equal((await f.calls()).length, 2);
  });
}

for (const outputFlag of ['--output', '--output=']) {
  test(`${outputFlag} preserves exact command spelling`, async t => {
    const f = await fixture(t);
    const args = ['-O3', f.input, ...(outputFlag.endsWith('=') ? [`${outputFlag}${f.output}`] : [outputFlag, f.output])];
    const first = await f.run({args});
    assert.deepEqual(await f.calls(), [args]);
    assert.equal((await f.run({args})).cacheProof.hit, true);
    validateCacheProof(first.cacheProof, {args});
  });
}

test('input=output is safe both on native miss and restored hit', async t => {
  const f = await fixture(t);
  const args = ['-O3', f.input, '-o', f.input];
  const first = await f.run({args});
  assert.deepEqual(await readFile(f.input), f.expected);
  await writeFile(f.input, f.bytes);
  const second = await f.run({args, budget: 0});
  assert.equal(second.cacheProof.key, first.cacheProof.key);
  assert.equal(second.cacheProof.hit, true);
  assert.deepEqual(await readFile(f.input), f.expected);
  assert.equal((await f.calls()).length, 1);
});

test('budget zero stops before native execution and does not create or modify output', async t => {
  const f = await fixture(t);
  const result = await f.run({budget: 0});
  assert.equal(result.status, 75);
  assert.equal(result.signal, null);
  assert.equal(result.checkpoint, true);
  assert.equal(result.cacheProof, undefined);
  assert.deepEqual(await f.calls(), []);
  await missing(f.output);
  const marker = JSON.parse(await readFile(join(f.options.traceDir, 'optimizer-checkpoint.json'), 'utf8'));
  assert.deepEqual({...marker, nextKey: 'key'}, {schemaVersion: 1, phase: 'build', misses: 0, budget: 0, nextKey: 'key'});
  assert.match(marker.nextKey, /^[0-9a-f]{64}$/);
  assert.equal(result.checkpointKey, marker.nextKey);
  await writeFile(f.output, 'untouched');
  await f.run({budget: 0});
  assert.equal(await readFile(f.output, 'utf8'), 'untouched');
  await missing(join(f.options.traceDir, 'optimizer-cache-state.json'));
});

test('budget persists across calls/phases, hits are free, fresh traceDir resumes missing work', async t => {
  const f = await fixture(t);
  await f.run({budget: 1});
  assert.equal((await f.run({budget: 1})).cacheProof.hit, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.options.traceDir, 'optimizer-cache-state.json'), 'utf8')), {schemaVersion: 1, misses: 1});
  const args = f.options.args.map(arg => arg === '-O3' ? '-O4' : arg);
  const stopped = await f.run({args, budget: 1, env: {...f.options.env, RUBRC_BUILD_PHASE: 'other'}});
  assert.equal(stopped.status, 75);
  assert.equal((await f.calls()).length, 1);
  const marker = JSON.parse(await readFile(join(f.options.traceDir, 'optimizer-checkpoint.json'), 'utf8'));
  assert.equal(marker.phase, 'other');
  const resumed = await f.run({args, budget: 1, traceDir: join(f.root, 'next-job-trace')});
  assert.equal(resumed.cacheProof.key, marker.nextKey);
  assert.equal(resumed.cacheProof.hit, false);
});

for (const failure of ['exit', 'signal', 'spawn']) {
  test(`native ${failure} failures are returned and never cached`, async t => {
    const f = await fixture(t);
    const env = {...f.options.env};
    if (failure === 'exit') env.FAKE_EXIT = '13';
    if (failure === 'signal') env.FAKE_SIGNAL = 'SIGTERM';
    if (failure === 'spawn') await chmod(f.options.program, 0o644);
    const result = await f.run({env, budget: 1});
    assert.equal(result.cacheProof, undefined);
    if (failure === 'exit') assert.equal(result.status, 13);
    if (failure === 'signal') { assert.equal(result.status, null); assert.equal(result.signal, 'SIGTERM'); }
    if (failure === 'spawn') { assert.equal(result.status, null); assert.equal(result.error.code, 'EACCES'); }
    await assert.rejects(readdir(f.options.cacheDir), {code: 'ENOENT'});
    assert.equal((await f.run({budget: 1})).status, 75);
  });
}

test('successful native exit without output rejects and leaves no cache entry', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({env: {...f.options.env, FAKE_NO_OUTPUT: '1'}}), {code: 'ENOENT'});
  assert.deepEqual(await readdir(f.options.cacheDir), []);
});

for (const corruption of ['missing manifest', 'malformed manifest', 'schema', 'identity', 'key', 'producer status', 'producer signal', 'missing output', 'output hash', 'output symlink', 'manifest symlink']) {
  test(`rejects ${corruption} without running or overwriting destination`, async t => {
    const f = await fixture(t);
    const {cacheProof: proof} = await f.run();
    const directory = join(f.options.cacheDir, proof.key);
    const manifestPath = join(directory, 'manifest.json');
    const outputPath = join(directory, 'output.wasm');
    if (corruption === 'missing manifest') await rm(manifestPath);
    if (corruption === 'malformed manifest') await writeFile(manifestPath, '{');
    if (corruption === 'schema') await manifest(f, proof, value => { value.schemaVersion = 2; });
    if (corruption === 'identity') await manifest(f, proof, value => { value.identity.mode = 'tampered'; });
    if (corruption === 'key') await manifest(f, proof, value => { value.key = '0'.repeat(64); });
    if (corruption === 'producer status') await manifest(f, proof, value => { value.producer.status = 1; });
    if (corruption === 'producer signal') await manifest(f, proof, value => { value.producer.signal = 'SIGKILL'; });
    if (corruption === 'missing output') await rm(outputPath);
    if (corruption === 'output hash') await writeFile(outputPath, 'corrupt');
    if (corruption === 'output symlink') { await rm(outputPath); await symlink(f.output, outputPath); }
    if (corruption === 'manifest symlink') {
      const external = join(f.root, 'manifest-copy.json');
      await copyFile(manifestPath, external); await rm(manifestPath); await symlink(external, manifestPath);
    }
    await writeFile(f.output, 'preserve destination');
    await assert.rejects(f.run());
    assert.equal(await readFile(f.output, 'utf8'), 'preserve destination');
    assert.equal((await f.calls()).length, 1);
    await assert.rejects(verifyCacheEntry(f.options.cacheDir, proof));
  });
}

test('proof validator binds trace args, producer stage, expected identity, and stored manifest', async t => {
  const f = await fixture(t);
  const {cacheProof: proof} = await f.run();
  assert.equal(validateCacheProof(proof, {args: f.options.args, stage: 'wvl', sourceSha: f.options.env.GITHUB_SHA,
    mode: 'baseline', profile: 'strong-compatible-v1', binaryenCores: '1'}), proof);
  for (const expectations of [{args: ['-O4', f.input, '-o', f.output]}, {stage: 'analyzer'}, {sourceSha: 'wrong'},
    {mode: 'wrong'}, {profile: 'wrong'}, {binaryenCores: '2'}]) {
    assert.throws(() => validateCacheProof(proof, expectations));
  }
  for (const mutate of [value => { value.hit = 1; }, value => { value.outputSha256 = 'bad'; },
    value => { value.identity.extra = true; }, value => { value.producer.elapsedMs = -1; },
    value => { delete value.producer.runId; }, value => { value.producer.stage = 'other'; },
    value => { value.identity.args = ['-O3', '$INPUT', '$INPUT', '-o', '$OUTPUT']; value.key = digest(JSON.stringify(value.identity)); }]) {
    const invalid = structuredClone(proof); mutate(invalid);
    assert.throws(() => validateCacheProof(invalid));
  }
  const changedProducer = structuredClone(proof);
  changedProducer.producer.runId = 'different';
  await assert.rejects(verifyCacheEntry(f.options.cacheDir, changedProducer), /manifest\/proof mismatch/);
});

test('rejects ambiguous/unsupported commands and invalid budgets before execution or filesystem mutation', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--version'], ['--help'], ['-O3', f.input], ['-O3', '-o', f.output],
    ['-O3', f.input, f.input, '-o', f.output], ['-O3', f.input, '-o', f.output, '--output', f.output],
    ['-O3', f.input, '-o'], ['-O3', f.input, '-o', '-'], ['-O3', '-', '-o', f.output],
    ['-O3', '--', f.input, '-o', f.output], ['-O3', '--input-source-map=x', f.input, '-o', f.output],
    ['-O3', '--unknown', f.input, '-o', f.output], ['-O3', '--no-inline', 'foo', f.input, '-o', f.output]]) {
    await assert.rejects(f.run({args}));
  }
  for (const budget of [-1, 0.5, undefined, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.run({budget}), /budget/);
  }
  assert.deepEqual(await f.calls(), []);
  await assert.rejects(readdir(f.options.traceDir), {code: 'ENOENT'});
  await assert.rejects(readdir(f.options.cacheDir), {code: 'ENOENT'});
});

test('corrupt persistent state is rejected rather than resetting the budget', async t => {
  const f = await fixture(t);
  await mkdir(f.options.traceDir);
  const path = join(f.options.traceDir, 'optimizer-cache-state.json');
  for (const contents of ['{', '{"schemaVersion":2,"misses":0}', '{"schemaVersion":1,"misses":-1}']) {
    await writeFile(path, contents);
    await assert.rejects(f.run({budget: 1}));
  }
  assert.deepEqual(await f.calls(), []);
});

test('bare program resolves through supplied PATH while spawn receives the unchanged name', async t => {
  const f = await fixture(t);
  const result = await f.run({program: 'fake-wasm-opt.cjs', env: {...f.options.env, PATH: f.root}});
  assert.equal(result.status, 0);
  assert.equal(result.cacheProof.identity.programSha256, digest(toolSource));
  assert.deepEqual(await f.calls(), [f.options.args]);
});
