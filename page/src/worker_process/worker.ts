import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "../ctx";

import { wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";

wait_async_polyfill();

let terminal: (string) => Promise<void>;
let rustc_worker: Worker;
let ctx: Ctx;
import RustcWorker from "./rustc?worker";
let shared: SharedObject;

const wasi_refs = [undefined];

globalThis.addEventListener("message", async (event) => {
  if (event.data.ctx) {
    rustc_worker = new RustcWorker();
    ctx = event.data.ctx;
    rustc_worker.postMessage({ ctx });

    terminal = new SharedObjectRef(ctx.terminal_id).proxy<
      (string) => Promise<void>
    >();

    const input_char = new SharedObjectRef(ctx.input_char_id).proxy<
      (c: number) => Promise<void>
    >();

    const run_command = async (args: string[]) => {
      const line = args.join(" ");
      for (let i = 0; i < line.length; i++) {
        await input_char(line.charCodeAt(i));
      }
      await input_char(13);
    };

    shared = new SharedObject((triple) => {
      (async () => {
        await run_command(["load_sysroot", triple]);
      })();
    }, ctx.load_additional_sysroot_id);
  } else if (event.data.wasi_ref) {
    const { wasi_ref } = event.data;

    rustc_worker.postMessage({ wasi_ref_ui: wasi_ref });
    wasi_refs[0] = wasi_ref;
    if (wasi_refs.every((ref) => ref !== undefined)) {
      setup_util_worker(wasi_refs, ctx);
    }
  }
});

import util_cmd_worker from "./util_cmd?worker";
import run_llvm_worker from "./llvm?worker";

const setup_util_worker = (
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  wasi_refs: any[],
  ctx: Ctx,
) => {
  const util_worker = new util_cmd_worker();
  const llvm_worker = new run_llvm_worker();

  util_worker.postMessage({
    wasi_refs,
    ctx,
  });

  llvm_worker.postMessage({
    wasi_refs,
    ctx,
  });
};
