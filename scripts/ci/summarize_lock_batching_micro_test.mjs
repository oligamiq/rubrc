import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMicroLog, summarizeMicroLogs} from './summarize_lock_batching_micro.mjs';

function log(setting, {prefix = '', transform = record => record} = {}) {
  const lines = [];
  for (const waiterAware of [false, true]) {
    const scalarAccesses = waiterAware ? 20 : 16;
    const elidedAcquires = setting === 'on' ? scalarAccesses / 2 : 0;
    lines.push(`${prefix}[wvl-memory-lock-batching] ${JSON.stringify(transform({
      enabled: setting === 'on', scalarAccesses, acquires: scalarAccesses - elidedAcquires,
      elidedAcquires, maxBatchOperators: 64,
    }))}`);
    for (let sample = 0; sample < 9; sample++) {
      lines.push(`${prefix}[WASI stdout] [memory-lock-microbenchmark] ${JSON.stringify(transform({
        sample, elapsedNs: (setting === 'on' ? 100 : 200) + sample,
        guestCalls: 64, scalarAccesses: 2097152, waiterAware,
      }))}`);
    }
  }
  return lines.join('\n');
}

test('prefixed records preserve all samples and compare each library separately', () => {
  const result = summarizeMicroLogs(log('off', {prefix: '2026-11-09T15:11:12Z '}), log('on'));
  assert.equal(result.primaryWaiterAware.waiterAware, true);
  assert.equal(result.legacyLibrary.waiterAware, false);
  for (const pair of [result.primaryWaiterAware, result.legacyLibrary]) {
    assert.deepEqual(pair.batchingOff.summary, {medianNs: 204, minNs: 200, maxNs: 208});
    assert.deepEqual(pair.batchingOn.summary, {medianNs: 104, minNs: 100, maxNs: 108});
    assert.equal(pair.speedup, 204 / 104);
    assert.equal(pair.batchingOn.samples.length, 9);
  }
  assert.match(result.interpretation, /not evidence of application performance/);
});

test('rejects missing proof, incomplete groups, duplicates and mixed libraries', () => {
  assert.throws(() => parseMicroLog('', 'off'), /two lowering/);
  assert.throws(() => parseMicroLog(log('off').split('\n').slice(1).join('\n'), 'off'), /precedes lowering/);
  assert.throws(() => parseMicroLog(log('off').split('\n').slice(0, -1).join('\n'), 'off'), /nine samples/);
  assert.throws(() => parseMicroLog(log('off', {transform: r => r.sample === 1 ? {...r, sample: 0} : r}), 'off'), /sequential/);
  assert.throws(() => parseMicroLog(log('off', {transform: r => r.sample === 1 ? {...r, waiterAware: !r.waiterAware} : r}), 'off'), /mixed library/);
  assert.throws(() => parseMicroLog(log('off', {transform: r => r.sample !== undefined ? {...r, waiterAware: true} : r}), 'off'), /one baseline/);
  assert.throws(() => parseMicroLog(`${log('off')}\n${log('off')}`, 'off'), /two lowering/);
});

test('rejects invalid timings, counts, modes and fabricated lowering evidence', () => {
  for (const elapsedNs of [0, -1, null, '123', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseMicroLog(log('off', {transform: r => r.sample === 0 ? {...r, elapsedNs} : r}), 'off'), /elapsedNs/);
  }
  for (const [key, value] of [['guestCalls', 1], ['scalarAccesses', 1], ['waiterAware', 'true']]) {
    assert.throws(() => parseMicroLog(log('off', {transform: r => r.sample === 0 ? {...r, [key]: value} : r}), 'off'));
  }
  assert.throws(() => parseMicroLog(log('off'), 'on'), /mode mismatch/);
  assert.throws(() => parseMicroLog(log('on', {transform: r => r.enabled ? {...r, acquires: r.scalarAccesses, elidedAcquires: 0} : r}), 'on'), /without actual elisions/);
  assert.throws(() => parseMicroLog(log('off'), 'typo'), /setting/);
  assert.throws(() => parseMicroLog(log('off').replace('"enabled":false', '"enabled":'), 'off'), /malformed/);
  assert.throws(() => parseMicroLog('[wvl-memory-lock-batching] null', 'off'), /invalid record/);
});

test('rejects different lowering inputs for the same library', () => {
  const changed = log('on', {transform: r => r.enabled ? {...r, scalarAccesses: r.scalarAccesses + 2, acquires: r.acquires + 2} : r});
  assert.throws(() => summarizeMicroLogs(log('off'), changed), /scalarAccesses mismatch/);
});
