import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants, createReadStream, createWriteStream} from 'node:fs';
import {access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {delimiter, dirname, join, resolve} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const HASH = /^[0-9a-f]{64}$/;
const IDENTITY_FIELDS = ['schemaVersion', 'inputSha256', 'programSha256', 'args', 'sourceSha', 'mode', 'profile', 'binaryenCores', 'stage'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const envValue = (env, key) => env[key] == null ? null : String(env[key]);

// Deliberately narrow: options with extra file dependencies/side effects cannot
// safely be cached just by hashing the single wasm input. Queries belong outside.
function parseArgs(args) {
  assert.ok(Array.isArray(args) && args.every(arg => typeof arg === 'string' && arg.length && !arg.includes('\0')), 'invalid optimizer args');
  const canonicalArgs = [...args];
  let input, output;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output' || arg.startsWith('--output=')) {
      assert.equal(output, undefined, 'ambiguous optimizer output');
      const inline = arg.startsWith('--output=');
      output = inline ? arg.slice('--output='.length) : args[++i];
      assert.ok(output && !output.startsWith('-'), 'unsupported optimizer output');
      canonicalArgs[i] = inline ? '--output=$OUTPUT' : '$OUTPUT';
    } else if (/^-O(?:[0-4sz])?$/.test(arg) || /^--enable-[a-z][a-z0-9-]*$/.test(arg) || /^--no-inline=.+$/.test(arg)) {
      // Preserve spelling, order, and every flag value exactly.
    } else {
      assert.ok(!arg.startsWith('-') && arg !== '$INPUT' && arg !== '$OUTPUT', `unsupported optimizer argument: ${arg}`);
      assert.equal(input, undefined, 'ambiguous optimizer input');
      input = arg;
      canonicalArgs[i] = '$INPUT';
    }
  }
  assert.ok(input && output, 'optimizer requires one input and one output');
  return {input, output, canonicalArgs};
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function statOrMissing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function regularFile(path) {
  assert.ok((await lstat(path)).isFile(), `expected regular file: ${path}`);
}

async function programPath(program, env) {
  assert.ok(typeof program === 'string' && program.length && !program.includes('\0'), 'invalid optimizer program');
  if (program.includes('/')) return resolve(program);
  // Match execvp's PATH search while leaving the actual spawn command untouched.
  for (const directory of (env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const candidate = resolve(directory || '.', program);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error(`optimizer program not found in PATH: ${program}`);
}

function validateIdentity(identity) {
  assert.ok(identity && typeof identity === 'object', 'missing cache identity');
  assert.deepEqual(Object.keys(identity).sort(), [...IDENTITY_FIELDS].sort(), 'invalid cache identity fields');
  assert.equal(identity.schemaVersion, 1, 'invalid cache identity schema');
  assert.match(identity.inputSha256, HASH, 'invalid input SHA256');
  assert.match(identity.programSha256, HASH, 'invalid program SHA256');
  for (const field of ['sourceSha', 'mode', 'profile', 'binaryenCores', 'stage']) {
    assert.ok(identity[field] === null || typeof identity[field] === 'string', `invalid identity ${field}`);
  }
  // Reparse using ordinary dummy paths: the reserved tokens must occur only in
  // the input/output positions, never in a retained option value.
  assert.ok(Array.isArray(identity.args), 'invalid canonical args');
  const dummy = identity.args.map(arg => arg === '$INPUT' ? 'cache-input.wasm'
    : arg === '$OUTPUT' ? 'cache-output.wasm' : arg === '--output=$OUTPUT' ? '--output=cache-output.wasm' : arg);
  assert.deepEqual(parseArgs(dummy).canonicalArgs, identity.args, 'invalid canonical args');
}

/** Validate evidence without IO. Optional expectations bind it to its trace row.
 * This is integrity evidence, not a signature: cache storage must be trusted.
 */
export function validateCacheProof(proof, {args, stage, sourceSha, mode, profile, binaryenCores} = {}) {
  assert.ok(proof && typeof proof === 'object', 'missing cache proof');
  assert.equal(typeof proof.hit, 'boolean', 'invalid cache hit');
  validateIdentity(proof.identity);
  assert.match(proof.key, HASH, 'invalid cache key');
  assert.equal(proof.key, sha256(JSON.stringify(proof.identity)), 'cache identity/key mismatch');
  assert.match(proof.outputSha256, HASH, 'invalid output SHA256');
  const producer = proof.producer;
  assert.ok(producer && typeof producer === 'object', 'missing successful cache producer');
  assert.equal(producer.status, 0, 'cache producer failed');
  assert.equal(producer.signal, null, 'cache producer signaled');
  assert.ok(Number.isFinite(producer.elapsedMs) && producer.elapsedMs >= 0, 'invalid producer elapsedMs');
  for (const field of ['runId', 'runAttempt', 'phase', 'stage']) {
    assert.ok(producer[field] === null || typeof producer[field] === 'string', `invalid producer ${field}`);
  }
  if (args !== undefined) assert.deepEqual(parseArgs(args).canonicalArgs, proof.identity.args, 'cache proof args mismatch');
  assert.equal(producer.stage, proof.identity.stage, 'cache producer/identity stage mismatch');
  if (stage !== undefined) assert.equal(producer.stage, stage, 'cache producer stage mismatch');
  for (const [field, expected] of Object.entries({sourceSha, mode, profile, binaryenCores})) {
    if (expected !== undefined) assert.equal(proof.identity[field], expected, `cache proof ${field} mismatch`);
  }
  return proof;
}

async function readEntry(cacheDir, key) {
  const directory = join(cacheDir, key);
  assert.ok((await lstat(directory)).isDirectory(), 'invalid cache entry directory');
  await regularFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'invalid cache manifest schema');
  const proof = {hit: true, key: manifest.key, identity: manifest.identity, outputSha256: manifest.outputSha256, producer: manifest.producer};
  validateCacheProof(proof);
  assert.equal(proof.key, key, 'cache directory/key mismatch');
  await regularFile(join(directory, 'output.wasm'));
  assert.equal(await hashFile(join(directory, 'output.wasm')), proof.outputSha256, 'cache output SHA256 mismatch');
  return proof;
}

/** Rehash an on-disk entry and bind every manifest field to the supplied proof. */
export async function verifyCacheEntry(cacheDir, proof) {
  validateCacheProof(proof);
  const actual = await readEntry(cacheDir, proof.key);
  assert.deepEqual({...actual, hit: proof.hit}, proof, 'cache manifest/proof mismatch');
  return actual;
}

// Copy and hash the same stream, then publish only verified bytes. No large wasm
// Buffer is retained, and input=output is safe when replaying an entry.
async function copyHashed(source, destination, expected) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(source), new Transform({
    transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
  }), createWriteStream(destination, {flags: 'wx'}));
  const digest = hash.digest('hex');
  if (expected !== undefined) assert.equal(digest, expected, 'cache output SHA256 mismatch during copy');
  return digest;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = await mkdtemp(join(dirname(path), '.optimizer-json-'));
  try {
    await writeFile(join(temporary, 'value.json'), `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
    await rename(join(temporary, 'value.json'), path);
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

async function restoreEntry(cacheDir, proof, output) {
  const temporary = await mkdtemp(join(dirname(resolve(output)), '.optimizer-output-'));
  try {
    const staged = join(temporary, 'output.wasm');
    await copyHashed(join(cacheDir, proof.key, 'output.wasm'), staged, proof.outputSha256);
    await rename(staged, output);
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

async function readMisses(path) {
  if (!(await statOrMissing(path))) return 0;
  await regularFile(path);
  const state = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(state.schemaVersion, 1, 'invalid optimizer cache state schema');
  assert.ok(Number.isSafeInteger(state.misses) && state.misses >= 0, 'invalid optimizer cache misses');
  return state.misses;
}

/** Sequential invocations only. Each fresh CI job must use a fresh traceDir
 * state; the reusable cacheDir is independent. Cache/state/parse errors throw.
 * Native failures return their status/signal/error unchanged and are not cached.
 */
export async function runCheckpointedOptimizer({program, args, cacheDir, traceDir, env = process.env, budget}) {
  assert.ok(budget === null || (Number.isSafeInteger(budget) && budget >= 0), 'budget must be a nonnegative integer or null');
  assert.ok(typeof cacheDir === 'string' && cacheDir.length && typeof traceDir === 'string' && traceDir.length, 'cacheDir and traceDir are required');
  const startedAt = Date.now();
  const {input, output, canonicalArgs} = parseArgs(args);
  const executable = await programPath(program, env);
  const identity = {
    schemaVersion: 1,
    inputSha256: await hashFile(input),
    programSha256: await hashFile(executable),
    args: canonicalArgs,
    sourceSha: envValue(env, 'GITHUB_SHA'),
    mode: envValue(env, 'RUBRC_MEMORY_LOCK_MODE'),
    profile: envValue(env, 'RUBRC_OPTIMIZATION_PROFILE'),
    binaryenCores: envValue(env, 'BINARYEN_CORES'),
    stage: envValue(env, 'RUBRC_OPT_STAGE'),
  };
  const key = sha256(JSON.stringify(identity));
  const entry = join(cacheDir, key);
  if (await statOrMissing(entry)) {
    const proof = await readEntry(cacheDir, key);
    assert.deepEqual(proof.identity, identity, 'cache identity mismatch');
    await restoreEntry(cacheDir, proof, output);
    return {status: 0, signal: null, elapsedMs: Date.now() - startedAt, cacheProof: proof};
  }

  const statePath = join(traceDir, 'optimizer-cache-state.json');
  const misses = await readMisses(statePath);
  if (budget !== null && misses >= budget) {
    await atomicJson(join(traceDir, 'optimizer-checkpoint.json'), {
      schemaVersion: 1, phase: envValue(env, 'RUBRC_BUILD_PHASE'), misses, budget, nextKey: key,
    });
    return {status: 75, signal: null, elapsedMs: Date.now() - startedAt, checkpoint: true, checkpointKey: key};
  }
  assert.ok(misses < Number.MAX_SAFE_INTEGER, 'optimizer miss counter overflow');
  // Reserve before execution, including failed/killed native attempts.
  await atomicJson(statePath, {schemaVersion: 1, misses: misses + 1});
  const nativeStartedAt = Date.now();
  const result = spawnSync(program, args, {stdio: 'inherit', env});
  const elapsedMs = Date.now() - nativeStartedAt;
  if (result.error || result.status !== 0 || result.signal !== null) {
    return {status: result.status, signal: result.signal, ...(result.error ? {error: result.error} : {}), elapsedMs};
  }
  const producer = {
    status: 0, signal: null, elapsedMs,
    runId: envValue(env, 'GITHUB_RUN_ID'), runAttempt: envValue(env, 'GITHUB_RUN_ATTEMPT'),
    phase: envValue(env, 'RUBRC_BUILD_PHASE'), stage: envValue(env, 'RUBRC_OPT_STAGE'),
  };
  await mkdir(cacheDir, {recursive: true});
  const temporary = await mkdtemp(join(cacheDir, '.optimizer-entry-'));
  let proof;
  try {
    const outputSha256 = await copyHashed(output, join(temporary, 'output.wasm'));
    proof = {hit: false, key, identity, outputSha256, producer};
    validateCacheProof(proof);
    await writeFile(join(temporary, 'manifest.json'), `${JSON.stringify({schemaVersion: 1, key, identity, outputSha256, producer}, null, 2)}\n`, {flag: 'wx'});
    // A concurrent publisher is unsupported; never replace or ignore an entry.
    assert.equal(await statOrMissing(entry), null, 'cache entry appeared during execution');
    await rename(temporary, entry);
  } finally { await rm(temporary, {recursive: true, force: true}); }
  return {status: 0, signal: null, elapsedMs, cacheProof: proof};
}
