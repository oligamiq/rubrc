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

import { wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";

wait_async_polyfill();

let shared_xterm: SharedObject;

let error_buff = "";
let out_buff = "";

export const SetupMyTerminal = (props: {
  ctx: Ctx;
  callback: (wasi_ref: WASIFarmRef) => void;
}) => {
  let xterm: Terminal | undefined = undefined;

  const fit_addon = new FitAddon();

  const terminal_queue = [];
  const write_terminal = (str: string) => {
    if (xterm) {
      xterm.write(str);
    } else {
      terminal_queue.push(str);
    }
  };
  write_terminal.reset_err_buff = () => {
    error_buff = "";
  };
  write_terminal.get_err_buff = () => {
    console.log("called get_err_buff");
    return error_buff;
  };
  write_terminal.get_out_buff = () => {
    console.log("called get_out_buff");
    return out_buff;
  };
  write_terminal.reset_out_buff = () => {
    out_buff = "";
  };
  shared_xterm = new SharedObject(write_terminal, props.ctx.terminal_id);

  new SharedObject(() => {
    return {
      cols: xterm?.cols ?? 80,
      rows: xterm?.rows ?? 24,
    };
  }, props.ctx.get_terminal_size_id);

  const handleMount = (terminal: Terminal) => {
    xterm = terminal;
    xterm.write(terminal_queue.join(""));
    terminal_queue.length = 0;
    get_ref(terminal, props.callback);

    fit_addon.fit();

    const onWindowResize = () => {
      fit_addon.fit();
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      console.log("Terminal unmounted.");
    };
  };

  const input_char = new SharedObjectRef(props.ctx.input_char_id).proxy<
    (c: number) => Promise<void>
  >();

  const interrupt_fn = new SharedObjectRef(props.ctx.interrupt_id).proxy<
    () => Promise<void>
  >();

  const resize_fn = new SharedObjectRef(props.ctx.resize_id).proxy<
    (cols: number, rows: number) => Promise<void>
  >();

  const onData = (data: string) => {
    for (let i = 0; i < data.length; i++) {
      if (data.charCodeAt(i) === 3) {
        interrupt_fn().catch(console.error);
        continue;
      }
      // console.log("sending char code", data.charCodeAt(i));
      input_char(data.charCodeAt(i)).catch(console.error);
    }
  };

  const onResize = (size: { cols: number; rows: number }) => {
    resize_fn(size.cols, size.rows).catch(console.error);
  };

  // You can pass either an ITerminalAddon constructor or an instance, depending on whether you need to access it later.
  return (
    <XTerm
      onMount={handleMount}
      onData={onData}
      onResize={onResize}
      addons={[fit_addon]}
      class="w-full"
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
      ["main.rs", rust_file],
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
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      unknown_fn: async (unknown: any) => {
        if (unknown.name === "downloadFileStart") {
          download_name = unknown.args.name;
          download_chunks = [];
        } else if (unknown.name === "downloadFileChunk") {
          let chunk = unknown.args.data;
          if (chunk instanceof Uint8Array) {
            download_chunks.push(chunk);
          } else if (chunk && chunk.buffer instanceof ArrayBuffer) {
            download_chunks.push(new Uint8Array(chunk.buffer));
          } else if (Array.isArray(chunk)) {
            download_chunks.push(new Uint8Array(chunk));
          } else if (typeof chunk === 'object' && chunk !== null) {
            if (Array.isArray(chunk.data)) {
              download_chunks.push(new Uint8Array(chunk.data));
            } else {
              const vals = Object.values(chunk) as number[];
              download_chunks.push(new Uint8Array(vals));
            }
          }
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
        } else if (unknown.name === "terminalWrite") {
          const data = unknown.args.data as Uint8Array;
          const decoded = new TextDecoder().decode(data);
          const fixed = decoded.replace(/\n/g, "\r\n");
          term.write(fixed);
          out_buff += fixed;
        } else if (unknown.name === "sysrootStartFetch") {
          const triple = unknown.args.triple;
          sysroot_queue = [];

          try {
            const { fetch_compressed_stream } = await import("../../lib/src/brotli_stream");
            const { parseTar } = await import("../../lib/src/parse_tar");

            const stream = await fetch_compressed_stream(`https://oligamiq.github.io/rust_wasm/v0.2.0/${triple}.tar.br`);
            await parseTar(stream, (file) => {
              sysroot_queue.push({
                name: new TextEncoder().encode(file.name),
                data: file.data || new Uint8Array(),
                is_directory: file.type === "directory"
              });
            });
          } catch (e) {
            console.error("Failed to fetch sysroot", e);
          }
          return {};
        } else if (unknown.name === "sysrootGetNextFileMeta") {
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
            return { name: current_sysroot_file.name };
          }
          throw new Error("No current sysroot file to read name from");
        } else if (unknown.name === "sysrootReadFileChunk") {
          if (current_sysroot_file) {
            const chunk_len = unknown.args.chunk_len as number;
            const chunk = current_sysroot_file.data.slice(0, chunk_len);
            current_sysroot_file.data = current_sysroot_file.data.slice(chunk_len);
            return { chunk };
          }
          return { chunk: new Uint8Array() };
        } else {
          await new Promise((resolve) => setTimeout(resolve, 500));
          console.warn("Unknown function called", unknown);
        }
      }
    }
  );

  callback(farm.get_ref());
};
