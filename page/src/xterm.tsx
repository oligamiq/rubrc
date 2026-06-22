import { createEffect, on, onCleanup } from "solid-js";
import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import XTerm from "./solid_xterm";
import { WASIFarm, type WASIFarmRef, wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";
import {
  Directory,
  Fd,
  type Inode,
  PreopenDirectory,
  File,
} from "@bjorn3/browser_wasi_shim";
import type { Ctx } from "./ctx";
import { rust_file } from "./config";

wait_async_polyfill();

let shared_xterm: SharedObject | undefined;
const terminals = new Map<number, Terminal>();
let out_buff = "";
let error_buff = "";

const toUint8Array = (data: any): Uint8Array => {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data && data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data as number[]);
  }
  if (typeof data === "object" && data !== null) {
    if (Array.isArray(data.data)) {
      return new Uint8Array(data.data as number[]);
    }
    const vals = Object.values(data) as number[];
    return new Uint8Array(vals);
  }
  return new Uint8Array();
};

const write_to_terminal = (sessionId: number, data: any) => {
  const terminal = terminals.get(sessionId);
  if (terminal) {
    const bytes = toUint8Array(data);
    const decoded = new TextDecoder().decode(bytes);
    const fixed = decoded.replace(/\n/g, "\r\n");
    terminal.write(fixed);

    if (sessionId === 0) {
      out_buff += fixed;
    }
  }
};

