import { createSignal, For, lazy, Suspense } from "solid-js";
import { SetupMyTerminal } from "./xterm";
import type { WASIFarmRef } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";
import { default_value, rust_file } from "./config";
import { DownloadButton, RunButton } from "./btn";
import { triples } from "./sysroot";
import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { createLspConnection } from "./lsp_bridge";
import { MonacoLanguageClient } from "monaco-languageclient";

const Select = lazy(async () => {
  const selector = import("@thisbeyond/solid-select");
  const css_load = import("@thisbeyond/solid-select/style.css");

  const [mod] = await Promise.all([selector, css_load]);

  return { default: mod.Select };
});

const MonacoEditor = lazy(() =>
  import("solid-monaco").then((mod) => ({ default: mod.MonacoEditor })),
);

type Pane = {
  id: number;
  tabs: number[];
  activeTab: number;
};

const App = (props: {
  ctx: Ctx;
  callback: (wasi_ref: WASIFarmRef) => void;
}) => {
  const handleMount = (_monaco, _editor) => {
    console.log("[App] Monaco Editor mounted. Starting LSP client...");
    const connection = createLspConnection(props.ctx);
    console.log("[App] LSP connection created.");
    const languageClient = new MonacoLanguageClient({
      name: "Rust Language Client",
      clientOptions: {
        documentSelector: [{ scheme: "file", language: "rust" }],
        initializationOptions: {
          cargo: {
            sysroot: "/sysroot",
          },
          procMacro: {
            enable: false,
          },
        },
      },
      messageTransports: connection
    });
    console.log("[App] Starting LanguageClient...");
    languageClient.start().then(() => {
      console.log("[App] LanguageClient started successfully.");
    }).catch(e => {
      console.error("[App] Failed to start LanguageClient:", e);
    });
  };
  const handleEditorChange = (value) => {
    // Handle editor value change
    rust_file.data = new TextEncoder().encode(value);
    
    // Sync to Rust VFS
    const input_string = new SharedObjectRef(props.ctx.input_string_id).proxy<
      (args: { sessionId: number, data: string }) => Promise<void>
    >();
    
    // session_id 0 is fine for sync, but we need a specific way to trigger WRITE_FILE
    // In util_cmd.ts, we'll handle a special sessionId or just add a new SharedObject
    // For now, let's assume util_cmd.ts will be updated to handle a special sessionId for VFS SYNC
    input_string({ 
      sessionId: 0xEEEEEEEE, // Special ID for VFS Sync
      data: JSON.stringify({ path: "/src/main.rs", content: value })
    }).catch(console.error);
  };
  let load_additional_sysroot: (triple: string) => void;

  const [triple, setTriple] = createSignal("wasm32-wasip1");
  const [panes, setPanes] = createSignal<Pane[]>([{ id: 1, tabs: [0], activeTab: 0 }]);
  const [nextPaneId, setNextPaneId] = createSignal(2);
  const [nextSessionId, setNextSessionId] = createSignal(1);
  const [draggedTab, setDraggedTab] = createSignal<{ paneId: number, sessionId: number } | null>(null);
  const [isReady, setIsReady] = createSignal(false);

  let shared_ready: SharedObject | undefined;
  if (!shared_ready) {
    shared_ready = new SharedObject(() => {
      setIsReady(true);
    }, props.ctx.vfs_ready_id);
  }

  const close_session_fn = new SharedObjectRef(props.ctx.close_session_id).proxy<
    (args: { sessionId: number }) => Promise<void>
  >();

  const addTerminalToPane = (paneId: number) => {
    const newSessionId = nextSessionId();
    setNextSessionId(newSessionId + 1);
    setPanes(panes().map(p => {
      if (p.id === paneId) {
        return { ...p, tabs: [...p.tabs, newSessionId], activeTab: newSessionId };
      }
      return p;
    }));
  };

  const splitPane = (paneId: number) => {
    const newSessionId = nextSessionId();
    setNextSessionId(newSessionId + 1);
    const newPaneId = nextPaneId();
    setNextPaneId(newPaneId + 1);
    
    const currentPanes = panes();
    const paneIndex = currentPanes.findIndex(p => p.id === paneId);
    if (paneIndex === -1) return;
    
    const newPanes = [...currentPanes];
    newPanes.splice(paneIndex + 1, 0, { id: newPaneId, tabs: [newSessionId], activeTab: newSessionId });
    setPanes(newPanes);
  };

  const removeTerminal = (e: Event, paneId: number, sessionId: number) => {
    e.stopPropagation();
    if (sessionId === 0) return; // Cannot close main session

    close_session_fn({ sessionId }).catch(console.error);

    setPanes(panes().map(p => {
      if (p.id === paneId) {
        const newTabs = p.tabs.filter(t => t !== sessionId);
        const newActive = p.activeTab === sessionId 
          ? (newTabs.length > 0 ? newTabs[newTabs.length - 1] : -1) 
          : p.activeTab;
        return { ...p, tabs: newTabs, activeTab: newActive };
      }
      return p;
    }).filter(p => p.tabs.length > 0 || p.id === panes()[0].id));
  };

  const setActiveTab = (paneId: number, sessionId: number) => {
    setPanes(panes().map(p => p.id === paneId ? { ...p, activeTab: sessionId } : p));
  };

  const onDragStart = (e: DragEvent, paneId: number, sessionId: number) => {
    setDraggedTab({ paneId, sessionId });
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
    }
  };

  const onDrop = (e: DragEvent, targetPaneId: number) => {
    e.preventDefault();
    const dragged = draggedTab();
    if (!dragged) return;
    if (dragged.paneId === targetPaneId) return;

    setPanes(panes().map(p => {
      if (p.id === dragged.paneId) {
        const newTabs = p.tabs.filter(t => t !== dragged.sessionId);
        const newActive = p.activeTab === dragged.sessionId 
          ? (newTabs.length > 0 ? newTabs[newTabs.length - 1] : -1) 
          : p.activeTab;
        return { ...p, tabs: newTabs, activeTab: newActive };
      }
      if (p.id === targetPaneId) {
        return { ...p, tabs: [...p.tabs, dragged.sessionId], activeTab: dragged.sessionId };
      }
      return p;
    }).filter(p => p.tabs.length > 0 || p.id === panes()[0].id));
    
    setDraggedTab(null);
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  const allSessionIds = () => {
    const ids: number[] = [];
    for (const p of panes()) {
      for (const t of p.tabs) {
        if (!ids.includes(t)) ids.push(t);
      }
    }
    return ids;
  };

  return (
    <div class="h-screen flex flex-col overflow-hidden">
      <Suspense
        fallback={
          <div
            class="p-4 text-white"
            style={{ width: "100vw", height: "30vh" }}
          >
            <p class="text-4xl text-green-700 text-center">Loading editor...</p>
          </div>
        }
      >
        <MonacoEditor
          language="rust"
          path="/src/main.rs"
          value={default_value}
          height="30vh"
          onMount={handleMount}
          onChange={handleEditorChange}
        />
      </Suspense>

      <div class="flex-1 flex flex-col min-h-0 bg-black border-t border-gray-700">
        <div class="flex">
          <For each={panes()}>
            {(pane, pIndex) => (
              <div class={`flex-1 flex bg-gray-800 overflow-x-auto min-w-0 ${pIndex() > 0 ? 'border-l border-gray-700' : ''}`}
                onDragOver={onDragOver}
                onDrop={(e) => onDrop(e, pane.id)}
              >
                <For each={pane.tabs}>
                  {(sessionId) => (
                    <div
                      draggable={true}
                      onDragStart={(e) => onDragStart(e, pane.id, sessionId)}
                      class={`flex items-center transition-colors border-r border-gray-700 whitespace-nowrap cursor-pointer ${
                        pane.activeTab === sessionId 
                          ? "bg-gray-900 border-b-2 border-b-green-500" 
                          : "bg-gray-800 hover:bg-gray-700"
                      }`}
                      onClick={() => setActiveTab(pane.id, sessionId)}
                    >
                      <button
                        class={`px-4 py-2 text-sm focus:outline-none ${
                          pane.activeTab === sessionId ? "text-green-400" : "text-gray-400"
                        }`}
                      >
                        Session {sessionId}
                      </button>
                      {sessionId !== 0 && (
                        <button
                          class="pr-3 text-gray-500 hover:text-red-400 focus:outline-none"
                          onClick={(e) => removeTerminal(e, pane.id, sessionId)}
                          title="Close Tab"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  )}
                </For>
                <button 
                  class={`px-3 py-2 text-sm transition-colors whitespace-nowrap focus:outline-none ${
                    isReady() 
                      ? "text-gray-400 hover:text-white hover:bg-gray-700" 
                      : "text-gray-600 cursor-not-allowed"
                  }`}
                  onClick={() => addTerminalToPane(pane.id)}
                  disabled={!isReady()}
                  title="New Tab"
                >
                  +
                </button>
                <div class="flex-1 min-w-[20px]"></div>
                <button
                  class={`px-3 py-2 text-sm transition-colors whitespace-nowrap focus:outline-none border-l border-gray-700 ${
                    isReady() 
                      ? "text-gray-400 hover:text-white hover:bg-gray-700" 
                      : "text-gray-600 cursor-not-allowed"
                  }`}
                  onClick={() => splitPane(pane.id)}
                  disabled={!isReady()}
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
          style={{ "grid-template-columns": `repeat(${panes().length}, minmax(0, 1fr))` }}
        >
          <For each={allSessionIds()}>
            {(sessionId) => {
               const paneIndex = () => panes().findIndex(p => p.tabs.includes(sessionId));
               const isActive = () => {
                 const pIdx = paneIndex();
                 if (pIdx === -1) return false;
                 return panes()[pIdx].activeTab === sessionId;
               };

               return (
                 <div 
                   class="relative w-full h-full min-w-0 min-h-0 overflow-hidden"
                   style={{ 
                     "grid-column": (paneIndex() + 1).toString(),
                     "grid-row": "1",
                     "display": isActive() ? "block" : "none"
                   }}
                 >
                   <SetupMyTerminal 
                     ctx={props.ctx} 
                     sessionId={sessionId}
                     isMain={sessionId === 0}
                     isActive={isActive()}
                     callback={sessionId === 0 ? props.callback : undefined} 
                   />
                 </div>
               )
            }}
          </For>
        </div>
      </div>

      <div class="flex items-center bg-gray-900 border-t border-gray-700">
        <div class="p-2 text-white">
          <RunButton triple={triple()} />
        </div>
        <div class="p-2 text-white flex-1 max-w-sm">
          <Select
            options={triples}
            class="text-sm text-green-700"
            onChange={(value) => {
              setTriple(value);
              if (load_additional_sysroot === undefined) {
                load_additional_sysroot = new SharedObjectRef(
                  props.ctx.load_additional_sysroot_id,
                ).proxy<(triple: string) => void>();
              }
              load_additional_sysroot(value);
            }}
          />
        </div>
        <div class="p-2 text-white">
          <DownloadButton />
        </div>
      </div>
    </div>
  );
};

export default App;
