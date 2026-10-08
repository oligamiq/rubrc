import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { assertCacheOutcome, monitorRenderer, withDeadline } from "./stdlib_cache_browser_support.mjs";

test("renderer crash rejects a pending operation without waiting for its timeout", async () => {
  const page = new EventEmitter();
  page.on("error", () => {});
  const monitor = monitorRenderer(page);
  const failure = new Error("Page crashed!");
  const waiting = monitor.race(new Promise(() => {})).catch(error => error);
  page.emit("error", failure);
  const result = await Promise.race([waiting, delay(30, "still waiting")]);
  monitor.dispose();
  assert.equal(result, failure);
});

test("an already observed renderer crash wins over a later successful operation", async () => {
  const page = new EventEmitter();
  page.on("error", () => {});
  const monitor = monitorRenderer(page);
  const failure = new Error("renderer exited");
  page.emit("error", failure);
  try {
    await assert.rejects(monitor.race(Promise.resolve("stale result")), /renderer exited/);
    assert.equal(monitor.error, failure);
  } finally { monitor.dispose(); }
});

test("renderer monitor cleans up its listener after success", async () => {
  const page = new EventEmitter();
  const monitor = monitorRenderer(page);
  assert.equal(page.listenerCount("error"), 1);
  assert.equal(await monitor.race(Promise.resolve(42)), 42);
  monitor.dispose();
  assert.equal(page.listenerCount("error"), 0);
});

test("diagnostics have a host-side deadline even if the page cannot execute JS", async () => {
  const result = await Promise.race([
    withDeadline(new Promise(() => {}), 5, "diagnostics").catch(error => error),
    delay(100, "still waiting"),
  ]);
  assert.match(String(result), /diagnostics timed out/);
  assert.equal(await withDeadline(Promise.resolve(7), 100, "fast"), 7);
});

test("cache download alone is not sufficient proof of restoration", () => {
  assert.throws(() => assertCacheOutcome(true, true, []), /loaded/);
  assert.throws(() => assertCacheOutcome(true, true, ["[stdlib-cache] loaded: ok"]), /merged/);
  assert.throws(() => assertCacheOutcome(false, false, ["[stdlib-cache] loaded: ok"]), /cold/);
  assertCacheOutcome(false, false, ["[stdlib-cache] rejected: missing"]);
  assertCacheOutcome(true, true, ["[stdlib-cache] loaded: ok", "[stdlib-cache] merged: moved_source_root_files=0"]);
});
