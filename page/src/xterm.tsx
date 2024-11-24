import { SharedObject } from "@oligami/shared-object";
import { FitAddon } from "@xterm/addon-fit";
import { createMemo } from "solid-js";
import type { Terminal } from "@xterm/xterm";
import XTerm from "./solid_xterm";
import { WASIFarm, type WASIFarmRef } from "@oligami/browser_wasi_shim-threads";
import { Fd } from "@bjorn3/browser_wasi_shim";

let shared_xterm: SharedObject;

export const SetupMyTerminal = (props: {
  xterm_id: string;
  callback: (wasi_ref: WASIFarmRef) => void;
}) => {
  let xterm: Terminal | undefined = undefined;

  const terminal_queue = [];
  const write_terminal = (str: string) => {
    if (xterm) {
      xterm.write(str);
    } else {
      terminal_queue.push(str);
    }
  };
  shared_xterm = new SharedObject(write_terminal, props.xterm_id);

  const handleMount = (terminal: Terminal) => {
    xterm = terminal;
    xterm.write(terminal_queue.join(""));
    terminal_queue.length = 0;
    get_ref(terminal, props.callback);
    return () => {
      console.log("Terminal unmounted.");
    };
  };

  // You can pass either an ITerminalAddon constructor or an instance, depending on whether you need to access it later.
  return <XTerm onMount={handleMount} addons={[FitAddon]} />;
};

const get_ref = (term, callback) => {
  class XtermStdio extends Fd {
    term: Terminal;

    constructor(term: Terminal) {
      super();
      this.term = term;
    }
    fd_write(data: Uint8Array) /*: {ret: number, nwritten: number}*/ {
      this.term.write(new TextDecoder().decode(data));
      return { ret: 0, nwritten: data.byteLength };
    }
  }

  const farm = new WASIFarm(
    new XtermStdio(term),
    new XtermStdio(term),
    new XtermStdio(term),
    [],
  );

  callback(farm.get_ref());
};
