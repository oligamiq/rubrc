import { recordStartupMeasurement } from "./startup_measurements.ts";
import { beginLspTestGeneration, type LspTestGenerationState } from "./lsp_test_api_state.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("startup measurements retain first phase entry across progress updates", () => {
  const first = recordStartupMeasurement(undefined, { phase: "sysroots-loading", tasks: [] }, 10);
  const next = recordStartupMeasurement(first, { phase: "sysroots-loading", tasks: [] }, 20);
  const ready = recordStartupMeasurement(next, { phase: "project-activating", tasks: [] }, 35);
  equal(ready.phases, { "sysroots-loading": 10, "project-activating": 35 });
  equal(first.phases, { "sysroots-loading": 10 });
});

Deno.test("a new runtime generation cannot reuse old startup timestamps", () => {
  const state: LspTestGenerationState<unknown, unknown, unknown> = {
    ready: true, vfsWrites: [], startupMeasurements: { phases: { ready: 1 }, completedTasks: {} },
  };
  beginLspTestGeneration(state, {}, {}, {});
  equal(state.startupMeasurements, undefined);
});

Deno.test("rust source and target sysroot completion are recorded separately", () => {
  const first = recordStartupMeasurement(undefined, {
    phase: "sysroots-loading",
    tasks: [{ id: "rust-src", state: "complete" }, { id: "target-sysroot", state: "running" }],
  }, 50);
  const next = recordStartupMeasurement(first, {
    phase: "sysroots-loading",
    tasks: [{ id: "rust-src", state: "complete" }, { id: "target-sysroot", state: "complete" }],
  }, 80);
  equal(next.completedTasks, { "rust-src": 50, "target-sysroot": 80 });
  equal(first.completedTasks, { "rust-src": 50 });
});
