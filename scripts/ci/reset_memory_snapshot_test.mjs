import test from 'node:test';
import assert from 'node:assert/strict';
import {resetMemorySnapshot, RESET_DIAGNOSTIC_CORE} from './reset_memory_snapshot.mjs';
test('reads only verified-core diagnostic slots without locking', () => {
  const memory = new WebAssembly.Memory({initial: 64, maximum: 64, shared: true});
  const w = new Uint32Array(memory.buffer);
  Atomics.store(w, 1121832 / 4, 4096);
  Atomics.store(w, 1121964 / 4, 0x40000003);
  Atomics.store(w, 1121288 / 4, 45);
  Atomics.store(w, (4096 + 2927520) / 4, 2);
  const result = resetMemorySnapshot(memory, RESET_DIAGNOSTIC_CORE);
  assert.equal(result.guard, 2);
  assert.equal(result.lockBefore, 0x40000003);
  assert.equal(result.logicalPages, 45);
  assert.equal(result.relocationObserved, false);
  assert.throws(() => resetMemorySnapshot(memory, 'wrong'), /unsupported/);
  Atomics.store(w, 1121832 / 4, 0xfffff000);
  assert.equal(resetMemorySnapshot(memory, RESET_DIAGNOSTIC_CORE).guard, null);
});
