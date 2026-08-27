import {
  beginLspTestGeneration,
  captureLspTestGeneration,
  type LspTestGenerationState,
  type RuntimeTestState,
} from "./lsp_test_api_state.ts";
import {
  createRuntimeTestState,
  formatRuntimeTestError,
} from "./lsp_test_api.ts";
import * as lspTestApi from "./lsp_test_api.ts";
import type { AppRuntimeState } from "./app_runtime.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("test API formats nested runtime cleanup failures", () => {
  const error = new AggregateError(
    [
      new Error("document sync disposal failed"),
      new AggregateError(
        [new DOMException("runtime disposed", "AbortError")],
        "LSP resource cleanup failed",
      ),
    ],
    "runtime cleanup failed",
  );

  const formatted = formatRuntimeTestError(error);

  for (
    const message of [
      "runtime cleanup failed",
      "document sync disposal failed",
      "LSP resource cleanup failed",
      "AbortError: runtime disposed",
    ]
  ) {
    assert(formatted.includes(message), `formatted error omitted ${message}`);
  }
});

Deno.test("test API generation exposure resets stale readiness and references", () => {
  const oldModel = {};
  const state: LspTestGenerationState<object, object, object> = {
    ready: true,
    monaco: {},
    editor: {},
    model: oldModel,
    mainDidOpenComplete: true,
    requestSyntaxTree: async () => "stale",
    lspEvents: ["stale"],
    mainDiagnosticsPublicationCount: 3,
    vfsWrites: [{ path: "/old", content: "old" }],
  };
  const monaco = {};
  const editor = {};
  const model = {};

  beginLspTestGeneration(state, monaco, editor, model);

  assert(!state.ready, "new generation inherited ready state");
  assert(state.monaco === monaco, "new generation did not expose Monaco");
  assert(state.editor === editor, "new generation did not expose editor");
  assert(state.model === model, "new generation did not expose model");
  assert(!("mainDidOpenComplete" in state), "didOpen state was stale");
  assert(!("requestSyntaxTree" in state), "syntax request was stale");
  assert(!("lspEvents" in state), "LSP events were stale");
  assert(
    !("mainDiagnosticsPublicationCount" in state),
    "diagnostic count was stale",
  );
  assert(state.vfsWrites.length === 0, "VFS writes were stale");
});

Deno.test("test API cleanup cannot erase a newer generation", () => {
  const state: LspTestGenerationState<object, object, object> = {
    ready: false,
    vfsWrites: [],
  };
  const old = beginLspTestGeneration(state, {}, {}, { id: "old" });
  const currentModel = { id: "current" };
  const current = beginLspTestGeneration(state, {}, {}, currentModel);

  old.dispose();
  assert(state.model === currentModel, "stale cleanup erased current model");
  state.ready = true;
  current.dispose();
  assert(!state.ready, "cleanup retained ready state");
  assert(!("monaco" in state), "cleanup retained Monaco");
  assert(!("editor" in state), "cleanup retained editor");
  assert(!("model" in state), "cleanup retained model");
  assert(!("requestSyntaxTree" in state), "cleanup retained syntax request");
});

Deno.test("stale test API producer cannot record into a newer generation", () => {
  const state: LspTestGenerationState<object, object, object> = {
    ready: false,
    vfsWrites: [],
  };
  beginLspTestGeneration(state, {}, {}, { id: "old" });
  const old = captureLspTestGeneration(state);
  beginLspTestGeneration(state, {}, {}, { id: "current" });

  old.record((generation) => {
    generation.lspEvents = ["stale"];
  });
  assert(!state.lspEvents, "stale producer recorded into current generation");

  const current = captureLspTestGeneration(state);
  current.record((generation) => {
    generation.lspEvents = ["current"];
  });
  assert(state.lspEvents?.[0] === "current", "current producer was rejected");
});

