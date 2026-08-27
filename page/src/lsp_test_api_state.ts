import type {
  AppRuntimeLifecycleEvent,
  AppRuntimeOperation,
  AppRuntimePhase,
} from "./app_runtime.ts";
import type { StartupPhase } from "./startup_coordinator.ts";

export type RuntimeTestState = {
  generation: string;
  phase: AppRuntimePhase;
  operation: AppRuntimeOperation;
  queuedTargets: readonly string[];
  selectedTarget?: string;
  activeTarget?: string;
  completedTargets: readonly string[];
  reloadRequired: boolean;
  utilityWorkers: number;
  lifecycleWorkers: number;
  farmCallbacks: number;
};

export type StartupTestState = {
  phase: StartupPhase;
  history: StartupPhase[];
  overlayVisible: boolean;
  crateGraphReady: boolean;
  diagnosticsVersion?: number;
  inlayHintVersion?: number;
  cargoCallsBeforeProjectActivation: number;
};

export type LspTestGenerationState<TMonaco, TEditor, TModel> = {
  ready: boolean;
  vfsWrites: Array<{ path: string; content: string }>;
  monaco?: TMonaco;
  editor?: TEditor;
  model?: TModel;
  mainDidOpenComplete?: boolean;
  requestSyntaxTree?: (uri: string) => Promise<string>;
  lspEvents?: unknown[];
  mainDiagnosticsPublicationCount?: number;
  runtime?: RuntimeTestState;
  startup?: StartupTestState;
  lifecycleEvents?: AppRuntimeLifecycleEvent[];
  runtimeHistory?: RuntimeTestState[];
  completedGenerations?: CompletedLspTestGeneration[];
  disposeRuntime?: () => Promise<void>;
  loadTarget?: (triple: string) => Promise<void>;
  runRuntime?: (triple?: string) => Promise<void>;
  forceDestroyTimeout?: () => void;
  remountRuntime?: () => Promise<void>;
  requestCrateGraph?: () => Promise<string>;
  mountFailure?: { message: string; reloadRequired: boolean };
  remount?: {
    phase: "disposing" | "mounting" | "mounted" | "failed";
    error?: string;
    disposeError?: string;
  };
};

export type CompletedLspTestGeneration = {
  runtime?: RuntimeTestState;
  startup?: StartupTestState;
  lifecycleEvents: AppRuntimeLifecycleEvent[];
  runtimeHistory: RuntimeTestState[];
};

export type LspTestGenerationMetadata = {
  runtime: RuntimeTestState;
  startup: StartupTestState;
};

type GenerationState<TMonaco, TEditor, TModel> = LspTestGenerationState<
  TMonaco,
  TEditor,
  TModel
> & { generation?: symbol };

export function captureLspTestGeneration<TMonaco, TEditor, TModel>(
  state: LspTestGenerationState<TMonaco, TEditor, TModel>,
): {
  record(
    producer: (state: LspTestGenerationState<TMonaco, TEditor, TModel>) => void,
  ): boolean;
} {
  const generationState = state as GenerationState<TMonaco, TEditor, TModel>;
  const generation = generationState.generation;
  return {
    record(producer) {
      if (generation === undefined || generationState.generation !== generation)
        return false;
      producer(state);
      return true;
    },
  };
}

export function beginLspTestGeneration<TMonaco, TEditor, TModel>(
  state: LspTestGenerationState<TMonaco, TEditor, TModel>,
  monaco: TMonaco,
  editor: TEditor,
  model: TModel,
  metadata?: LspTestGenerationMetadata,
): { dispose(): void; record: ReturnType<typeof captureLspTestGeneration>["record"] } {
  const generation = Symbol("LSP test generation");
  const generationState = state as GenerationState<TMonaco, TEditor, TModel>;
  generationState.generation = generation;
  state.ready = false;
  state.vfsWrites = [];
  state.monaco = monaco;
  state.editor = editor;
  state.model = model;
  state.lifecycleEvents = [];
  state.runtimeHistory = [];
  state.completedGenerations ??= [];
  delete state.mountFailure;
  delete state.mainDidOpenComplete;
  delete state.requestSyntaxTree;
  delete state.lspEvents;
  delete state.mainDiagnosticsPublicationCount;
  if (metadata === undefined) {
    delete state.runtime;
    delete state.startup;
  } else {
    state.runtime = {
      ...metadata.runtime,
      queuedTargets: [...metadata.runtime.queuedTargets],
      completedTargets: [...metadata.runtime.completedTargets],
    };
    state.runtimeHistory.push({
      ...state.runtime,
      queuedTargets: [...state.runtime.queuedTargets],
      completedTargets: [...state.runtime.completedTargets],
    });
    state.startup = {
      ...metadata.startup,
      history: [...metadata.startup.history],
    };
  }

  const recorder = captureLspTestGeneration(state);
  return {
    record: recorder.record,
    dispose() {
      if (generationState.generation !== generation) return;
      state.completedGenerations ??= [];
      state.completedGenerations.push({
        runtime: state.runtime === undefined
          ? undefined
          : {
            ...state.runtime,
            queuedTargets: [...state.runtime.queuedTargets],
            completedTargets: [...state.runtime.completedTargets],
          },
        startup: state.startup === undefined
          ? undefined
          : { ...state.startup, history: [...state.startup.history] },
        lifecycleEvents: [...(state.lifecycleEvents ?? [])],
        runtimeHistory: (state.runtimeHistory ?? []).map((runtime) => ({
          ...runtime,
          queuedTargets: [...runtime.queuedTargets],
          completedTargets: [...runtime.completedTargets],
        })),
      });
      state.ready = false;
      delete state.monaco;
      delete state.editor;
      delete state.model;
      delete state.mainDidOpenComplete;
      delete state.requestSyntaxTree;
      delete state.lspEvents;
      delete state.mainDiagnosticsPublicationCount;
      delete state.runtime;
      delete state.startup;
      delete state.lifecycleEvents;
      delete state.runtimeHistory;
      delete state.disposeRuntime;
      delete state.loadTarget;
      delete state.runRuntime;
      delete state.forceDestroyTimeout;
      delete state.requestCrateGraph;
      delete generationState.generation;
    },
  };
}
