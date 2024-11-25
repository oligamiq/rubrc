import type { Component } from "solid-js";
import { SetupMyTerminal } from "./xterm";
import type { WASIFarmRef } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";
import { MonacoEditor } from "solid-monaco";
import { default_value } from "./config";

const App = (props: {
  ctx: Ctx;
  callback: (wasi_ref: WASIFarmRef) => void;
}) => {
  const handleMount = (monaco, editor) => {
    // Use monaco and editor instances here
  };
  const handleEditorChange = (value) => {
    // Handle editor change
  };

  return (
    <>
      <MonacoEditor
        language="rust"
        value={default_value}
        height="30vh"
        onMount={handleMount}
      />
      {/* <p class="text-4xl text-green-700 text-center py-20">Hello tailwind!</p> */}
      <SetupMyTerminal ctx={props.ctx} callback={props.callback} />
    </>
  );
};

export default App;
