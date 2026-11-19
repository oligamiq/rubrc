import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateBatchingEvidence} from './wvl_experiment.mjs';

const LOWERING = '[wvl-memory-lock-batching]';
const SAMPLE = '[memory-lock-microbenchmark]';
const SAMPLE_COUNT = 9;

export function parseMicroLog(text, setting) {
  assert.ok(['off', 'on'].includes(setting), 'invalid batching setting');
  const groups = [];
  let current;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const markers = [LOWERING, SAMPLE].filter(marker => line.includes(marker));
    if (!markers.length) continue;
    assert.equal(markers.length, 1, `mixed evidence markers at line ${index + 1}`);
    const marker = markers[0];
    let record;
    try { record = JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim()); }
    catch (cause) { throw new Error(`malformed ${marker} JSON at line ${index + 1}`, {cause}); }
    assert.ok(record && typeof record === 'object' && !Array.isArray(record), `invalid record at line ${index + 1}`);
    if (marker === LOWERING) {
      if (current) assert.equal(current.samples.length, SAMPLE_COUNT, 'each lowering requires exactly nine samples');
      assert.ok(groups.length < 2, 'exactly two lowering records required');
      current = {lowering: validateBatchingEvidence(record, setting), samples: []};
      groups.push(current);
      continue;
    }
    assert.ok(current, 'sample precedes lowering evidence');
    assert.ok(current.samples.length < SAMPLE_COUNT, 'too many samples for lowering record');
    assert.equal(record.sample, current.samples.length, 'samples must be sequential 0..8 without duplicates');
    assert.ok(Number.isSafeInteger(record.elapsedNs) && record.elapsedNs > 0, 'elapsedNs must be a positive safe integer');
    assert.equal(record.guestCalls, 64, 'guestCalls must be 64');
    assert.equal(record.scalarAccesses, 2097152, 'microbenchmark scalarAccesses must be 2097152');
    assert.equal(typeof record.waiterAware, 'boolean', 'waiterAware must be boolean');
    if (current.samples.length) assert.equal(record.waiterAware, current.waiterAware, 'mixed library variants in sample group');
    else current.waiterAware = record.waiterAware;
    current.samples.push(record);
  }
  assert.equal(groups.length, 2, 'exactly two lowering records required');
  for (const group of groups) assert.equal(group.samples.length, SAMPLE_COUNT, 'each lowering requires exactly nine samples');
  assert.deepEqual(groups.map(group => group.waiterAware).sort(), [false, true], 'one baseline and one waiter-aware library required');
  return groups;
}

function summarizeGroup(group) {
  const times = group.samples.map(sample => sample.elapsedNs).sort((a, b) => a - b);
  return {...group, summary: {medianNs: times[4], minNs: times[0], maxNs: times[8]}};
}

export function summarizeMicroLogs(offText, onText) {
  const offGroups = parseMicroLog(offText, 'off');
  const onGroups = parseMicroLog(onText, 'on');
  const compare = waiterAware => {
    const off = summarizeGroup(offGroups.find(group => group.waiterAware === waiterAware));
    const on = summarizeGroup(onGroups.find(group => group.waiterAware === waiterAware));
    assert.equal(off.lowering.scalarAccesses, on.lowering.scalarAccesses,
      `lowering scalarAccesses mismatch for waiterAware=${waiterAware}`);
    return {waiterAware, batchingOff: off, batchingOn: on,
      speedup: off.summary.medianNs / on.summary.medianNs};
  };
  return {
    schemaVersion: 1,
    interpretation: 'Exploratory microbenchmark only: not A-B-B-A, not a statistical significance test, and not evidence of application performance. Sample scalarAccesses is nominal source work (64 calls x 8192 iterations x 4 accesses), not a verified dynamic instruction count after optimization. Speedup is batching-off median / batching-on median; values above 1 favor batching.',
    primaryWaiterAware: compare(true),
    legacyLibrary: compare(false),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, 'usage: summarize_lock_batching_micro.mjs <relocation-off.log> <relocation-on.log>');
  const [offText, onText] = await Promise.all(args.map(path => readFile(path, 'utf8')));
  console.log(JSON.stringify(summarizeMicroLogs(offText, onText), null, 2));
}
