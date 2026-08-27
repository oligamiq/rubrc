import { createSignal, For, lazy, onCleanup, Suspense } from "solid-js";
import * as monaco from "monaco-editor";
import { SetupMyTerminal } from "./xterm";
import { DownloadButton, RunButton } from "./btn";
import { triples } from "./sysroot";
import { workspaceFileSystem } from "./workspace_fs";
import {
  type StartupSysrootStatus,
  type VfsReadyResult,
  awaitStartupSysrootsSettlement,
  nextVisibleTerminalSessionId,
} from "./vfs_readiness";
import {
  exposeEditor,
  type LspTestGenerationRecorder,
  markLspReady,
  recordRuntimeTestState,
  recordStartupTestState,
} from "./lsp_test_api";
import {
  type StagedAnalyzerSession,
  StartupCoordinator,
} from "./startup_coordinator";
import type { SysrootArchiveStore } from "./sysroot_archive_store";
import { retainArchiveProgress } from "./app_startup_lifecycle";
import { StartupOverlay } from "./StartupOverlay";
import { TargetSelector } from "./TargetSelector";
import type { AppRuntime } from "./app_runtime.ts";
import { createTargetErrorState } from "./target_error_state.ts";

const MonacoEditor = lazy(() =>
  import("solid-monaco").then((module) => ({ default: module.MonacoEditor })),
);

type Pane = {
  id: number;
  tabs: number[];
  activeTab: number;
};

const yieldAnimationFrame = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      cancelAnimationFrame(frame);
      reject(signal.reason);
    };
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });

const waitForResult = <T,>(promise: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });

const App = (props: {
  runtime: AppRuntime<SysrootArchiveStore>;
  startLspClient: (
    monaco: typeof import("monaco-editor"),
    model: monaco.editor.ITextModel,
  ) => Promise<StagedAnalyzerSession>;
  registerRemountPreparation?: (
    prepare: (() => Promise<void>) | undefined,
  ) => void;
}) => {
  const runtime = props.runtime;
  let mountedMonacoRef: typeof import("monaco-editor") | undefined;
  let testApiGeneration:
    | (LspTestGenerationRecorder & { dispose(): void })
    | undefined;
  let resolveVfsReady!: (result: VfsReadyResult) => void;
  const vfsReady = new Promise<VfsReadyResult>((resolve) => {
    resolveVfsReady = resolve;
  });
  runtime.lspDependencies.factories.createSharedObject(
    (result: VfsReadyResult) => resolveVfsReady(result),
    runtime.ctx.vfs_ready_id,
  );
  const installStartupSysroots = runtime.lspDependencies.factories
    .createSharedObjectRef(runtime.ctx.install_startup_sysroots_id)
    .proxy<() => Promise<StartupSysrootStatus>>();
  let reportStartupProgress:
    | ((id: "rust-src" | "target-sysroot", progress?: number) => void)
    | undefined;
  const archiveProgress = retainArchiveProgress(
    runtime.archiveStore,
    (progress) => {
      const id = progress.triple === "rust-src"
        ? "rust-src"
        : progress.triple === "wasm32-wasip1"
        ? "target-sysroot"
        : undefined;
      if (id === undefined) return;
      const percent = progress.loaded === undefined ||
          progress.total === undefined || progress.total === 0
        ? undefined
        : (progress.loaded / progress.total) * 100;
      reportStartupProgress?.(id, percent);
    },
  );

  const coordinator = new StartupCoordinator({
    waitForVfsRuntime: async (signal) => {
      const result = await waitForResult(vfsReady, signal);
      if (result.ok === false) throw new Error(result.error);
    },
    prefetchSysroots: async (report, signal) => {
      await yieldAnimationFrame(signal);
      reportStartupProgress = report;
      await runtime.archiveStore.prefetch(
        ["rust-src", "wasm32-wasip1"],
        signal,
      );
    },
    initializeAnalyzer: async (model) => {
      await yieldAnimationFrame(runtime.signal);
      const mountedMonaco = mountedMonacoRef;
      if (mountedMonaco === undefined) {
        throw new Error("Monaco is unavailable during analyzer startup");
      }
      const session = await props.startLspClient(
        mountedMonaco,
        model as monaco.editor.ITextModel,
      );
      return {
        activateProject: async (activationModel, activationSignal, warming) => {
          await yieldAnimationFrame(activationSignal);
          await session.activateProject(
            activationModel,
            activationSignal,
            warming,
          );
        },
        flush: () => session.flush(),
        dispose: () => session.dispose(),
      };
    },
    installSysroots: async (signal) => {
      await yieldAnimationFrame(signal);
      const result = await awaitStartupSysrootsSettlement(
        installStartupSysroots,
        signal,
      );
      if (result.ok === false) throw new Error(result.error);
    },
  });
  runtime.adoptCoordinator(coordinator);

  const [startup, setStartup] = createSignal(coordinator.snapshot());
  const [runtimeState, setRuntimeState] = createSignal(runtime.state);
  const unsubscribeStartup = coordinator.subscribe((snapshot) => {
    setStartup(snapshot);
    const generation = testApiGeneration;
    if (generation === undefined) return;
    recordStartupTestState(generation, snapshot);
    if (snapshot.phase === "ready") markLspReady(generation);
  });
  const unsubscribeRuntime = runtime.subscribe((state) => {
    setRuntimeState(state);
    const generation = testApiGeneration;
    if (generation !== undefined) {
      recordRuntimeTestState(generation, runtime, state);
    }
  });

  const handleMount = (
    mountedMonaco: typeof import("monaco-editor"),
    mountedEditor: monaco.editor.IStandaloneCodeEditor,
  ) => {
    mountedMonacoRef = mountedMonaco;
    const uri = mountedMonaco.Uri.parse("file:///src/main.rs");
    const temporaryModel = mountedEditor.getModel();
    const existingModel = mountedMonaco.editor.getModel(uri);
    const initialText = existingModel === null
      ? new TextDecoder().decode(workspaceFileSystem.readFile("/src/main.rs"))
      : "";
    const model = existingModel ??
      mountedMonaco.editor.createModel(initialText, "rust", uri);
    mountedEditor.setModel(model);
    if (temporaryModel !== null && temporaryModel !== model) {
      temporaryModel.dispose();
    }
    mountedEditor.updateOptions({ readOnly: false });
    props.registerRemountPreparation?.(async () => {
      mountedEditor.updateOptions({ readOnly: true });
      for (const workspaceModel of mountedMonaco.editor.getModels()) {
        if (
          workspaceModel.uri.scheme !== "file" ||
          workspaceModel.uri.authority !== "" ||
          !workspaceModel.uri.path.startsWith("/")
        ) continue;
        workspaceFileSystem.writeFile(
          workspaceModel.uri.path,
          new TextEncoder().encode(workspaceModel.getValue()),
          { create: true, overwrite: true, notify: false },
        );
      }
      if (runtime.phase === "ready") await runtime.flushWorkspace();
    });
    testApiGeneration = exposeEditor(
      mountedMonaco,
      mountedEditor,
      model,
      runtime,
    );
    recordRuntimeTestState(testApiGeneration, runtime, runtime.state);
    recordStartupTestState(testApiGeneration, coordinator.snapshot());
    const runtimeStartup = runtime.start();
    void runtimeStartup.catch((error) =>
      console.error("Runtime startup failed:", error)
    );
    void coordinator.start(model).catch((error) =>
      console.error("Staged startup failed:", error)
    );
  };

  const [panes, setPanes] = createSignal<Pane[]>([
    { id: 1, tabs: [0], activeTab: 0 },
  ]);
  const [nextPaneId, setNextPaneId] = createSignal(2);
  const [nextSessionId, setNextSessionId] = createSignal(1);
  const [draggedTab, setDraggedTab] = createSignal<{
    paneId: number;
    sessionId: number;
  } | null>(null);
  const [targetError, setTargetError] = createSignal<string | undefined>();
  const targetErrors = createTargetErrorState({
    signal: runtime.signal,
    publish: setTargetError,
  });

  onCleanup(() => {
    props.registerRemountPreparation?.(undefined);
    unsubscribeStartup();
    unsubscribeRuntime();
    archiveProgress.dispose();
    mountedMonacoRef = undefined;
    const generation = testApiGeneration;
    testApiGeneration = undefined;
    void runtime.dispose()
      .catch((error) => console.error("Runtime cleanup failed:", error))
      .finally(() => generation?.dispose());
  });

  const addTerminalToPane = (paneId: number) => {
    const sessionId = nextVisibleTerminalSessionId(nextSessionId());
    setNextSessionId(sessionId + 1);
    setPanes(
      panes().map((pane) =>
        pane.id === paneId
          ? {
            ...pane,
            tabs: [...pane.tabs, sessionId],
            activeTab: sessionId,
          }
          : pane
      ),
    );
  };

  const splitPane = (paneId: number) => {
    const sessionId = nextVisibleTerminalSessionId(nextSessionId());
    setNextSessionId(sessionId + 1);
    const newPaneId = nextPaneId();
    setNextPaneId(newPaneId + 1);
    const current = panes();
    const index = current.findIndex((pane) => pane.id === paneId);
    if (index === -1) return;
    const updated = [...current];
    updated.splice(index + 1, 0, {
      id: newPaneId,
      tabs: [sessionId],
      activeTab: sessionId,
    });
    setPanes(updated);
  };

  const removeTerminal = (event: Event, paneId: number, sessionId: number) => {
    event.stopPropagation();
    if (sessionId === 0) return;
    void runtime.closeTerminal(sessionId).catch(console.error);
    setPanes(
      panes()
        .map((pane) => {
          if (pane.id !== paneId) return pane;
          const tabs = pane.tabs.filter((tab) => tab !== sessionId);
          const activeTab = pane.activeTab === sessionId
            ? tabs.at(-1) ?? -1
            : pane.activeTab;
          return { ...pane, tabs, activeTab };
        })
        .filter((pane) => pane.tabs.length > 0 || pane.id === panes()[0].id),
    );
  };

  const setActiveTab = (paneId: number, sessionId: number) => {
    setPanes(
      panes().map((pane) =>
        pane.id === paneId ? { ...pane, activeTab: sessionId } : pane
      ),
    );
  };

  const onDragStart = (event: DragEvent, paneId: number, sessionId: number) => {
    setDraggedTab({ paneId, sessionId });
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };

  const onDrop = (event: DragEvent, targetPaneId: number) => {
    event.preventDefault();
    const dragged = draggedTab();
    if (!dragged || dragged.paneId === targetPaneId) return;
    setPanes(
      panes()
        .map((pane) => {
          if (pane.id === dragged.paneId) {
            const tabs = pane.tabs.filter((tab) => tab !== dragged.sessionId);
            const activeTab = pane.activeTab === dragged.sessionId
              ? tabs.at(-1) ?? -1
              : pane.activeTab;
            return { ...pane, tabs, activeTab };
          }
          if (pane.id === targetPaneId) {
            return {
              ...pane,
              tabs: [...pane.tabs, dragged.sessionId],
              activeTab: dragged.sessionId,
            };
          }
          return pane;
        })
        .filter((pane) => pane.tabs.length > 0 || pane.id === panes()[0].id),
    );
    setDraggedTab(null);
  };

  const allSessionIds = () => {
    const ids: number[] = [];
    for (const pane of panes()) {
      for (const sessionId of pane.tabs) {
        if (!ids.includes(sessionId)) ids.push(sessionId);
      }
    }
    return ids;
  };

  const controlsDisabled = () =>
    startup().phase !== "ready" || runtimeState().phase !== "ready";

  return (
    <div class="h-[100dvh] w-full flex flex-col overflow-hidden overscroll-none">
      <div class="relative h-[30vh]">
        <Suspense
          fallback={
            <div class="h-full w-full p-4 text-white">
              <p class="text-4xl text-green-700 text-center">
                Loading editor...
              </p>
            </div>
          }
        >
          <MonacoEditor
            language="plaintext"
            options={{ readOnly: false }}
            height="100%"
            onMount={(mountedMonaco, mountedEditor) =>
              handleMount(
                mountedMonaco as unknown as typeof import("monaco-editor"),
                mountedEditor as unknown as monaco.editor.IStandaloneCodeEditor,
              )}
          />
        </Suspense>
        {startup().phase !== "ready" && <StartupOverlay state={startup()} />}
      </div>

      <div class="flex-1 flex flex-col min-h-0 bg-black border-t border-gray-700">
        <div class="flex">
          <For each={panes()}>
            {(pane, paneIndex) => (
              <div
                class={`flex-1 flex bg-gray-800 overflow-x-auto min-w-0 ${
                  paneIndex() > 0 ? "border-l border-gray-700" : ""
                }`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onDrop(event, pane.id)}
              >
                <For each={pane.tabs}>
                  {(sessionId) => (
                    <div
                      draggable={true}
                      onDragStart={(event) =>
                        onDragStart(event, pane.id, sessionId)}
                      class={`flex items-center transition-colors border-r border-gray-700 whitespace-nowrap cursor-pointer ${
                        pane.activeTab === sessionId
                          ? "bg-gray-900 border-b-2 border-b-green-500"
                          : "bg-gray-800 hover:bg-gray-700"
                      }`}
                      onClick={() => setActiveTab(pane.id, sessionId)}
                    >
                      <button
                        type="button"
                        class={`px-4 py-2 text-sm focus:outline-none ${
                          pane.activeTab === sessionId
                            ? "text-green-400"
                            : "text-gray-400"
                        }`}
                      >
                        Session {sessionId}
                      </button>
                      {sessionId !== 0 && (
                        <button
                          type="button"
                          class="pr-3 text-gray-500 hover:text-red-400 focus:outline-none"
                          onClick={(event) =>
                            removeTerminal(event, pane.id, sessionId)}
                          title="Close Tab"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class={`px-3 py-2 text-sm transition-colors whitespace-nowrap focus:outline-none ${
                    controlsDisabled()
                      ? "text-gray-600 cursor-not-allowed"
                      : "text-gray-400 hover:text-white hover:bg-gray-700"
                  }`}
                  onClick={() => addTerminalToPane(pane.id)}
                  disabled={controlsDisabled()}
                  title="New Tab"
                >
                  +
                </button>
                <div class="flex-1 min-w-[20px]"></div>
                <button
                  type="button"
                  class={`px-3 py-2 text-sm transition-colors whitespace-nowrap focus:outline-none border-l border-gray-700 ${
                    controlsDisabled()
                      ? "text-gray-600 cursor-not-allowed"
                      : "text-gray-400 hover:text-white hover:bg-gray-700"
                  }`}
                  onClick={() => splitPane(pane.id)}
                  disabled={controlsDisabled()}
                  title="Split Pane Horizontally"
                >
                  ◫
                </button>
              </div>
            )}
          </For>
        </div>

        <div
          class="flex-1 min-h-0 min-w-0 grid overflow-hidden"
          style={{
            "grid-template-columns": `repeat(${panes().length}, minmax(0, 1fr))`,
          }}
        >
          <For each={allSessionIds()}>
            {(sessionId) => {
              const paneIndex = () =>
                panes().findIndex((pane) => pane.tabs.includes(sessionId));
              const isActive = () => {
                const index = paneIndex();
                return index !== -1 && panes()[index].activeTab === sessionId;
              };
              return (
                <div
                  class="relative w-full h-full min-w-0 min-h-0 overflow-hidden"
                  style={{
                    "grid-column": (paneIndex() + 1).toString(),
                    "grid-row": "1",
                    display: isActive() ? "block" : "none",
                  }}
                >
                  <SetupMyTerminal
                    runtime={runtime}
                    sessionId={sessionId}
                    isActive={isActive()}
                  />
                </div>
              );
            }}
          </For>
        </div>
      </div>

      <div class="flex flex-nowrap items-center justify-between gap-2 sm:gap-4 bg-gray-950 border-t border-gray-800 p-2 sm:px-6 sm:py-3 shadow-lg z-10 relative">
        <div class="flex-none">
          <RunButton
            triple={runtimeState().selectedTarget}
            run={(triple) => runtime.run(triple)}
            disabled={controlsDisabled() || runtimeState().operation !== "idle"}
          />
        </div>
        <div class="flex-1 min-w-[150px] sm:max-w-xs mx-auto">
          <TargetSelector
            options={triples}
            selectedTarget={runtimeState().selectedTarget}
            activeTarget={runtimeState().activeTarget}
            operation={runtimeState().operation}
            completedTargets={runtimeState().completedTargets}
            disabled={controlsDisabled() || runtimeState().operation === "run"}
            loadTarget={(triple) =>
              targetErrors.load(triple, () => runtime.loadTarget(triple))}
          />
          {targetError() && (
            <p class="mt-1 text-xs text-red-400" role="alert">
              {targetError()}
            </p>
          )}
        </div>
        <div class="flex-none">
          <DownloadButton download={(file) => runtime.download(file)} />
        </div>
      </div>
    </div>
  );
};

export default App;