Deno.test("test API generation exposes runtime and preserves staged startup fields", () => {
  const state: LspTestGenerationState<object, object, object> = {
    ready: false,
    vfsWrites: [],
  };
  const runtime = {
    generation: "runtime-8",
    phase: "starting" as const,
    operation: "idle" as const,
    queuedTargets: [] as readonly string[],
    selectedTarget: undefined,
    activeTarget: undefined,
    completedTargets: ["wasm32-wasip1"] as readonly string[],
    reloadRequired: false,
    utilityWorkers: 1,
    lifecycleWorkers: 1,
    farmCallbacks: 1,
  };
  const startup = {
    phase: "editor-visible" as const,
    history: ["editor-visible" as const],
    overlayVisible: true,
    crateGraphReady: false,
    diagnosticsVersion: undefined,
    inlayHintVersion: undefined,
    cargoCallsBeforeProjectActivation: 0,
  };

  beginLspTestGeneration(state, {}, {}, {}, { runtime, startup });

  assert(state.runtime?.generation === "runtime-8", "runtime token missing");
  assert(state.runtime?.operation === "idle", "runtime operation missing");
  assert(
    state.runtime?.completedTargets[0] === "wasm32-wasip1",
    "runtime completed targets missing",
  );
  assert(
    state.startup?.history[0] === "editor-visible",
    "staged startup history was deleted",
  );
  assert(state.startup?.overlayVisible, "startup overlay state missing");
  assert(
    state.startup?.cargoCallsBeforeProjectActivation === 0,
    "cargo-before-activation count missing",
  );
});

Deno.test("stale runtime callback cannot alter a newer test generation", () => {
  const state: LspTestGenerationState<object, object, object> = {
    ready: false,
    vfsWrites: [],
  };
  beginLspTestGeneration(state, {}, {}, {}, {
    runtime: {
      generation: "old",
      phase: "starting",
      operation: "idle",
      queuedTargets: [],
      completedTargets: [],
      reloadRequired: false,
      utilityWorkers: 1,
      lifecycleWorkers: 1,
      farmCallbacks: 1,
    },
    startup: {
      phase: "editor-visible",
      history: ["editor-visible"],
      overlayVisible: true,
      crateGraphReady: false,
      cargoCallsBeforeProjectActivation: 0,
    },
  });
  const old = captureLspTestGeneration(state);
  beginLspTestGeneration(state, {}, {}, {}, {
    runtime: {
      generation: "new",
      phase: "ready",
      operation: "idle",
      queuedTargets: [],
      completedTargets: ["wasm32-wasip1"],
      reloadRequired: false,
      utilityWorkers: 1,
      lifecycleWorkers: 1,
      farmCallbacks: 1,
    },
    startup: {
      phase: "ready",
      history: ["editor-visible", "ready"],
      overlayVisible: false,
      crateGraphReady: true,
      diagnosticsVersion: 2,
      inlayHintVersion: 2,
      cargoCallsBeforeProjectActivation: 0,
    },
  });

  old.record((generation) => {
    generation.runtime!.phase = "reload-required";
    generation.startup!.phase = "failed";
  });

  assert(state.runtime?.generation === "new", "stale runtime token won");
  assert(state.runtime?.phase === "ready", "stale runtime phase won");
  assert(state.startup?.phase === "ready", "stale startup phase won");
});

Deno.test("runtime test state preserves measured resource counts", () => {
  const runtimeState: AppRuntimeState = {
    phase: "starting",
    operation: "idle",
    queuedTargets: [],
    completedTargets: ["wasm32-wasip1"],
    utilityWorkers: 2,
    lifecycleWorkers: 3,
    farmCallbacks: 4,
  };

  const testState = createRuntimeTestState(
    { generation: "measured-generation" },
    runtimeState,
  );

  assert(testState.utilityWorkers === 2, "utility count was synthesized");
  assert(testState.lifecycleWorkers === 3, "lifecycle count was synthesized");
  assert(testState.farmCallbacks === 4, "callback count was synthesized");
});

