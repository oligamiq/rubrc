import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cargoWorkload, countMarker, inspectCargoEvidence, installCargoDomCapture, measureCargoInteractions } from './measure_cargo_interactions.mjs';

const marker = cargoWorkload('unit').marker;
const runtime = { generation: 'g1', phase: 'ready', operation: 'idle', selectedTarget: 'wasm32-wasip1' };
const history = [{ ...runtime, operation: 'run' }, runtime];
const evidence = overrides => inspectCargoEvidence({ baseline: '/ $', snapshots: [{ atMs: 42, text: `${marker}\n/ $` }], marker, history, runtime, generation: 'g1', prompt: '/ $', ...overrides });

test('std-only deterministic checked workloads use different values and unique markers', () => {
  const base = cargoWorkload('repro');
  const edited = cargoWorkload('repro', true);
  for (const work of [base, edited]) {
    assert.equal(Array.from({ length: work.limit }, (_, i) => (i + 1) ** 2).reduce((a, b) => a + b), work.expected);
    assert.match(work.source, /checked_add.*checked_mul/);
    assert.match(work.source, /assert_eq!/);
    assert.equal(work.sha256.length, 64);
  }
  assert.notEqual(base.sha256, edited.sha256);
  assert.notEqual(base.marker, edited.marker);
  assert.deepEqual(base, cargoWorkload('repro'));
  assert.throws(() => cargoWorkload('bad"marker'));
});

test('whole-line output witness excludes source, command echoes, and stale output', () => {
  assert.equal(countMarker(`println!("${marker}");`, marker), 0);
  assert.equal(countMarker(`echo ${marker}`, marker), 0);
  assert.equal(evidence({ baseline: `${marker}\n/ $` }).interactionPassed, false);
  const result = evidence({ baseline: `${marker}\n/ $`, snapshots: [{ atMs: 4, text: `${marker}\n/ $ cargo run\n${marker}\n/ $` }] });
  assert.equal(result.interactionPassed, true);
});

test('whitespace-prefixed marker cannot reuse an earlier prompt', () => {
  const bad = evidence({ snapshots: [{ atMs: 1, text: `/ $\n  ${marker}` }] });
  assert.equal(bad.assertions.freshTerminalMarker, true);
  assert.equal(bad.assertions.shellPromptAfterMarker, false);
  assert.equal(bad.interactionPassed, false);
  assert.equal(evidence({ snapshots: [{ atMs: 1, text: `/ $\n  ${marker}\n/ $` }] }).interactionPassed, true);
});

test('idle, marker without prompt, prompt before marker, or wrong generation cannot pass', () => {
  assert.equal(evidence({ snapshots: [] }).interactionPassed, false);
  assert.equal(evidence({ snapshots: [{ atMs: 1, text: `/ $\n${marker}` }] }).interactionPassed, false);
  assert.equal(evidence({ history: [runtime] }).interactionPassed, false);
  assert.equal(evidence({ runtime: { ...runtime, generation: 'other' } }).interactionPassed, false);
});

test('marker plus returned prompt reports completion but never fabricates exit zero', () => {
  const result = evidence();
  assert.equal(result.interactionPassed, true);
  assert.equal(result.commandDoneAtMs, 42);
  assert.equal(result.exitCode, null);
  assert.equal(result.assertions.exitCodeObserved, false);
  assert.equal(result.releaseGatePassed, false);
});

test('explicit nonzero shell status fails even after a valid stdout marker', () => {
  const result = evidence({ snapshots: [{ atMs: 9, text: `${marker}\nCommand exited with status: 7\n/ $` }] });
  assert.equal(result.exitCode, 7);
  assert.equal(result.interactionPassed, false);
});

test('failed compile with no marker still preserves explicit failure status', () => {
  const result = evidence({ snapshots: [{ atMs: 5, text: 'error: compile failed\nCommand exited with status: 101\n/ $' }] });
  assert.equal(result.exitCode, 101);
  assert.equal(result.assertions.freshTerminalMarker, false);
  assert.equal(result.interactionPassed, false);
});

test('stale failure status is not attributed to the next run', () => {
  const failure = 'Command exited with status: 101';
  const result = evidence({ baseline: `${failure}\n/ $`, snapshots: [{ atMs: 5, text: `${failure}\n/ $ cargo run\n${marker}\n/ $` }] });
  assert.equal(result.exitCode, null);
  assert.equal(result.interactionPassed, true);
});

