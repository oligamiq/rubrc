import type * as Monaco from "monaco-editor";
import {
  type DiagnosticsPublicationTestState,
  observeDiagnosticsPublication,
  recordLspTestEvent,
} from "./lsp_diagnostics_observer";
import {
  beginLspTestGeneration,
  captureLspTestGeneration,
  type LspTestGenerationState,
  type RuntimeTestState,
} from "./lsp_test_api_state";
import type { AppRuntime, AppRuntimeState } from "./app_runtime.ts";
import type { AppRuntimeLifecycleEvent } from "./app_runtime.ts";
import type { StartupSnapshot } from "./startup_coordinator.ts";

type TestApi = DiagnosticsPublicationTestState &
  LspTestGenerationState<
    typeof Monaco,
    Monaco.editor.IStandaloneCodeEditor,
    Monaco.editor.ITextModel
  > & {
    model?: Monaco.editor.ITextModel;
  };

type SyntaxTreeRequestClient = {
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>;
};

type SyntaxTreeRequestState = Pick<
  TestApi,
  "requestSyntaxTree" | "requestCrateGraph"
>;
export type LspTestGenerationRecorder = ReturnType<
  typeof captureLspTestGeneration<unknown, unknown, unknown>
>;

export const createRuntimeTestState = (
  runtime: Pick<AppRuntime, "generation">,
  state: AppRuntimeState,
): RuntimeTestState => {
  return {
    generation: runtime.generation,
    phase: state.phase,
    operation: state.operation,
    queuedTargets: [...state.queuedTargets],
    selectedTarget: state.selectedTarget,
    activeTarget: state.activeTarget,
    completedTargets: [...state.completedTargets],
    reloadRequired: state.phase === "reload-required",
    utilityWorkers: state.utilityWorkers,
    lifecycleWorkers: state.lifecycleWorkers,
    farmCallbacks: state.farmCallbacks,
  };
};

export function captureCurrentLspTestGeneration(): LspTestGenerationRecorder {
  if (!enabled || window.__rubrcLspTest === undefined) {
    return { record: () => false };
  }
  return captureLspTestGeneration(window.__rubrcLspTest);
}

export function recordDidOpenComplete(
  uri: string,
  generation = captureCurrentLspTestGeneration(),
): void {
  if (!enabled || uri !== "file:///src/main.rs") return;
  generation.record((state) => {
    state.mainDidOpenComplete = true;
  });
}

declare global {
  interface Window {
    __rubrcLspTest?: TestApi;
  }
}

const enabled = import.meta.env?.VITE_RUBRC_LSP_TEST === "1";
let forceDestroyTimeout = false;

export function requestRuntimeDestroyTimeoutForTest(): void {
  forceDestroyTimeout = true;
}

export function consumeRuntimeDestroyTimeoutForTest(): boolean {
  const requested = forceDestroyTimeout;
  forceDestroyTimeout = false;
  return requested;
}

export function installRuntimeRemountTestControl(
  remount: () => Promise<void>,
): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.remountRuntime = remount;
}

export function recordRuntimeRemountPhase(
  phase: "disposing" | "mounting" | "mounted" | "failed",
  error?: unknown,
): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  const disposeError = phase === "disposing"
    ? undefined
    : window.__rubrcLspTest.remount?.disposeError;
  window.__rubrcLspTest.remount = {
    phase,
    ...(disposeError === undefined ? {} : { disposeError }),
    ...(error === undefined
      ? {}
      : { error: formatRuntimeTestError(error) }),
  };
}

export function formatRuntimeTestError(
  error: unknown,
  seen = new Set<unknown>(),
): string {
  if (seen.has(error)) return "[circular error]";
  if (!(error instanceof Error)) return String(error);
  seen.add(error);
  const label = `${error.name}: ${error.message}`;
  const nested = error instanceof AggregateError
    ? error.errors
    : error.cause === undefined
    ? []
    : [error.cause];
  return nested.length === 0
    ? label
    : `${label} [${nested.map((item) => formatRuntimeTestError(item, seen)).join(", ")}]`;
}

export function recordRuntimeRemountDisposalFailure(error: unknown): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.remount = {
    ...(window.__rubrcLspTest.remount ?? { phase: "disposing" }),
    disposeError: formatRuntimeTestError(error),
  };
}

