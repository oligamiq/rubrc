import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { startRuntimeProfile } from "./startup_runtime_profile.mjs";
import { processTree } from "./startup_runtime_profile_support.mjs";

test("process samples include only the launched browser tree, regardless of row order", () => {
  const rows = processTree(`13 12 100 chrome --type=renderer
99 1 99999 unrelated --token=secret
12 10 20 chrome --type=zygote
10 1 30 chrome
14 10 0 chrome --type=utility`, 10);
  assert.deepEqual(rows.map(row => row.pid).sort((a, b) => a - b), [10, 12, 13, 14]);
  assert.equal(rows.reduce((sum, row) => sum + row.rssKiB, 0), 150);
  assert.equal(rows.find(row => row.pid === 13).kind, "renderer");
  assert.ok(!JSON.stringify(rows).includes("token"));
});

test("invalid process metrics do not become resource measurements", () => {
  assert.deepEqual(processTree("10 1 NaN chrome\n10 1 -2 chrome\nmalformed", 10), []);
});

test("a page-only CPU capture must not pass as WASI worker profiling", async () => {
  await mkdir("/tmp/opencode", { recursive: true });
  const output = await mkdtemp("/tmp/opencode/runtime-profile-test-");
  const oldCI = process.env.GITHUB_ACTIONS;
  const oldExitCode = process.exitCode;
  process.env.GITHUB_ACTIONS = "true";
  const browser = new EventEmitter();
  browser.process = () => ({ pid: process.pid });
  browser.targets = () => [{
    url: () => "http://127.0.0.1:4187/",
    createCDPSession: async () => ({
      send: async method => method === "Profiler.stop"
        ? { profile: { nodes: [], samples: [1], startTime: 0, endTime: 10 } } : {},
      detach: async () => {},
    }),
  }];
  let observer;
  try {
    observer = await startRuntimeProfile({ browser, page: {}, origin: "http://127.0.0.1:4187", output, mode: "cpu" });
    await observer.checkpoint("cold");
    await observer.dispose();
    observer = null;
    assert.equal(process.exitCode, 1);
  } finally {
    await observer?.dispose();
    if (oldCI === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldCI;
    process.exitCode = oldExitCode;
    await rm(output, { recursive: true, force: true });
  }
});

test("WASI CPU samples survive separate cold and reload checkpoints", async () => {
  await mkdir("/tmp/opencode", { recursive: true });
  const output = await mkdtemp("/tmp/opencode/runtime-profile-test-");
  const oldCI = process.env.GITHUB_ACTIONS;
  const oldExitCode = process.exitCode;
  process.env.GITHUB_ACTIONS = "true";
  const browser = new EventEmitter();
  browser.process = () => ({ pid: process.pid });
  const target = () => ({
    url: () => "http://127.0.0.1:4187/assets/thread_spawn-example.js",
    createCDPSession: async () => ({
      send: async method => method === "Profiler.stop"
        ? { profile: { nodes: [{ id: 1 }], samples: [1], startTime: 0, endTime: 10 } } : {},
      detach: async () => {},
    }),
  });
  browser.targets = () => [target()];
  let observer;
  try {
    observer = await startRuntimeProfile({ browser, page: {}, origin: "http://127.0.0.1:4187", output, mode: "cpu" });
    await observer.checkpoint("cold");
    browser.emit("targetcreated", target());
    await observer.checkpoint("reload");
    await observer.dispose();
    observer = null;
    assert.equal(process.exitCode, oldExitCode);
  } finally {
    await observer?.dispose();
    if (oldCI === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldCI;
    process.exitCode = oldExitCode;
    await rm(output, { recursive: true, force: true });
  }
});
