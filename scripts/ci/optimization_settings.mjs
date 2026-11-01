import assert from 'node:assert/strict';

export const STRONG_PROFILE = Object.freeze({
  name: 'strong-speed-v1',
  rust: Object.freeze({optLevel: 3, lto: 'fat', codegenUnits: 1}),
  analyzerWasm: 'O4', wvlStages: 'O4', finalCore: 'O4',
  wvlSizeRollback: false,
  shellDebugLog: false,
  prebuiltGuests: 'fixed-inputs-reoptimized-by-wvl-o4',
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
  for (const row of invocations) assert.ok(row.status === 0 && !row.signal, 'recorded command failed');
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
  for (const {args} of optimized) {
    assert.deepEqual(args.filter(arg => /^-O(?:[0-4sz])?$/.test(arg)), ['-O4'], 'all optimizer calls must use O4');
    assert.ok(!args.some(arg => ['--fast-math', '-ffm', '--ignore-implicit-traps', '--traps-never-happen', '--low-memory-unused', '--zero-filled-memory', '--closed-world', '--all-features', '--enable-gc'].includes(arg)), 'unsupported optimization assumption/feature');
  }
  assert.ok(optimized.some(row => row.stage === 'analyzer'), 'missing analyzer O4 stage');
  assert.ok(optimized.some(row => row.stage === 'final-core'), 'missing final core O4 stage');
  assert.ok(optimized.filter(row => row.stage === 'wvl').length >= 7, 'missing WVL module/merge optimizations');
  assert.ok(Array.isArray(wvl) && wvl.length >= 7, 'missing WVL accepted-output records');
  for (const row of wvl) {
    assert.equal(row.profile, 'speed-o4');
    assert.equal(row.accepted, true, 'WVL output was not accepted');
    assert.ok(row.beforeBytes > 0 && row.afterBytes > 0);
    assert.ok(row.args.includes('-O4'));
  }
}
