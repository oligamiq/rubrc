import assert from "node:assert/strict";
import test from "node:test";
import { NETWORK_PROFILES, summarizeStartup, validateWorkerTransfer } from "./startup_measurement_support.mjs";

test("network profile converts megabits to bytes per second", () => {
  assert.equal(NETWORK_PROFILES.constrained.downloadThroughput, 625000);
  assert.equal(NETWORK_PROFILES.constrained.uploadThroughput, 125000);
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
