import { createSignal, type Component } from "solid-js";
import { SetupMyTerminal } from "./xterm";
import type { WASIFarmRef } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";
import { MonacoEditor } from "solid-monaco";
import { default_value, rust_file } from "./config";
import { DownloadButton, RunButton } from "./btn";
import { triples } from "./sysroot";
import { Select } from "@thisbeyond/solid-select";
import { SharedObjectRef } from "@oligami/shared-object";

const App = (props: {
  ctx: Ctx;
  callback: (wasi_ref: WASIFarmRef) => void;
}) => {
  const handleMount = (monaco, editor) => {
    // Use monaco and editor instances here
  };
  const handleEditorChange = (value) => {
    // Handle editor value change
    rust_file.data = new TextEncoder().encode(value);
  };
  let load_additional_sysroot: (string) => void;

  const [triple, setTriple] = createSignal("wasm32-wasip1");

  return (
    <>
      <MonacoEditor
        language="rust"
        value={default_value}
        height="30vh"
        onMount={handleMount}
        onChange={handleEditorChange}
      />
      {/* <p class="text-4xl text-green-700 text-center">Hello tailwind!</p> */}
      <SetupMyTerminal ctx={props.ctx} callback={props.callback} />
      <div class="flex">
        <div class="p-4 text-white">
          <RunButton triple={triple()} />
        </div>
        <div class="p-4 text-white" style={{ width: "60vw" }}>
          <Select
            options={triples}
            class="text-4xl text-green-700"
            onChange={(value) => {
              console.log(value);
              setTriple(value);
              if (load_additional_sysroot === undefined) {
                load_additional_sysroot = new SharedObjectRef(
                  props.ctx.load_additional_sysroot_id,
                ).proxy<(string) => void>();
              }
              load_additional_sysroot(value);
            }}
          />
        </div>
        <div class="p-4 text-white">
          <DownloadButton />
        </div>
      </div>
    </>
  );
};

export default App;
