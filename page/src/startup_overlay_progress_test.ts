import type { CrateGraphProgress } from "./rust_analyzer_readiness.ts";
import { presentProjectProgress } from "./startup_overlay_progress.ts";

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
};

const progress = (
  labels: readonly string[],
  elapsedMs = 125_999,
): CrateGraphProgress => ({
  attempt: 24,
  elapsedMs,
  remainingMs: 174_001,
  labels,
  ready: labels.length === 4,
});

Deno.test("project progress presentation renders partial crate discovery", () => {
  const presentation = presentProjectProgress(
    progress(["rubrc_main", "core", "alloc"]),
  );
  assertEquals(
    presentation.summary,
    "125s · poll 24 · crates 3/4",
    "wrong summary",
  );
  assertEquals(
    presentation.detail,
    "rubrc_main, core, alloc · waiting: std",
    "wrong partial detail",
  );
});

Deno.test("project progress presentation renders retry and readiness", () => {
  assertEquals(
    presentProjectProgress(progress([], 5_000)).detail,
    "waiting: rubrc_main, core, alloc, std",
    "empty graph detail is ambiguous",
  );
  assertEquals(
    presentProjectProgress(
      progress(["rubrc_main", "core", "alloc", "std"], 130_000),
    ).detail,
    "rubrc_main, core, alloc, std",
    "ready graph retained a waiting label",
  );
});