export function recordRuntimeMountFailure(failure: {
  message: string;
  reloadRequired: boolean;
}): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.mountFailure = { ...failure };
}

export function bindRuntimeTestControls<
  TMonaco,
  TEditor,
  TModel,
>(
  state: LspTestGenerationState<TMonaco, TEditor, TModel>,
  record: ReturnType<
    typeof captureLspTestGeneration<TMonaco, TEditor, TModel>
  >["record"],
  runtime: Pick<
    AppRuntime,
    "dispose" | "loadTarget" | "run" | "subscribeLifecycle"
  >,
  requestDestroyTimeout: () => void = requestRuntimeDestroyTimeoutForTest,
): { dispose(): void } {
  record((generation) => {
    generation.disposeRuntime = () => runtime.dispose();
    generation.loadTarget = (triple) => runtime.loadTarget(triple);
    generation.runRuntime = (triple) => runtime.run(triple);
    generation.forceDestroyTimeout = requestDestroyTimeout;
  });
  const unsubscribe = runtime.subscribeLifecycle(
    (event: AppRuntimeLifecycleEvent) => {
      record((generation) => {
        generation.lifecycleEvents ??= [];
        generation.lifecycleEvents.push(event);
      });
    },
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      record((generation) => {
        delete generation.disposeRuntime;
        delete generation.loadTarget;
        delete generation.runRuntime;
        delete generation.forceDestroyTimeout;
      });
    },
  };
}

export function handlePublishedDiagnostics<
  TUri extends { toString(): string },
  TDiagnostics,
  TResult,
>(
  uri: TUri,
  diagnostics: TDiagnostics,
  next: (uri: TUri, diagnostics: TDiagnostics) => TResult,
): TResult {
  let state: TestApi | undefined;
  if (enabled) {
    window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
    state = window.__rubrcLspTest;
  }
  return observeDiagnosticsPublication(state, uri, diagnostics, next);
}

export function handleGenerationPublishedDiagnostics<
  TUri extends { toString(): string },
  TDiagnostics,
  TResult,
>(
  generation: LspTestGenerationRecorder,
  uri: TUri,
  diagnostics: TDiagnostics,
  next: (uri: TUri, diagnostics: TDiagnostics) => TResult,
): TResult {
  if (!enabled) return next(uri, diagnostics);
  let result!: TResult;
  const recorded = generation.record((state) => {
    result = observeDiagnosticsPublication(state, uri, diagnostics, next);
  });
  return recorded ? result : next(uri, diagnostics);
}

export function recordLspMessage(
  boundary: "inbound" | "outbound" | "outbound-complete",
  message: unknown,
): void {
  if (!enabled || typeof message !== "object" || message === null) return;
  const method = "method" in message ? message.method : undefined;
  if (
    (boundary === "inbound" && method !== "textDocument/publishDiagnostics") ||
    (boundary !== "inbound" && method !== "textDocument/didChange")
  ) {
    return;
  }
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  recordLspTestEvent(window.__rubrcLspTest, {
    boundary,
    message,
  });
}

export function recordLspProgress(value: unknown): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  recordLspTestEvent(window.__rubrcLspTest, {
    boundary: "progress",
    value,
  });
}

export function recordGenerationLspProgress(
  generation: LspTestGenerationRecorder,
  value: unknown,
): void {
  if (!enabled) return;
  generation.record((state) => {
    recordLspTestEvent(state, { boundary: "progress", value });
  });
}

export function recordLspConnectionEvent(
  boundary: "connection-error" | "connection-close" | "outbound-error",
  error?: unknown,
): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  recordLspTestEvent(window.__rubrcLspTest, {
    boundary,
    error: error instanceof Error ? error.message : String(error ?? ""),
  });
}

export function exposeEditor(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  model: Monaco.editor.ITextModel,
  runtime: Pick<
    AppRuntime,
    | "generation"
    | "state"
    | "dispose"
    | "loadTarget"
    | "run"
    | "subscribeLifecycle"
  >,
): { dispose(): void; record: LspTestGenerationRecorder["record"] } {
  if (!enabled) return { dispose() {}, record: () => false };
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  const generation = beginLspTestGeneration(
    window.__rubrcLspTest,
    monaco,
    editor,
    model,
    {
      runtime: createRuntimeTestState(runtime, runtime.state),
      startup: {
        phase: "editor-visible",
        history: ["editor-visible"],
        overlayVisible: true,
        crateGraphReady: false,
        cargoCallsBeforeProjectActivation: 0,
      },
    },
  );
  const controls = bindRuntimeTestControls(
    window.__rubrcLspTest,
    generation.record,
    runtime,
  );
  return {
    record: generation.record,
    dispose() {
      controls.dispose();
      generation.dispose();
    },
  };
}