Deno.test("completed test generations retain lifecycle evidence without contaminating remount", () => {
  const state: LspTestGenerationState<object, object, object> = {
    ready: false,
    vfsWrites: [],
  };
  const generation = beginLspTestGeneration(state, {}, {}, {}, {
    runtime: {
      generation: "generation-1",
      phase: "starting",
      operation: "idle",
      queuedTargets: [],
      completedTargets: ["wasm32-wasip1"],
      reloadRequired: false,
      utilityWorkers: 1,
      lifecycleWorkers: 1,
      farmCallbacks: 1,
    },
    startup: {
      phase: "editor-visible",
      history: ["editor-visible"],
      overlayVisible: true,
      crateGraphReady: false,
      cargoCallsBeforeProjectActivation: 0,
    },
  });
  const lifecycleState = state as typeof state & {
    lifecycleEvents: string[];
    runtimeHistory: RuntimeTestState[];
    completedGenerations: Array<{
      runtime?: RuntimeTestState;
      lifecycleEvents: string[];
    }>;
  };

  lifecycleState.lifecycleEvents.push("animal-destroyed");
  lifecycleState.runtimeHistory.push({
    ...state.runtime!,
    phase: "disposed",
    utilityWorkers: 0,
    lifecycleWorkers: 0,
    farmCallbacks: 0,
  });
  state.runtime = lifecycleState.runtimeHistory.at(-1);
  generation.dispose();

  assert(
    lifecycleState.completedGenerations.length === 1,
    "disposed generation lifecycle was not retained",
  );
  assert(
    lifecycleState.completedGenerations[0].runtime?.phase === "disposed",
    "completed generation lost final runtime state",
  );
  assert(
    lifecycleState.completedGenerations[0].lifecycleEvents.join(",") ===
      "animal-destroyed",
    "completed generation lost lifecycle ordering",
  );

  beginLspTestGeneration(state, {}, {}, {}, {
    runtime: {
      ...lifecycleState.completedGenerations[0].runtime!,
      generation: "generation-2",
      phase: "created",
      utilityWorkers: 0,
      lifecycleWorkers: 0,
      farmCallbacks: 0,
    },
    startup: {
      phase: "editor-visible",
      history: ["editor-visible"],
      overlayVisible: true,
      crateGraphReady: false,
      cargoCallsBeforeProjectActivation: 0,
    },
  });
  assert(
    lifecycleState.lifecycleEvents.length === 0,
    "new generation inherited lifecycle events",
  );
  assert(
    lifecycleState.runtimeHistory.length === 1 &&
      lifecycleState.runtimeHistory[0].generation === "generation-2",
    "new generation inherited runtime resource history",
  );
});

Deno.test("runtime test controls drive one generation and record lifecycle events", async () => {
  const state: LspTestGenerationState<object, object, object> = {
    ready: false,
    vfsWrites: [],
  };
  const generation = beginLspTestGeneration(state, {}, {}, {});
  let lifecycleListener: ((event: string) => void) | undefined;
  let unsubscribes = 0;
  const calls: string[] = [];
  const runtime = {
    dispose: async () => calls.push("dispose"),
    loadTarget: async (triple: string) => calls.push(`target:${triple}`),
    run: async (triple?: string) => calls.push(`run:${triple}`),
    subscribeLifecycle(listener: (event: string) => void) {
      lifecycleListener = listener;
      return () => {
        unsubscribes++;
        lifecycleListener = undefined;
      };
    },
  };
  const api = lspTestApi as unknown as {
    bindRuntimeTestControls(
      state: LspTestGenerationState<object, object, object>,
      record: typeof generation.record,
      runtime: unknown,
      forceDestroyTimeout: () => void,
    ): { dispose(): void };
  };
  let forced = 0;
  const controls = api.bindRuntimeTestControls(
    state,
    generation.record,
    runtime,
    () => forced++,
  );
  const controlled = state as typeof state & {
    disposeRuntime(): Promise<unknown>;
    loadTarget(triple: string): Promise<unknown>;
    runRuntime(triple?: string): Promise<unknown>;
    forceDestroyTimeout(): void;
    lifecycleEvents: string[];
  };

  lifecycleListener?.("animal-destroy-requested");
  await controlled.loadTarget("wasm32-wasip2");
  await controlled.runRuntime("wasm32-wasip2");
  controlled.forceDestroyTimeout();
  await controlled.disposeRuntime();

  assert(
    controlled.lifecycleEvents.join(",") === "animal-destroy-requested",
    "runtime lifecycle event was not recorded",
  );
  assert(
    calls.join(",") ===
      "target:wasm32-wasip2,run:wasm32-wasip2,dispose",
    "runtime controls bypassed their generation",
  );
  assert(forced === 1, "destroy-timeout control was not invoked once");
  controls.dispose();
  controls.dispose();
  assert(unsubscribes === 1, "runtime lifecycle subscription leaked");
});
