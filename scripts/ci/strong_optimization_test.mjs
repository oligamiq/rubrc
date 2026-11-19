import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, copyFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('installed observer keeps checkpoint identity under systemd-like clean environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strong-observer-'));
  try {
    const scripts = join(root, 'scripts/ci');
    const native = join(root, 'native');
    const wvl = join(root, 'wvl');
    const cliDir = join(wvl, 'target/release');
    for (const path of [scripts, native, cliDir]) await mkdir(path, {recursive: true});
    for (const file of ['strong_optimization.mjs', 'optimization_settings.mjs', 'optimizer_checkpoint.mjs']) {
      await copyFile(new URL(file, import.meta.url), join(scripts, file));
    }
    await writeFile(join(cliDir, 'wasi_virt_layer'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    const counter = join(root, 'native-invocations.txt');
    await writeFile(join(native, 'wasm-opt'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('wasm-opt version 131 (version_131)');
else {
  fs.appendFileSync(${JSON.stringify(counter)}, 'run\\n');
  fs.copyFileSync(args[1], args[args.indexOf('-o') + 1]);
}
`, {mode: 0o755});
    const env = {...process.env, GITHUB_ACTIONS: 'true', GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_PATH: join(root, 'path.txt'),
      GITHUB_ENV: join(root, 'env.txt'), RUNNER_TEMP: root,
      CARGO_PROFILE_RELEASE_OPT_LEVEL: '3', CARGO_PROFILE_RELEASE_LTO: 'fat',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1', RUBRC_MEMORY_LOCK_MODE: 'batching-off',
      RUBRC_OPTIMIZATION_PROFILE: 'strong-compatible-v1', RUBRC_BUILD_PHASE: 'seed',
      RUBRC_OPTIMIZER_CACHE_DIR: join(root, 'cache'), RUBRC_OPTIMIZER_MISS_BUDGET: '1',
      BINARYEN_CORES: '1', PATH: `${native}:${cliDir}:${process.env.PATH}`};
    delete env.CARGO_ENCODED_RUSTFLAGS;
    const installed = spawnSync(process.execPath, [join(scripts, 'strong_optimization.mjs'), 'install', wvl], {env, encoding: 'utf8'});
    assert.equal(installed.status, 0, installed.stderr);
    const wrapper = join(root, 'rubrc-strong-tools/wasm-opt');
    const input = join(root, 'input.wasm'), output = join(root, 'output.wasm');
    await writeFile(input, 'test fixture, not performance evidence');
    const clean = {PATH: process.env.PATH, RUBRC_OPT_STAGE: 'final-core'};
    const invoke = () => spawnSync(wrapper, ['-O3', input, '-o', output], {env: clean, encoding: 'utf8'});
    const first = invoke(); assert.equal(first.status, 0, first.stderr);
    const second = invoke(); assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(output, 'utf8'), await readFile(input, 'utf8'));
    assert.equal(await readFile(counter, 'utf8'), 'run\n', 'hit must not run native optimizer again');
    await writeFile(input, 'different input');
    const stopped = invoke(); assert.equal(stopped.status, 75, stopped.stderr);
    const rows = (await readFile(join(root, 'ci-logs/optimization-invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 3);
    for (const row of rows.slice(0, 2)) {
      assert.equal(row.stage, 'final-core', 'stage must come from caller, not install');
      assert.equal(row.cacheProof.identity.sourceSha, env.GITHUB_SHA);
      assert.equal(row.cacheProof.identity.mode, 'batching-off');
      assert.equal(row.cacheProof.producer.phase, 'seed');
      assert.equal(row.cacheProof.producer.runId, '123');
    }
    assert.equal(rows[0].cacheProof.hit, false);
    assert.equal(rows[1].cacheProof.hit, true);
    assert.equal(rows[2].checkpoint, true);
    const marker = JSON.parse(await readFile(join(root, 'ci-logs/optimizer-checkpoint.json'), 'utf8'));
    assert.equal(rows[2].checkpointKey, marker.nextKey);
    assert.equal(marker.misses, 1);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '/strong-observer-'));
    await rm(root, {recursive: true, force: true});
  }
});
