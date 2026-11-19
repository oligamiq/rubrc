import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, appendFile, realpath} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {spawnSync, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join, resolve, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {STRONG_PROFILE, validateStrongEvidence, parseWvlRecords} from './optimization_settings.mjs';
import {runCheckpointedOptimizer, validateCacheProof, verifyCacheEntry} from './optimizer_checkpoint.mjs';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '../..');
const logs = join(root, 'ci-logs');
const trace = join(logs, 'optimization-invocations.jsonl');
const [action, ...args] = process.argv.slice(2);
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;

if (action === 'install') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'strong tool observers require hosted CI');
  const wvlRoot = resolve(args[0]);
  const cli = execFileSync('which', ['wasi_virt_layer'], {encoding: 'utf8'}).trim();
  assert.equal(await realpath(cli), await realpath(join(wvlRoot, 'target/release/wasi_virt_layer')), 'must use pinned source-built WVL CLI');
  const optimizer = execFileSync('which', ['wasm-opt'], {encoding: 'utf8'}).trim();
  const version = execFileSync(optimizer, ['--version'], {encoding: 'utf8'}).trim();
  assert.match(version, /version 131\b/);
  assert.equal(process.env.CARGO_PROFILE_RELEASE_OPT_LEVEL, '3');
  assert.equal(process.env.CARGO_PROFILE_RELEASE_LTO, 'fat');
  assert.equal(process.env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS, '1');
  assert.ok(!process.env.CARGO_ENCODED_RUSTFLAGS, 'unexpected encoded rustflags override');
  const tools = join(process.env.RUNNER_TEMP, 'rubrc-strong-tools');
  await mkdir(tools, {recursive: true});
  await mkdir(logs, {recursive: true});
  await writeFile(trace, '');
  // Let the shell invoke rustc directly so Cargo's inherited jobserver file
  // descriptors survive. Node child_process would otherwise close extra FDs.
  await writeFile(join(tools, 'rustc-wrapper'), `#!/usr/bin/env bash\n"$@"\nresult=$?\n${quote(process.execPath)} ${quote(script)} record-rustc "$result" "$@" || exit $?\nexit "$result"\n`, {mode: 0o755});
  // systemd-run deliberately has a small environment. Freeze only checkpoint
  // identity/config here; RUBRC_OPT_STAGE must still come from each caller.
  let checkpointEnv = '';
  if (process.env.RUBRC_OPTIMIZER_CACHE_DIR) {
    assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
    assert.ok(['batching-off', 'batching-on'].includes(process.env.RUBRC_MEMORY_LOCK_MODE));
    assert.ok(['seed', 'lower', 'component', 'finish'].includes(process.env.RUBRC_BUILD_PHASE));
    for (const key of ['GITHUB_ACTIONS', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
      'RUBRC_MEMORY_LOCK_MODE', 'RUBRC_OPTIMIZATION_PROFILE', 'RUBRC_BUILD_PHASE',
      'RUBRC_OPTIMIZER_CACHE_DIR', 'RUBRC_OPTIMIZER_MISS_BUDGET', 'BINARYEN_CORES']) {
      assert.ok(process.env[key], `missing checkpoint environment ${key}`);
      checkpointEnv += `export ${key}=${quote(process.env[key])}\n`;
    }
  }
  await writeFile(join(tools, 'wasm-opt'), `#!/usr/bin/env bash\n${checkpointEnv}exec ${quote(process.execPath)} ${quote(script)} wasm-opt ${quote(optimizer)} "$@"\n`, {mode: 0o755});
  await appendFile(process.env.GITHUB_PATH, `${tools}\n`);
  await appendFile(process.env.GITHUB_ENV, `RUSTC_WRAPPER=${join(tools, 'rustc-wrapper')}\n`);
  await writeFile(join(logs, 'optimization-profile.json'), JSON.stringify({profile: STRONG_PROFILE, optimizer, version, cli}, null, 2));
} else if (action === 'record-rustc') {
  const [status, program, ...commandArgs] = args;
  assert.match(status, /^\d+$/);
  const nameIndex = commandArgs.indexOf('--crate-name');
  if (nameIndex >= 0 && ['rust_analyzer', 'vfs', 'vfs_shell'].includes(commandArgs[nameIndex + 1])) {
    appendFileSync(trace, `${JSON.stringify({tool: 'rustc', program, args: commandArgs,
      stage: process.env.RUBRC_OPT_STAGE, status: Number(status), signal: null, completedAt: Date.now()})}\n`);
  }
} else if (action === 'wasm-opt') {
  const [program, ...commandArgs] = args;
  const startedAt = Date.now();
  const observed = !commandArgs.includes('--version') && !commandArgs.includes('--help');
  let result;
  if (observed && process.env.RUBRC_OPTIMIZER_CACHE_DIR) {
    const rawBudget = process.env.RUBRC_OPTIMIZER_MISS_BUDGET;
    assert.ok(rawBudget === 'unlimited' || /^\d+$/.test(rawBudget ?? ''), 'invalid checkpoint miss budget');
    result = await runCheckpointedOptimizer({program, args: commandArgs,
      cacheDir: process.env.RUBRC_OPTIMIZER_CACHE_DIR, traceDir: logs,
      budget: rawBudget === 'unlimited' ? null : Number(rawBudget)});
  } else result = spawnSync(program, commandArgs, {stdio: 'inherit'});
  if (observed) {
    appendFileSync(trace, `${JSON.stringify({tool: action, program, args: commandArgs,
      stage: process.env.RUBRC_OPT_STAGE, status: result.status, signal: result.signal,
      startedAt, elapsedMs: Date.now() - startedAt, error: result.error?.message,
      checkpoint: result.checkpoint, checkpointKey: result.checkpointKey, cacheProof: result.cacheProof})}\n`);
  }
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} else if (action === 'verify') {
  const invocations = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  const text = await readFile(join(logs, 'build.log'), 'utf8');
  const wvl = parseWvlRecords(text);
  validateStrongEvidence({invocations, wvl});
  if (process.env.RUBRC_OPTIMIZER_CACHE_DIR) {
    for (const row of invocations.filter(row => row.tool === 'wasm-opt')) {
      assert.ok(row.cacheProof, 'checkpoint build requires proof for every optimizer output');
      validateCacheProof(row.cacheProof, {args: row.args, stage: row.stage,
        sourceSha: process.env.GITHUB_SHA, mode: process.env.RUBRC_MEMORY_LOCK_MODE,
        profile: process.env.RUBRC_OPTIMIZATION_PROFILE, binaryenCores: process.env.BINARYEN_CORES});
      await verifyCacheEntry(process.env.RUBRC_OPTIMIZER_CACHE_DIR, row.cacheProof);
    }
  }
  const sha256 = createHash('sha256').update(await readFile(trace)).digest('hex');
  await writeFile(join(logs, 'optimization-evidence.json'), JSON.stringify({profile: STRONG_PROFILE,
    invocationTraceSha256: sha256, rustCommands: invocations.filter(row => row.tool === 'rustc').length,
    optimizerCommands: invocations.filter(row => row.tool === 'wasm-opt').length,
    reusedOptimizerOutputs: invocations.filter(row => row.cacheProof?.hit === true).length,
    optimizerExecutions: invocations.filter(row => row.tool === 'wasm-opt' && row.cacheProof?.hit !== true).length,
    acceptedWvlOutputs: wvl.length}, null, 2));
} else throw new Error('usage: strong_optimization.mjs install <wvl-root> | verify | record-rustc <status> <program> <args...> | wasm-opt <program> <args...>');
