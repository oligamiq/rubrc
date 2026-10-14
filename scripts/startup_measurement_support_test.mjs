import assert from "node:assert/strict";
import test from "node:test";
import { installLspEventTiming, NETWORK_PROFILES, startupReachedTerminalState, summarizeStartup, validateWorkerTransfer } from "./startup_measurement_support.mjs";

test("network profile converts megabits to bytes per second", () => {
  assert.equal(NETWORK_PROFILES.constrained.downloadThroughput, 625000);
  assert.equal(NETWORK_PROFILES.constrained.uploadThroughput, 125000);
});

test("startup polling resolves on failed state instead of throwing inside its timer", () => {
  const oldWindow = globalThis.window;
  globalThis.window = {};
  try {
    assert.equal(startupReachedTerminalState(), false);
    window.__rubrcLspTest = { ready: false, startup: { phase: "failed", error: "archive timeout" } };
    assert.equal(startupReachedTerminalState(), true);
    window.__rubrcLspTest = { ready: false, startup: { phase: "semantic-warming" } };
    assert.equal(startupReachedTerminalState(), false);
    window.__rubrcLspTest = { ready: true, startup: { phase: "ready" } };
    assert.equal(startupReachedTerminalState(), true);
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test("diagnostic observation is synchronous and preserves the original event sink", () => {
  const oldWindow = globalThis.window;
  globalThis.window = {};
  try {
    installLspEventTiming();
    window.__rubrcLspTest = { ready: false };
    const state = window.__rubrcLspTest;
    const event = { boundary: "inbound", message: { method: "textDocument/publishDiagnostics", params: { version: 3, uri: "file:///src/main.rs" } } };
    state.lspEvents ??= [];
    assert.equal(state.lspEvents.push(event), 1);
    assert.deepEqual(state.lspEvents, [event]);
    assert.equal(window.__rubrcMeasureEvents[0].diagnosticVersion, 3);
    delete state.lspEvents;
    state.lspEvents ??= [];
    state.lspEvents.push(event);
    assert.equal(window.__rubrcMeasureEvents.length, 2);
    state.model = { getVersionId: () => 7 };
    state.mainDiagnosticsPublicationCount = 1;
    assert.equal(window.__rubrcMeasureEvents[2].modelVersionAtPublication, 7);
    assert.equal(window.__rubrcMeasureEvents[2].boundary, "diagnostics-publication");
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test("a fast Worker download cannot be reported as a throttled trial", () => {
  assert.throws(() => validateWorkerTransfer(NETWORK_PROFILES.constrained, 2097152, 50), /throttling/);
  validateWorkerTransfer(NETWORK_PROFILES.constrained, 2097152, 3500);
  assert.throws(() => validateWorkerTransfer(NETWORK_PROFILES.constrained, 0, 3500), /probe/);
});

test("concurrent Workers must share the configured aggregate bandwidth", () => {
  assert.throws(() => validateWorkerTransfer(NETWORK_PROFILES.constrained, 4194304, 3500, 4194304), /throttling/);
  validateWorkerTransfer(NETWORK_PROFILES.constrained, 4194304, 7000, 4194304);
});

test("post-sysroot interval starts only after both distinct sysroots complete", () => {
  const result = summarizeStartup({
    phases: { "project-activating": 1500, "semantic-warming": 2100, ready: 5000 },
    completedTasks: { "rust-src": 1000, "target-sysroot": 1400 },
  }, { "rust-src": 1000, "target-sysroot": 1400 });
  assert.equal(result.postSysrootMs, 3600);
  assert.equal(result.projectActivationMs, 600);
  assert.equal(result.semanticWarmMs, 2900);
  assert.equal(summarizeStartup({ phases: { ready: 5000 }, completedTasks: { "rust-src": 1000 } }).postSysrootMs, undefined);
  assert.equal(summarizeStartup({ phases: { ready: 5000 }, completedTasks: { "rust-src": 1400, "target-sysroot": 1400 } }).postSysrootMs, undefined);
});
