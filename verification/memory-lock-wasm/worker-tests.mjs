import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

// The only JS Atomics operations below are bookkeeping load/store. All waits and
// notifications execute the emitted production WebAssembly instructions.
const ADDRESS = 64;
const EXPECTED = 42;
const WAIT_NS = 5_000_000_000n;
const PHASE_MS = 8_000;
const MAX_NOTIFY_ATTEMPTS = 1_000_000;

if (!isMainThread) {
  const { bytes, memory, control, id } = workerData;
  const state = new Int32Array(control);
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  const wasm = instance.exports;
  assert.equal(wasm.wait_via_call(ADDRESS, EXPECTED + 1, 0n), 1);
  assert.equal(wasm.wait_via_call(ADDRESS, EXPECTED, 0n), 2);
  parentPort.postMessage({ type: 'ready', id, mismatch: 1, zeroTimeout: 2 });
  let wakes = 0;
  do {
    const result = wasm.wait_via_call(ADDRESS, EXPECTED, WAIT_NS);
    assert.equal(result, 0, `worker ${id}: real wait must wake, not time out`);
    wakes++;
  } while (Atomics.load(state, 0) === 0);
  parentPort.postMessage({ type: 'done', id, wakes, result: 0 });
} else {
  const [wasmPath, outputPath] = process.argv.slice(2);
  assert.ok(wasmPath && outputPath, 'usage: node worker-tests.mjs LOWERED_WASM OUTPUT_JSON');
  const bytes = new Uint8Array(fs.readFileSync(wasmPath));
  const records = [];
  const watchdog = setTimeout(() => {
    console.error('global worker test deadline exceeded');
    process.exit(1);
  }, 30_000);
  async function cohort(name, size, notifyCount) {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const control = new SharedArrayBuffer(4);
    const state = new Int32Array(control);
    new Int32Array(memory.buffer)[ADDRESS / 4] = EXPECTED;
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    assert.equal(instance.exports.memory.buffer, memory.buffer);
    const wasm = instance.exports;
    assert.equal(wasm.notify_via_call(ADDRESS, -1), 0);
    assert.equal(wasm.wait32(ADDRESS, EXPECTED + 1, 0n), 1);
    assert.equal(wasm.wait32(ADDRESS, EXPECTED, 0n), 2);
    const workers = [];
    const ready = new Set();
    const done = new Map();
    const events = [];
    let failure;
    let attempt = 0;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    async function boundedUntil(predicate, action) {
      const deadline = performance.now() + PHASE_MS;
      while (!predicate()) {
        if (failure) throw failure;
        assert.ok(performance.now() < deadline, `${name}: phase deadline`);
        if (action) {
          assert.ok(++attempt <= MAX_NOTIFY_ATTEMPTS, `${name}: notify attempt limit`);
          action();
        }
        await tick();
      }
      if (failure) throw failure;
    }
    try {
      for (let id = 0; id < size; id++) {
        const worker = new Worker(new URL(import.meta.url), { workerData: { bytes, memory, control, id } });
        workers.push(worker);
        worker.on('message', message => {
          events.push(message);
          if (message.type === 'ready') ready.add(message.id);
          if (message.type === 'done') done.set(message.id, message);
        });
        worker.on('error', error => { failure = error; });
        worker.on('exit', code => { if (code !== 0) failure = new Error(`worker exited ${code}`); });
      }
      await boundedUntil(() => ready.size === size);
      // Ready only means about to call wait. It NEVER establishes parked state.
      // The positive result from the actual Wasm notify is the parking witness.
      let witnessed = false;
      let notifyAttempts = 0;
      let partialWakeups = 0;
      await boundedUntil(() => witnessed, () => {
        assert.equal(wasm.notify_via_call(ADDRESS, 0), 0);
        assert.equal(wasm.notify_via_call(0, -1), 0, 'wrong address must not wake cohort');
        const n = wasm.notify_via_call(ADDRESS, notifyCount);
        notifyAttempts++;
        assert.ok(n >= 0 && n <= size);
        if (notifyCount === 1) assert.ok(n <= 1);
        if (n > 0 && n < size) partialWakeups += n;
        if (n === size) {
          witnessed = true;
          Atomics.store(state, 0, 1);
        }
      });
      // A worker may have re-parked before the finish flag was published. Drain
      // with real notify, also bounded, rather than assuming a scheduling order.
      let drainNotified = 0;
      await boundedUntil(() => done.size === size, () => {
        drainNotified += wasm.notify_via_call(ADDRESS, -1);
      });
      assert.equal(wasm.notify_via_call(ADDRESS, -1), 0);
      const result = { name, status: 'pass', workers: size, notifyCount,
        parkedWitness: { singleNotifyReturn: size, requestedCount: notifyCount },
        notifyAttempts, partialWakeups, drainNotified, events };
      records.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  }
  try {
    await cohort('notify-one', 1, 1);
    await cohort('notify-all-u32-max', 3, -1);
    const result = { status: 'pass', engine: process.version, wasmPath,
      waitImplementation: 'generated WebAssembly memory.atomic.wait32',
      notifyImplementation: 'generated WebAssembly memory.atomic.notify',
      limits: { workerWaitNs: String(WAIT_NS), phaseMs: PHASE_MS,
        globalMs: 30000, maxAttemptsPerCohort: MAX_NOTIFY_ATTEMPTS }, cases: records };
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  } finally {
    clearTimeout(watchdog);
  }
}
