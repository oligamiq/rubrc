import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import XTerm from "./solid_xterm";
import { WASIFarm, type WASIFarmRef } from "@oligami/browser_wasi_shim-threads";
import {
  Directory,
  Fd,
  type Inode,
  PreopenDirectory,
  File,
} from "@bjorn3/browser_wasi_shim";
import type { Ctx } from "./ctx";
import { rust_file } from "./config";

let shared_xterm: SharedObject;

export const SetupMyTerminal = (props: {
  ctx: Ctx;
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
  shared_xterm = new SharedObject(write_terminal, props.ctx.terminal_id);

  const handleMount = (terminal: Terminal) => {
    xterm = terminal;
    xterm.write(terminal_queue.join(""));
    terminal_queue.length = 0;
    get_ref(terminal, props.callback);
    return () => {
      console.log("Terminal unmounted.");
    };
  };

  let keys = "";

  const waiter = new SharedObjectRef(props.ctx.waiter_id).proxy<{
    is_all_done: () => boolean;
  }>();
  let cmd_parser: (...string) => void;

  let before_cmd = "";
  const on_enter = async (terminal) => {
    before_cmd = keys;
    terminal.write("\r\n");
    if (await waiter.is_all_done()) {
      cmd_parser = new SharedObjectRef(props.ctx.cmd_parser_id).proxy<
        (...string) => void
      >();
      const parsed = keys.split(" ");
      await cmd_parser(...parsed);
    } else {
      terminal.write("this is not done yet\r\n");
    }
    keys = "";
  };
  const keydown = (
    event: { key: string; domEvent: KeyboardEvent },
    terminal,
  ) => {
    if (event.key === "\r") {
      terminal.write("\r\n");
      on_enter(terminal);
    } else if (event.domEvent.code === "Backspace") {
      terminal.write("\b \b");
      keys = keys.slice(0, -1);
    } else if (event.domEvent.code === "ArrowUp") {
      keys = before_cmd;
      terminal.write(`\r>${keys} \r`);
    } else if (
      event.domEvent.code === "ArrowDown" ||
      event.domEvent.code === "ArrowLeft" ||
      event.domEvent.code === "ArrowRight" ||
      event.domEvent.code === "Tab"
    ) {
      terminal.write(event.key);
    } else {
      keys += event.key;
      terminal.write(event.key);
    }
  };

  // You can pass either an ITerminalAddon constructor or an instance, depending on whether you need to access it later.
  return <XTerm onMount={handleMount} onKey={keydown} addons={[FitAddon]} />;
};

const get_ref = (term, callback) => {
  class XtermStdio extends Fd {
    term: Terminal;

    constructor(term: Terminal) {
      super();
      this.term = term;
    }
    fd_write(data: Uint8Array) /*: {ret: number, nwritten: number}*/ {
      const decoded = new TextDecoder().decode(data);
      // \n to \r\n
      const fixed = decoded.replace(/\n/g, "\r\n");
      this.term.write(fixed);
      return { ret: 0, nwritten: data.byteLength };
    }
  }

  const toMap = (arr: Array<[string, Inode]>) => {
    const map = new Map<string, Inode>();
    for (const [key, value] of arr) {
      map.set(key, value);
    }
    return map;
  };

  const root_dir = new PreopenDirectory(
    "/",
    toMap([
      ["sysroot", new Directory([])],
      ["main.rs", rust_file],
    ]),
  );

  const farm = new WASIFarm(
    new XtermStdio(term),
    new XtermStdio(term),
    new XtermStdio(term),
    [root_dir],
  );

  callback(farm.get_ref());
};
