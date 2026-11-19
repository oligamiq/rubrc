import assert from 'node:assert/strict';
import {validateCacheProof} from './optimizer_checkpoint.mjs';

export const STRONG_PROFILE = Object.freeze({
  name: 'strong-compatible-v1',
  rust: Object.freeze({optLevel: 3, lto: 'fat', codegenUnits: 1}),
  analyzerWasm: 'O3', wvlStages: 'O4-with-O3-for-try-table', finalCore: 'O3',
  exceptionCeiling: 'Binaryen-131-Flatten-does-not-support-TryTable',
  wvlSizeRollback: false,
  shellDebugLog: false,
  prebuiltGuests: 'fixed-inputs-reoptimized-at-compatible-ceiling',
  unsafeOptimizationAssumptions: false,
});

export function analyzerOptLevel(value) {
  const level = value ?? 'O3';
  assert.ok(['O3', 'O4'].includes(level), 'unsupported analyzer WASM optimization');
  return level;
}

export function rustSetting(args, key) {
  let result;
  for (let index = 0; index < args.length; index++) {
    let setting;
    if (args[index] === '-C') setting = args[++index];
    else if (args[index].startsWith('-C')) setting = args[index].slice(2);
    if (setting === key) result = key === 'lto' ? 'fat' : 'true';
    else if (setting?.startsWith(`${key}=`)) result = setting.slice(key.length + 1);
  }
  return result;
}

export function parseWvlRecords(text) {
  const marker = '[wvl-speed-opt] ';
  const rows = [];
  for (const [index, line] of text.split('\n').entries()) {
    const start = line.indexOf(marker);
    if (start < 0) continue;
    try { rows.push(JSON.parse(line.slice(start + marker.length).trim())); }
    catch (cause) { throw new Error(`invalid WVL optimization evidence at build.log line ${index + 1}`, {cause}); }
  }
  return rows;
}

export function validateStrongEvidence({invocations, wvl}) {
  assert.ok(Array.isArray(invocations) && invocations.length, 'missing optimization invocations');
  for (const row of invocations) {
    assert.ok(row.status === 0 && !row.signal && !row.checkpoint, 'recorded command failed');
    if (row.cacheProof !== undefined) {
      assert.equal(row.tool, 'wasm-opt', 'only optimizer outputs may be checkpointed');
      validateCacheProof(row.cacheProof, {args: row.args, stage: row.stage, profile: STRONG_PROFILE.name});
    }
  }
  for (const [name, type] of [['rust_analyzer', 'bin'], ['vfs', 'cdylib'], ['vfs_shell', 'bin']]) {
    const calls = invocations.filter(row => row.tool === 'rustc'
      && row.args[row.args.indexOf('--crate-name') + 1] === name
      && row.args[row.args.indexOf('--crate-type') + 1] === type
      && row.args[row.args.indexOf('--target') + 1] === 'wasm32-wasip1-threads');
    assert.ok(calls.length, `missing actual rustc command for ${name}`);
    for (const {args} of calls) {
      for (const [key, expected] of [['opt-level', '3'], ['codegen-units', '1'], ['lto', 'fat']]) {
        assert.equal(rustSetting(args, key), expected, `${name} ${key} mismatch`);
      }
    }
  }
  const optimized = invocations.filter(row => row.tool === 'wasm-opt');
  for (const {args, stage} of optimized) {
    assert.ok(['analyzer', 'wvl', 'final-core'].includes(stage), 'unclassified optimizer stage');
    const levels = args.filter(arg => /^-O(?:[0-4sz])?$/.test(arg));
    if (stage !== 'wvl') assert.deepEqual(levels, ['-O3'], `${stage} must use the EH-compatible O3 ceiling`);
    else assert.ok(levels.length === 1 && ['-O3', '-O4'].includes(levels[0]), 'WVL requires O3/O4 compatibility policy');
    assert.ok(!args.some(arg => ['--fast-math', '-ffm', '--ignore-implicit-traps', '--traps-never-happen', '--low-memory-unused', '--zero-filled-memory', '--closed-world', '--all-features', '--enable-gc'].includes(arg)), 'unsupported optimization assumption/feature');
  }
  assert.ok(optimized.some(row => row.stage === 'analyzer'), 'missing analyzer O3 stage');
  assert.ok(optimized.some(row => row.stage === 'final-core'), 'missing final core O3 stage');
  const wvlCalls = optimized.filter(row => row.stage === 'wvl');
  assert.ok(wvlCalls.length >= 7, 'missing WVL module/merge optimizations');
  assert.ok(Array.isArray(wvl) && wvl.length >= 7, 'missing WVL accepted-output records');
  assert.deepEqual(wvlCalls.map(row => row.args), wvl.map(row => row.args), 'WVL execution/accepted-output evidence mismatch');
  for (const row of wvl) {
    assert.equal(row.profile, 'max-compatible');
    assert.equal(typeof row.hasTryTable, 'boolean');
    assert.equal(row.accepted, true, 'WVL output was not accepted');
    assert.ok(row.beforeBytes > 0 && row.afterBytes > 0);
    assert.deepEqual(row.args.filter(arg => /^-O(?:[0-4sz])?$/.test(arg)), [row.hasTryTable ? '-O3' : '-O4'], 'WVL compatibility ceiling mismatch');
  }
}