export function recordRuntimeTestState(
  generation: LspTestGenerationRecorder,
  runtime: Pick<AppRuntime, "generation">,
  state: AppRuntimeState,
): void {
  if (!enabled) return;
  generation.record((testState) => {
    const snapshot = createRuntimeTestState(runtime, state);
    testState.runtime = snapshot;
    testState.runtimeHistory ??= [];
    testState.runtimeHistory.push(snapshot);
  });
}

export function recordCargoHostCall(): void {
  if (!enabled) return;
  const generation = captureCurrentLspTestGeneration();
  generation.record((state) => {
    if (state.startup === undefined) return;
    if (
      state.startup.phase === "project-activating" ||
      state.startup.phase === "semantic-warming" ||
      state.startup.phase === "ready"
    ) return;
    state.startup.cargoCallsBeforeProjectActivation++;
  });
}

export function recordStartupTestState(
  generation: LspTestGenerationRecorder,
  snapshot: StartupSnapshot,
): void {
  if (!enabled) return;
  generation.record((state) => {
    const previous = state.startup;
    const history = previous?.history ?? [];
    state.startup = {
      phase: snapshot.phase,
      history: history.at(-1) === snapshot.phase
        ? [...history]
        : [...history, snapshot.phase],
      overlayVisible: snapshot.phase !== "ready",
      crateGraphReady: previous?.crateGraphReady ?? false,
      diagnosticsVersion: previous?.diagnosticsVersion,
      inlayHintVersion: previous?.inlayHintVersion,
      cargoCallsBeforeProjectActivation:
        previous?.cargoCallsBeforeProjectActivation ?? 0,
    };
  });
}

export function recordAnalyzerTestReadiness(
  generation: LspTestGenerationRecorder,
  version: number,
): void {
  if (!enabled) return;
  generation.record((state) => {
    if (state.startup === undefined) return;
    state.startup.crateGraphReady = true;
    state.startup.diagnosticsVersion = version;
    state.startup.inlayHintVersion = version;
  });
}

export function installSyntaxTreeRequest(
  state: SyntaxTreeRequestState,
  client: SyntaxTreeRequestClient,
): { dispose(): void } {
  const requestSyntaxTree = (uri: string) =>
    client.sendRequest<string>("rust-analyzer/viewSyntaxTree", {
      textDocument: { uri },
    });
  const requestCrateGraph = () =>
    client.sendRequest<string>("rust-analyzer/viewCrateGraph", { full: true });
  state.requestSyntaxTree = requestSyntaxTree;
  state.requestCrateGraph = requestCrateGraph;
  return {
    dispose: () => {
      if (state.requestSyntaxTree === requestSyntaxTree) {
        delete state.requestSyntaxTree;
      }
      if (state.requestCrateGraph === requestCrateGraph) {
        delete state.requestCrateGraph;
      }
    },
  };
}

export function installGenerationSyntaxTreeRequest(
  generation: LspTestGenerationRecorder,
  client: SyntaxTreeRequestClient,
): { dispose(): void } {
  let disposable: { dispose(): void } = { dispose() {} };
  generation.record((state) => {
    disposable = installSyntaxTreeRequest(state, client);
  });
  return disposable;
}

export function exposeSyntaxTreeRequest(
  generation: LspTestGenerationRecorder,
  client: SyntaxTreeRequestClient,
): {
  dispose(): void;
} {
  if (!enabled) return { dispose() {} };
  return installGenerationSyntaxTreeRequest(generation, client);
}

export function markLspReady(
  generation = captureCurrentLspTestGeneration(),
): void {
  if (!enabled) return;
  generation.record((state) => {
    state.ready = true;
  });
}

export function recordVfsWrite(
  path: string,
  content: string,
  generation = captureCurrentLspTestGeneration(),
): void {
  if (!enabled) return;
  generation.record((state) => state.vfsWrites.push({ path, content }));
}
