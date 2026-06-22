import {
  buildRepeatedCommands,
  computeWorkerWatchdogMs,
  parsePositiveInt,
} from "./vfs_debug_config.ts";

Deno.test("parsePositiveInt returns fallback for missing values", () => {
  if (parsePositiveInt(undefined, 2, "VFS_DEBUG_RUNS") !== 2) {
    throw new Error("expected fallback value");
  }
});

Deno.test("parsePositiveInt rejects non-positive values", () => {
  let threw = false;
  try {
    parsePositiveInt("0", 2, "VFS_DEBUG_RUNS");
  } catch (error) {
    threw = error instanceof Error && error.message.includes("VFS_DEBUG_RUNS");
  }
  if (!threw) {
    throw new Error("expected parsePositiveInt to reject zero");
  }
});

Deno.test("buildRepeatedCommands duplicates commands without aliasing", () => {
  const commands = buildRepeatedCommands(["rustc", "/src/main.rs"], 2);

  if (commands.length !== 2) {
    throw new Error(`expected 2 commands, got ${commands.length}`);
  }
  if (commands[0] === commands[1]) {
    throw new Error("expected distinct command arrays");
  }
  if (commands[1].join(" ") !== "rustc /src/main.rs") {
    throw new Error("expected command contents to be preserved");
  }
});

Deno.test("computeWorkerWatchdogMs scales with run count and per-run timeout", () => {
  const timeoutMs = computeWorkerWatchdogMs({
    commandTimeoutMs: 60000,
    runs: 2,
    perRunMultiplier: 2,
    graceMs: 60000,
  });

  if (timeoutMs !== 360000) {
    throw new Error(`expected 360000ms, got ${timeoutMs}ms`);
  }
});
