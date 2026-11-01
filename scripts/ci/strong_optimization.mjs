import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, appendFile, realpath} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {spawnSync, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join, resolve, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {STRONG_PROFILE, validateStrongEvidence, parseWvlRecords} from './optimization_settings.mjs';

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
  await writeFile(join(tools, 'wasm-opt'), `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(script)} wasm-opt ${quote(optimizer)} "$@"\n`, {mode: 0o755});
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
  const result = spawnSync(program, commandArgs, {stdio: 'inherit'});
  const observed = !commandArgs.includes('--version') && !commandArgs.includes('--help');
  if (observed) {
    appendFileSync(trace, `${JSON.stringify({tool: action, program, args: commandArgs,
      stage: process.env.RUBRC_OPT_STAGE, status: result.status, signal: result.signal,
      startedAt, elapsedMs: Date.now() - startedAt, error: result.error?.message})}\n`);
  }
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} else if (action === 'verify') {
  const invocations = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  const text = await readFile(join(logs, 'build.log'), 'utf8');
  const wvl = parseWvlRecords(text);
  validateStrongEvidence({invocations, wvl});
  const sha256 = createHash('sha256').update(await readFile(trace)).digest('hex');
  await writeFile(join(logs, 'optimization-evidence.json'), JSON.stringify({profile: STRONG_PROFILE,
    invocationTraceSha256: sha256, rustCommands: invocations.filter(row => row.tool === 'rustc').length,
    optimizerCommands: invocations.filter(row => row.tool === 'wasm-opt').length, acceptedWvlOutputs: wvl.length}, null, 2));
} else throw new Error('usage: strong_optimization.mjs install <wvl-root> | verify | record-rustc <status> <program> <args...> | wasm-opt <program> <args...>');
