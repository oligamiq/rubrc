import type { Component } from "solid-js";
import { SetupMyTerminal } from "./xterm";
import type { WASIFarmRef } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";
import { MonacoEditor } from "solid-monaco";
import { default_value, rust_file } from "./config";
import { Button } from "./btn";

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

  return (
    <>
      <MonacoEditor
        language="rust"
        value={default_value}
        height="30vh"
        onMount={handleMount}
        onChange={handleEditorChange}
      />
      {/* <p class="text-4xl text-green-700 text-center py-20">Hello tailwind!</p> */}
      <SetupMyTerminal ctx={props.ctx} callback={props.callback} />
      <Button />
    </>
  );
};

export default App;
