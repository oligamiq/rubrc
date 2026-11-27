import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeadline } from '../stdlib_cache_browser_support.mjs';

export const STOCK_MANIFEST = '[package]\nname = "main"\nversion = "0.1.0"\nedition = "2021"\n';
const CAPTURE_KEY = '__rubrcCargoDomMeasurement';

export function cargoWorkload(token, edited = false) {
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(token)) throw new Error('token must be 1–24 ASCII identifier characters');
  const limit = edited ? 101 : 100;
  const expected = edited ? 348551 : 338350;
  const marker = `CARGO_${token}_${edited ? 'EDIT' : 'BASE'}_${expected}`;
  const source = `fn main() {\n    let mut total = 0_u64;\n    for value in 1_u64..=${limit} {\n        total = total.checked_add(value.checked_mul(value).unwrap()).unwrap();\n    }\n    assert_eq!(total, ${expected});\n    println!("${marker}");\n}\n`;
  return { source, marker, expected, limit, sha256: createHash('sha256').update(source).digest('hex') };
}

export function countMarker(text, marker) {
  // Whole rendered lines, never source substrings or echoed println! statements.
  return text.split('\n').filter(line => line.trim() === marker).length;
}

export function inspectCargoEvidence({ baseline, snapshots, marker, history, runtime, generation, prompt }) {
  const baselineCount = countMarker(baseline, marker);
  let markerAtMs = null;
  let commandDoneAtMs = null;
  let exitCode = null;
  let terminalFailure = null;
  const promptLine = prompt.trimEnd();
  const statuses = text => [...text.matchAll(/Command exited with status:\s*(-?\d+)/g)];
  const baselineStatuses = statuses(baseline);
  for (const snapshot of snapshots) {
    const observedStatuses = statuses(snapshot.text);
    // Also preserve a fresh failure when compilation never reaches main().
    for (const status of observedStatuses) {
      if (observedStatuses.filter(item => item[0] === status[0]).length > baselineStatuses.filter(item => item[0] === status[0]).length) {
        exitCode = Number(status[1]);
        if (exitCode !== 0) terminalFailure = status[0];
      }
    }
    if (countMarker(snapshot.text, marker) <= baselineCount) continue;
    markerAtMs ??= snapshot.atMs;
    const lines = snapshot.text.split('\n').map(line => line.trimEnd());
    const lastMarker = lines.lastIndexOf(marker);
    const after = lines.slice(lastMarker + 1);
    const failure = after.join('\n').match(/Command exited with status:\s*(-?\d+)/);
    if (failure) {
      exitCode = Number(failure[1]);
      if (exitCode !== 0) terminalFailure = failure[0];
    }
    // The shell emits this prompt only after handle_parallel returns. Idle alone
    // only acknowledges input dispatch and is deliberately insufficient.
    if (after.some(line => line === promptLine)) commandDoneAtMs ??= snapshot.atMs;
  }
  const runIndex = history.findIndex(state => state.operation === 'run');
  const runtimeRunThenIdle = runIndex >= 0 && history.slice(runIndex + 1).some(state => state.operation === 'idle');
  const sameGeneration = runtime?.generation === generation && history.every(state => state.generation === generation);
  const assertions = {
    freshTerminalMarker: markerAtMs !== null,
    shellPromptAfterMarker: commandDoneAtMs !== null,
    runtimeRunThenIdle,
    runtimeReadyAndIdle: runtime?.phase === 'ready' && runtime?.operation === 'idle',
    sameGeneration,
    noObservedNonzeroExit: terminalFailure === null,
    exitCodeObserved: exitCode !== null,
    exitCodeZero: exitCode === 0,
  };
  return {
    baselineCount, markerAtMs, commandDoneAtMs, exitCode, terminalFailure, assertions,
    interactionPassed: Object.entries(assertions).every(([key, value]) => ['exitCodeObserved', 'exitCodeZero'].includes(key) || value),
    // A successful prompt is NOT an explicit exit-status report.
    releaseGatePassed: false,
  };
}

// Executed inside the page; observes only xterm's rendered DOM, not private
// xterm internals, document.body text, console logs, or Monaco source.
export function installCargoDomCapture({ key, maxSnapshots, maxChars }) {
  if (window[key]) throw new Error('Cargo capture already installed');
  const terminals = [...document.querySelectorAll('.xterm')].filter(node => node.getClientRects().length);
  if (terminals.length !== 1) throw new Error('require exactly one visible terminal (Session 0)');
  const terminal = terminals[0];
  const rows = terminal.querySelector('.xterm-rows');
  if (!rows || !rows.children.length) throw new Error('xterm DOM renderer unavailable; no body-text fallback');
  const read = () => [...rows.children].map(row => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()).join('\n');
  const state = {
    rows, baseline: read(), snapshots: [], startedAt: performance.now(), chars: 0, error: null,
    sample() {
      if (!rows.isConnected || terminal.getClientRects().length === 0) state.error = 'terminal replaced or hidden';
      const text = read();
      if (text === (state.snapshots.at(-1)?.text ?? state.baseline)) return;
      if (state.snapshots.length >= maxSnapshots || state.chars + text.length > maxChars) {
        state.error = 'terminal capture limit exceeded';
        observer.disconnect();
        return;
      }
      state.chars += text.length;
      state.snapshots.push({ atMs: performance.now() - state.startedAt, text });
    },
    dispose() { observer.disconnect(); },
  };
  const observer = new MutationObserver(() => state.sample());
  observer.observe(rows, { subtree: true, childList: true, characterData: true });
  window[key] = state;
  return { baseline: state.baseline };
}

