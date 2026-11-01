import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STRONG_PROFILE, validateStrongEvidence, rustSetting, analyzerOptLevel, parseWvlRecords} from './optimization_settings.mjs';

test('WVL records tolerate log prefixes but reject damaged proof with a line number', () => {
  assert.deepEqual(parseWvlRecords('other output\nprefix [wvl-speed-opt] {"accepted":true}\n'), [{accepted: true}]);
  assert.throws(() => parseWvlRecords('other output\n[wvl-speed-opt] {broken'), /line 2/);
});

const rust = (name, type) => ({tool: 'rustc', status: 0, signal: null, args:
  ['--crate-name', name, '--crate-type', type, '--target', 'wasm32-wasip1-threads',
    '-C', 'opt-level=3', '-C', 'lto=fat', '-C', 'codegen-units=1']});
const optimized = stage => ({tool: 'wasm-opt', stage, status: 0, signal: null, args: [stage === 'wvl' ? '-O4' : '-O3', 'input.wasm', '-o', 'output.wasm']});
const evidence = () => ({invocations: [rust('rust_analyzer', 'bin'), rust('vfs', 'cdylib'), rust('vfs_shell', 'bin'),
  optimized('analyzer'), ...Array.from({length: 7}, () => optimized('wvl')), optimized('final-core')],
  wvl: Array.from({length: 7}, () => ({profile: 'max-compatible', hasTryTable: false, accepted: true, beforeBytes: 100, afterBytes: 120, args: optimized('wvl').args}))});

test('strong profile names actual speed settings, not size or unsafe assumptions', () => {
  assert.equal(STRONG_PROFILE.rust.lto, 'fat');
  assert.equal(STRONG_PROFILE.rust.optLevel, 3);
  assert.equal(STRONG_PROFILE.rust.codegenUnits, 1);
  assert.equal(STRONG_PROFILE.finalCore, 'O3');
  assert.equal(analyzerOptLevel(undefined), 'O3');
  assert.equal(analyzerOptLevel('O4'), 'O4');
  assert.throws(() => analyzerOptLevel('O1'));
});

test('last rustc option wins, so a later O2 override is detected', () => {
  assert.equal(rustSetting(['-C', 'opt-level=3', '-Copt-level=2'], 'opt-level'), '2');
  assert.equal(rustSetting(['-Clto'], 'lto'), 'fat');
});

test('actual successful commands are required for all rebuilt Rust binaries and optimization stages', () => {
  assert.doesNotThrow(() => validateStrongEvidence(evidence()));
  const lower = evidence(); lower.invocations[0].args.push('-Copt-level=2');
  assert.throws(() => validateStrongEvidence(lower), /opt-level/);
  const thin = evidence(); thin.invocations[1].args.push('-Clto=thin');
  assert.throws(() => validateStrongEvidence(thin), /lto/);
  const missing = evidence(); missing.invocations = missing.invocations.filter(row => row.stage !== 'wvl');
  assert.throws(() => validateStrongEvidence(missing), /WVL/);
  const fallback = evidence(); fallback.invocations.at(-1).args[0] = '-O1';
  assert.throws(() => validateStrongEvidence(fallback), /O3/);
  const failed = evidence(); failed.invocations.at(-1).status = 1;
  assert.throws(() => validateStrongEvidence(failed), /failed/);
  const dropped = evidence(); dropped.wvl[0].accepted = false;
  assert.throws(() => validateStrongEvidence(dropped), /accepted/);
  const unnecessaryDowngrade = evidence();
  unnecessaryDowngrade.invocations[4].args[0] = '-O3';
  unnecessaryDowngrade.wvl[0].args[0] = '-O3';
  assert.throws(() => validateStrongEvidence(unnecessaryDowngrade), /compatibility/);
  unnecessaryDowngrade.wvl[0].hasTryTable = true;
  assert.doesNotThrow(() => validateStrongEvidence(unnecessaryDowngrade));
});
