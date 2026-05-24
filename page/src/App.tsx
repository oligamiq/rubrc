import { createSignal, For, lazy, Suspense } from "solid-js";
import { SetupMyTerminal } from "./xterm";
import type { WASIFarmRef } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";
import { default_value, rust_file } from "./config";
import { DownloadButton, RunButton } from "./btn";
import { triples } from "./sysroot";
import { SharedObjectRef } from "@oligami/shared-object";

const Select = lazy(async () => {
  const selector = import("@thisbeyond/solid-select");
  const css_load = import("@thisbeyond/solid-select/style.css");

  const [mod] = await Promise.all([selector, css_load]);

  return { default: mod.Select };
});

const MonacoEditor = lazy(() =>
  import("solid-monaco").then((mod) => ({ default: mod.MonacoEditor })),
);

const App = (props: {
  ctx: Ctx;
  callback: (wasi_ref: WASIFarmRef) => void;
}) => {
  const handleMount = (_monaco, _editor) => {
    // Use monaco and editor instances here
  };
  const handleEditorChange = (value) => {
    // Handle editor value change
    rust_file.data = new TextEncoder().encode(value);
  };
  let load_additional_sysroot: (triple: string) => void;

  const [triple, setTriple] = createSignal("wasm32-wasip1");
  const [terminalIds, setTerminalIds] = createSignal([0]);

  const addTerminal = () => {
    const nextId = Math.max(...terminalIds()) + 1;
    setTerminalIds([...terminalIds(), nextId]);
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
          value={default_value}
          height="30vh"
          onMount={handleMount}
          onChange={handleEditorChange}
        />
      </Suspense>

      <div class="flex-1 flex flex-col overflow-hidden">
        <For each={terminalIds()}>
          {(id, index) => (
            <div class="flex-1 border-t border-gray-700 relative">
              <SetupMyTerminal 
                ctx={props.ctx} 
                sessionId={id}
                isMain={index() === 0}
                callback={index() === 0 ? props.callback : undefined} 
              />
              <div class="absolute top-0 right-0 bg-gray-800 text-white text-xs px-2 opacity-50">
                Session {id}
              </div>
            </div>
          )}
        </For>
      </div>

      <div class="flex items-center bg-gray-900">
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
        <button 
          class="p-2 mx-2 bg-green-700 text-white rounded hover:bg-green-600 transition-colors"
          onClick={addTerminal}
        >
          Add Terminal
        </button>
      </div>
    </div>
  );
};

export default App;
