import type { Component } from "solid-js";
import { SetupMyTerminal } from "./xterm";
import type { WASIFarmRef } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";

const App = (props: {
  ctx: Ctx;
  callback: (wasi_ref: WASIFarmRef) => void;
}) => {
  return (
    <>
      <p class="text-4xl text-green-700 text-center py-20">Hello tailwind!</p>
      <SetupMyTerminal xterm_id={props.ctx.terminal_id} callback={props.callback} />
    </>
  );
};

export default App;