/**
 * Measure an ALREADY LOADED test-enabled Puppeteer page. No launch/navigation,
 * target change, cache reset, analyzer shutdown, or runtime.run shortcut.
 * Returns a report on both pass and failure; callers must assert status.
 */
export async function measureCargoInteractions(page, options = {}) {
  const {
    outputDirectory, token = randomBytes(6).toString('hex'), timeoutMs = 180000,
    setupTimeoutMs = 15000, pollMs = 100, target = 'wasm32-wasip1',
    metadata = {},
  } = options;
  for (const [name, value] of Object.entries({ timeoutMs, setupTimeoutMs, pollMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 600000) throw new Error(`invalid ${name}`);
  }
  if (pollMs > timeoutMs) throw new Error('pollMs must not exceed timeoutMs');
  const base = cargoWorkload(token);
  const edit = cargoWorkload(token, true);
  const result = {
    schemaVersion: 1, status: 'fail', startedAt: new Date().toISOString(), metadata,
    configuration: { token, timeoutMs, setupTimeoutMs, pollMs, target, stockManifest: STOCK_MANIFEST },
    scope: 'Same-loaded-page public Compile and Run; terminal DOM + shell prompt; NOT an exit-status or release gate',
    work: { base, edit }, runs: [], errors: [], releaseGatePassed: false,
    limitations: [
      'No supported terminal/exit-status hook exists in __rubrcLspTest; successful command exitCode remains null.',
      'DOM snapshots cover rendered viewport, not a lossless stdout/stderr stream; output channels are merged.',
      'Freshness requires a larger whole-line marker count than pre-click; viewport rollover fails closed.',
      'Stock manifest must be ensured by caller; existing hook cannot read the VFS manifest.',
      'No published baseline identity or statistical non-regression conclusion is established.',
    ],
  };
  const bounded = (operation, label) => withDeadline(operation, setupTimeoutMs, label);
  const onError = error => result.errors.push(String(error));
  page.on('pageerror', onError);
  page.on('error', onError);
  let original;
  let generation;
  let captureInstalled = false;
  let outputCreated = false;
  try {
    if (outputDirectory) {
      await mkdir(outputDirectory, { recursive: false });
      outputCreated = true;
    }
    result.environment = await bounded(page.evaluate(() => {
      const api = window.__rubrcLspTest;
      if (!api?.ready || api.startup?.phase !== 'ready' || !api.model || !api.editor) throw new Error('need ready VITE_RUBRC_LSP_TEST=1 page');
      if (api.runtime?.phase !== 'ready' || api.runtime.operation !== 'idle') throw new Error('runtime is not ready and idle');
      if (api.model.uri.toString() !== 'file:///src/main.rs') throw new Error('unexpected Monaco model URI');
      if (api.editor.getModel() !== api.model) throw new Error('main.rs is not the displayed model');
      const sessions = [...document.querySelectorAll('button')].filter(button => /^Session \d+$/.test(button.textContent.trim()));
      if (sessions.length !== 1 || sessions[0].textContent.trim() !== 'Session 0') throw new Error('require only Session 0');
      return { url: location.href, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        crossOriginIsolated, timeOrigin: performance.timeOrigin, runtime: api.runtime, original: api.model.getValue() };
    }), 'Cargo prerequisites');
    original = result.environment.original;
    delete result.environment.original;
    generation = result.environment.runtime.generation;
    if (result.environment.runtime.selectedTarget !== target) throw new Error(`select ${target} before measuring`);
    for (const [index, name, workload] of [[0, 'initial-compile', base], [1, 'unchanged-rerun', base], [2, 'edit-rebuild', edit]]) {
      const run = { index, name, marker: workload.marker, sourceSha256: workload.sha256, status: 'fail', exitCode: null };
      result.runs.push(run);
      await bounded(page.evaluate(({ source, unchanged, generation }) => {
        const api = window.__rubrcLspTest;
        if (api?.runtime?.generation !== generation) throw new Error('runtime generation changed');
        if (unchanged) {
          if (api.model.getValue() !== source) throw new Error('unchanged rerun source changed');
        } else api.model.setValue(source);
      }, { source: workload.source, unchanged: index === 1, generation }), 'set Monaco workload');
      run.modelVersion = await bounded(page.evaluate(() => window.__rubrcLspTest.model.getVersionId()), 'read model version');
      const buttonHandle = await bounded(page.evaluateHandle(() => {
        const matches = [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === 'Compile and Run');
        if (matches.length !== 1 || matches[0].disabled || !matches[0].getClientRects().length) throw new Error('public Compile and Run button unavailable');
        return matches[0];
      }), 'find public button');
      try {
        run.historyOffset = await bounded(page.evaluate(() => window.__rubrcLspTest.runtimeHistory.length), 'history baseline');
        const { baseline } = await bounded(page.evaluate(installCargoDomCapture, {
          key: CAPTURE_KEY, maxSnapshots: 1024, maxChars: 4 * 1024 * 1024,
        }), 'install terminal DOM capture');
        captureInstalled = true;
        run.baseline = baseline;
        const lastLine = baseline.split('\n').filter(line => line.trim()).at(-1);
        if (!/^\/[^\r\n]* \$$/.test(lastLine ?? '')) throw new Error('terminal must end at an empty absolute-directory shell prompt');
        run.prompt = lastLine;
        // DOM event timestamps use the capture clock; elapsedMs is the host
        // click-to-observation clock and includes the real Puppeteer click.
        run.domTimestampOrigin = 'observer installation before public button click';
        const started = performance.now();
        const deadline = started + timeoutMs;
        const remaining = () => Math.max(1, deadline - performance.now());
        await withDeadline(buttonHandle.asElement().click(), remaining(), 'public Compile and Run click');
        while (true) {
          const capture = await withDeadline(page.evaluate(({ key, historyOffset, source, timeOrigin, target }) => {
            const state = window[key];
            if (!state) throw new Error('capture lost (page navigated?)');
            state.sample();
            const api = window.__rubrcLspTest;
            return { baseline: state.baseline, snapshots: state.snapshots, captureError: state.error,
              runtime: api?.runtime, history: api?.runtimeHistory?.slice(historyOffset) ?? [],
              sourceUnchanged: api?.model?.getValue() === source,
              samePage: performance.timeOrigin === timeOrigin, sameTarget: api?.runtime?.selectedTarget === target };
          }, { key: CAPTURE_KEY, historyOffset: run.historyOffset, source: workload.source, timeOrigin: result.environment.timeOrigin, target }), remaining(), `${name} terminal observation`);
          Object.assign(run, capture);
          const evidence = inspectCargoEvidence({ ...capture, marker: workload.marker, generation, prompt: run.prompt });
          Object.assign(run, evidence);
          run.elapsedMs = performance.now() - started;
          if (capture.captureError || !capture.sourceUnchanged || !capture.samePage || !capture.sameTarget || !evidence.assertions.sameGeneration) throw new Error(capture.captureError ?? 'page/model/target/generation changed');
          if (result.errors.length) throw new Error('page error observed');
          if (evidence.terminalFailure) throw new Error(evidence.terminalFailure);
          if (evidence.interactionPassed) { run.status = 'pass-observed-interaction'; break; }
          if (performance.now() >= deadline) throw new Error(`${name} timed out waiting for fresh terminal marker + returned prompt + runtime run/idle`);
          await delay(Math.min(pollMs, remaining()));
        }
      } catch (error) {
        run.error = String(error);
        if (captureInstalled) {
          await bounded(page.evaluate(key => {
            const state = window[key];
            state?.sample();
            return state ? { baseline: state.baseline, snapshots: state.snapshots, captureError: state.error } : null;
          }, CAPTURE_KEY), 'failure terminal snapshot').then(snapshot => {
            if (snapshot) Object.assign(run, snapshot);
          }).catch(snapshotError => { run.snapshotError = String(snapshotError); });
        }
        throw error;
      } finally {
        await bounded(buttonHandle.dispose(), 'dispose button handle').catch(onError);
        if (captureInstalled) {
          await bounded(page.evaluate(key => { window[key]?.dispose(); delete window[key]; }, CAPTURE_KEY), 'dispose terminal observer').catch(onError);
          captureInstalled = false;
        }
      }
      if (outputDirectory) await writeFile(join(outputDirectory, `${index}-${name}.json`), `${JSON.stringify(run, null, 2)}\n`);
    }
    if (result.runs[0].modelVersion !== result.runs[1].modelVersion) throw new Error('unchanged rerun changed Monaco model version');
    if (result.runs[2].modelVersion <= result.runs[1].modelVersion) throw new Error('edit did not advance Monaco model version');
    result.status = 'pass-observed-interactions';
  } catch (error) {
    result.error = String(error);
  } finally {
    // Restore editor only; never run another command or reset compiled artifacts.
    if (original !== undefined) await bounded(page.evaluate(({ original, generation }) => {
      const api = window.__rubrcLspTest;
      if (api?.runtime?.generation !== generation) throw new Error('cannot restore model after generation change');
      api.model.setValue(original);
    }, { original, generation }), 'restore original Monaco model').catch(onError);
    page.off('pageerror', onError);
    page.off('error', onError);
    if (result.errors.length) result.status = 'fail';
    result.finishedAt = new Date().toISOString();
    if (outputCreated) await writeFile(join(outputDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}