// Minimal DOM/Monaco/Puppeteer contract fake, NOT browser performance evidence.
function fakePage({ emitOutput = true, domRenderer = true } = {}) {
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'location', 'crossOriginIsolated', 'MutationObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const rows = { isConnected: true, children: [] };
  const setTerminal = text => { rows.children = text.split('\n').map(textContent => ({ textContent })); };
  setTerminal('/ $');
  let source = 'fn main() {}';
  let version = 1;
  let clicks = 0;
  const model = { uri: { toString: () => 'file:///src/main.rs' }, getValue: () => source, setValue: text => { source = text; version++; }, getVersionId: () => version };
  const api = { ready: true, startup: { phase: 'ready' }, runtime: { ...runtime }, runtimeHistory: [], model, editor: { getModel: () => model } };
  const terminal = { getClientRects: () => [1], querySelector: selector => { assert.equal(selector, '.xterm-rows'); return domRenderer ? rows : null; } };
  const button = { textContent: 'Compile and Run', disabled: false, getClientRects: () => [1], async click() {
    clicks++;
    api.runtimeHistory.push({ ...runtime, operation: 'run' }, { ...runtime });
    if (emitOutput) {
      const outputMarker = source.match(/println!\("([^"]+)"\)/)[1];
      setTerminal(`${rows.children.map(row => row.textContent).join('\n')} cargo run --target wasm32-wasip1\n${outputMarker}\n/ $`);
    }
  } };
  const globals = {
    window: { __rubrcLspTest: api },
    document: { querySelector: selector => { assert.equal(selector, '.xterm .xterm-rows'); return domRenderer ? rows : null; }, querySelectorAll: selector => {
      if (selector === '.xterm') return [terminal];
      if (selector === 'button') return [button, { textContent: 'Session 0' }];
      throw new Error(`unexpected selector ${selector}`);
    }, get body() { throw new Error('document.body must never be read'); } },
    navigator: { userAgent: 'unit-fake', hardwareConcurrency: 4 }, location: { href: 'https://unit.invalid/' }, crossOriginIsolated: true,
    MutationObserver: class { observe() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  return {
    page: {
      on() {}, off() {},
      async focus(selector) { assert.equal(selector, '.xterm-helper-textarea'); },
      keyboard: { async press(key) { assert.equal(key, 'Enter'); } },
      async waitForFunction(fn) { if(!domRenderer) throw Error('DOM renderer unavailable'); assert.equal(fn(), true); },
      async evaluate(fn, arg) { return fn(arg); },
      async evaluateHandle(fn) { const element = fn(); return { asElement: () => element, async dispose() {} }; },
    }, api, rows, setTerminal, get clicks() { return clicks; },
    cleanup() {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('orchestrates three public clicks on one page, unchanged rerun, edit, restore', async () => {
  const fake = fakePage();
  try {
    const result = await measureCargoInteractions(fake.page, { token: 'unit', timeoutMs: 100, pollMs: 1 });
    assert.equal(result.status, 'pass-observed-interactions', result.error);
    assert.equal(fake.clicks, 3);
    assert.deepEqual(result.runs.map(run => run.name), ['initial-compile', 'unchanged-rerun', 'edit-rebuild']);
    assert.equal(result.runs[0].modelVersion, result.runs[1].modelVersion);
    assert.ok(result.runs[2].modelVersion > result.runs[1].modelVersion);
    assert.ok(result.runs.every(run => run.exitCode === null && run.assertions.freshTerminalMarker));
    assert.equal(result.releaseGatePassed, false);
    assert.equal(fake.api.model.getValue(), 'fn main() {}');
    assert.equal(window.__rubrcCargoDomMeasurement, undefined);
  } finally { fake.cleanup(); }
});

test('source marker plus idle with no terminal stdout times out and preserves failed evidence', async () => {
  const fake = fakePage({ emitOutput: false });
  try {
    const result = await measureCargoInteractions(fake.page, { token: 'unit', timeoutMs: 15, pollMs: 1 });
    assert.equal(result.status, 'fail');
    assert.match(result.error, /timed out/);
    assert.equal(result.runs[0].assertions.freshTerminalMarker, false);
    assert.equal(fake.clicks, 1);
    assert.equal(fake.api.model.getValue(), 'fn main() {}');
  } finally { fake.cleanup(); }
});

test('unsupported renderer fails closed without a body-text fallback or click', async () => {
  const fake = fakePage({ domRenderer: false });
  try {
    const result = await measureCargoInteractions(fake.page, { token: 'unit' });
    assert.equal(result.status, 'fail');
    assert.match(result.error, /DOM renderer unavailable/);
    assert.equal(fake.clicks, 0);
  } finally { fake.cleanup(); }
});

test('capture is terminal-only, bounded, and detects terminal replacement', () => {
  const fake = fakePage();
  try {
    installCargoDomCapture({ key: 'capture', maxSnapshots: 1, maxChars: 100 });
    fake.setTerminal(marker);
    window.capture.sample();
    assert.equal(window.capture.snapshots.length, 1);
    fake.setTerminal(`${marker}\n/ $`);
    window.capture.sample();
    assert.match(window.capture.error, /limit/);
    fake.rows.isConnected = false;
    window.capture.sample();
    assert.match(window.capture.error, /limit|replaced/);
    window.capture.dispose();
  } finally { fake.cleanup(); }
});

test('helper cannot launch/navigate or shortcut through runtime test run control', async () => {
  const source = await readFile(new URL('./measure_cargo_interactions.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /page\.(goto|reload)|puppeteer\.launch|\.runRuntime\s*\(/);
  assert.doesNotMatch(source, /document\.body\.(innerText|textContent)/);
});