export const SetupMyTerminal = (props: {
  ctx: Ctx;
  sessionId: number;
  isMain: boolean;
  isActive: boolean;
  callback?: (wasi_ref: WASIFarmRef) => void;
}) => {
  let xterm: Terminal | undefined = undefined;

  const fit_addon = new FitAddon();

  createEffect(on(() => props.isActive, (active) => {
    if (active && xterm) {
      const terminal = xterm;
      const timeout = window.setTimeout(() => {
        fit_addon.fit();
        terminal.focus();
        resize_fn({ sessionId: props.sessionId, cols: terminal.cols, rows: terminal.rows }).catch(console.error);
      }, 0);
      onCleanup(() => window.clearTimeout(timeout));
    }
  }, { defer: true }));

  if (!shared_xterm) {
    const terminal_handler = (args: { sessionId: number, data: Uint8Array }) => {
      write_to_terminal(args.sessionId, args.data);
    };

    // @ts-ignore
    terminal_handler.reset_err_buff = () => {
      error_buff = "";
    };
    // @ts-ignore
    terminal_handler.get_err_buff = () => {
      return error_buff;
    };
    // @ts-ignore
    terminal_handler.reset_out_buff = () => {
      out_buff = "";
    };
    // @ts-ignore
    terminal_handler.get_out_buff = () => {
      return out_buff;
    };

    shared_xterm = new SharedObject(terminal_handler, props.ctx.terminal_id);
  }

  new SharedObject(() => {
    return {
      cols: xterm?.cols ?? 80,
      rows: xterm?.rows ?? 24,
    };
  }, props.ctx.get_terminal_size_id);

  const resize_fn = new SharedObjectRef(props.ctx.resize_id).proxy<
    (args: { sessionId: number, cols: number, rows: number }) => Promise<void>
  >();

  const input_char = new SharedObjectRef(props.ctx.input_char_id).proxy<
    (args: { sessionId: number, c: number }) => Promise<void>
  >();

  const input_string = new SharedObjectRef(props.ctx.input_string_id).proxy<
    (args: { sessionId: number, data: string }) => Promise<void>
  >();

  const interrupt_fn = new SharedObjectRef(props.ctx.interrupt_id).proxy<
    (args: { sessionId: number }) => Promise<void>
  >();

  const handleMount = (terminal: Terminal) => {
    xterm = terminal;
    terminals.set(props.sessionId, terminal);

    if (props.isMain && props.callback) {
      get_ref(terminal, props.callback);
    } else {
      const create_session_fn = new SharedObjectRef(props.ctx.create_session_id).proxy<
        (args: { sessionId: number }) => Promise<void>
      >();
      create_session_fn({ sessionId: props.sessionId }).catch(console.error);
    }

    fit_addon.fit();
    resize_fn({ sessionId: props.sessionId, cols: terminal.cols, rows: terminal.rows }).catch(console.error);

    const onWindowResize = () => {
      fit_addon.fit();
      resize_fn({ sessionId: props.sessionId, cols: terminal.cols, rows: terminal.rows }).catch(console.error);
    };
    window.addEventListener("resize", onWindowResize);

    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "v" || e.code === "KeyV")) {
        return false;
      }
      if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "c" || e.code === "KeyC")) {
        if (terminal.hasSelection()) {
          return false;
        }
      }
      return true;
    });

    terminal.focus();

    return () => {
      terminals.delete(props.sessionId);
      window.removeEventListener("resize", onWindowResize);
      console.log(`Terminal ${props.sessionId} unmounted.`);
    };
  };

  const onData = (data: string) => {
    console.log(`[UI] onData received for session ${props.sessionId}, length: ${data.length}, first char code: ${data.charCodeAt(0)}`);

    // Map ANSI escape sequences to custom wasi-shell key codes
    const keyMap: Record<string, number> = {
      "\x1b[A": 0x110001, "\x1bOA": 0x110001, // Up
      "\x1b[B": 0x110002, "\x1bOB": 0x110002, // Down
      "\x1b[C": 0x110003, "\x1bOC": 0x110003, // Right
      "\x1b[D": 0x110004, "\x1bOD": 0x110004, // Left
      "\x1b[H": 0x110005, "\x1bOH": 0x110005, "\x1b[1~": 0x110005, // Home
      "\x1b[F": 0x110006, "\x1bOF": 0x110006, "\x1b[4~": 0x110006, // End
      "\x1b[3~": 0x110007 // Delete
    };

    if (keyMap[data]) {
      input_char({ sessionId: props.sessionId, c: keyMap[data] }).catch(console.error);
      return;
    }

    if (data.length > 1) {
      input_string({ sessionId: props.sessionId, data }).catch(console.error);
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const codePoint = data.codePointAt(i);
      if (codePoint === undefined) {
        continue;
      }
      if (codePoint === 3) {
        interrupt_fn({ sessionId: props.sessionId }).catch(console.error);
        continue;
      }
      input_char({ sessionId: props.sessionId, c: codePoint }).catch(console.error);
      if (codePoint > 0xffff) {
        i++;
      }
    }
  };

  const onResize = (size: { cols: number; rows: number }) => {
    resize_fn({ sessionId: props.sessionId, cols: size.cols, rows: size.rows }).catch(console.error);
  };

  return (
    <XTerm
      onMount={handleMount}
      onData={onData}
      onResize={onResize}
      addons={[fit_addon]}
      class="w-full h-full"
    />
  );
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

      out_buff += fixed;

      return { ret: 0, nwritten: data.byteLength };
    }
    fd_seek() {
      // wasi.ERRNO_BADF 8
      return { ret: 8, offset: 0n };
    }
    fd_filestat_get() {
      // wasi.ERRNO_BADF 8
      return { ret: 8, filestat: null };
    }
  }

  class XtermStderr extends Fd {
    term: Terminal;

    constructor(term: Terminal) {
      super();
      this.term = term;
    }
    fd_seek() {
      // wasi.ERRNO_BADF 8
      return { ret: 8, offset: 0n };
    }
    fd_write(data: Uint8Array) /*: {ret: number, nwritten: number}*/ {
      const decoded = new TextDecoder().decode(data);
      // \n to \r\n
      const fixed = decoded.replace(/\n/g, "\r\n");
      // ansi colors
      this.term.write(`\x1b[31m${fixed}\x1b[0m`);

      error_buff += fixed;

      return { ret: 0, nwritten: data.byteLength };
    }
    fd_filestat_get() {
      // wasi.ERRNO_BADF 8
      return { ret: 8, filestat: null };
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
      ["src", new Directory(toMap([
        ["main.rs", rust_file],
      ]))],
      ["Cargo.toml", new File(new TextEncoder().encode(`[package]
name = "main"
version = "0.1.0"
edition = "2021"
`))],
      [".cargo", new Directory(toMap([
        ["config.toml", new File(new Uint8Array())],
      ]))],
      ["rust-project.json", new File(new TextEncoder().encode(JSON.stringify({
        sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
        crates: [
          {
            root_module: "/src/main.rs",
            edition: "2021",
            deps: []
          }
        ]
      })))],
    ]),
  );

  let download_name = "";
  let download_chunks: Uint8Array[] = [];

  let sysroot_queue: { name: Uint8Array, data: Uint8Array }[] = [];
  let current_sysroot_file: { name: Uint8Array, data: Uint8Array } | null = null;

  const farm = new WASIFarm(
    new XtermStdio(term),
    new XtermStdio(term),
    new XtermStderr(term),
    [root_dir],
    {
      allocator_size: 100 * 1024 * 1024, // 100MB
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      unknown_fn: async (unknown: any) => {
        if (unknown.name === "downloadFileStart") {
          download_name = unknown.args.name;
          download_chunks = [];
        } else if (unknown.name === "downloadFileChunk") {
          const chunk = toUint8Array(unknown.args.data);
          download_chunks.push(chunk);
        } else if (unknown.name === "downloadFileEnd") {
          const blob = new Blob(download_chunks);
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = download_name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          // reset the download state
          download_name = "";
          download_chunks = [];
        } else if (unknown.name === "sysrootStartFetch") {
          const triple = unknown.args.triple;
          sysroot_queue = [];

          try {
            const { fetch_compressed_stream } = await import("../../lib/src/brotli_stream");
            const { parseTar } = await import("../../lib/src/parse_tar");

            const url = triple === "rust-src"
              ? `https://oligamiq.github.io/rust_wasm/v0.2.0/rust-src.tar.br`
              : `https://oligamiq.github.io/rust_wasm/v0.2.0/${triple}.tar.br`;

            const stream = await fetch_compressed_stream(url);
            await parseTar(stream, (file) => {
              sysroot_queue.push({
                name: new TextEncoder().encode(file.name),
                data: file.data || new Uint8Array(),
                is_directory: file.type === "directory"
              });
            });
          } catch (e) {
            console.error("Failed to fetch sysroot/src", e);
          }
          return {};
        }
        else if (unknown.name === "sysrootGetNextFileMeta") {
          if (sysroot_queue.length > 0) {
            current_sysroot_file = sysroot_queue.shift()!;
            return {
              has_file: true,
              name_len: current_sysroot_file.name.length,
              data_len: current_sysroot_file.is_directory ? -1 : current_sysroot_file.data.length
            };
          } else {
            current_sysroot_file = null;
            return { has_file: false, name_len: 0, data_len: 0 };
          }
        } else if (unknown.name === "sysrootReadFileName") {
          if (current_sysroot_file?.name) {
            return { name: Array.from(current_sysroot_file.name) };
          }
          throw new Error("No current sysroot file to read name from");
        } else if (unknown.name === "sysrootReadFileChunk") {
          if (current_sysroot_file) {
            const chunk_len = unknown.args.chunk_len as number;
            const chunk = current_sysroot_file.data.slice(0, chunk_len);
            current_sysroot_file.data = current_sysroot_file.data.slice(chunk_len);
            return { chunk: Array.from(chunk) };
          }
          return { chunk: [] };
        } else if (unknown.name === "terminalWrite") {
          const { session_id, data } = unknown.args;
          write_to_terminal(session_id, data);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 500));
          console.warn("Unknown function called", unknown);
        }
      }
    }
  );

  callback(farm.get_ref());
};
