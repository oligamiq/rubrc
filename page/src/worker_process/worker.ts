import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "../ctx";

import { wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";

wait_async_polyfill();

let terminal: (string) => Promise<void>;
let ctx: Ctx;
let shared: SharedObject;

const wasi_refs = [undefined];

let util_worker_ref: Worker | undefined;

globalThis.addEventListener("message", async (event) => {
  console.log("[Worker] Received message:", event.data);
  if (event.data.ctx) {
    ctx = event.data.ctx;

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
    wasi_refs[0] = wasi_ref;
    if (wasi_refs.every((ref) => ref !== undefined)) {
      util_worker_ref = setup_util_worker(wasi_refs, ctx);
    }
  } else if (util_worker_ref) {
    console.log("[Worker] Forwarding message to util_worker");
    // Forward the message and transfer any transferable objects
    if (event.ports && event.ports.length > 0) {
      util_worker_ref.postMessage(event.data, [...event.ports]);
    } else {
      util_worker_ref.postMessage(event.data);
    }
  }
});

import util_cmd_worker from "./util_cmd?worker";

const setup_util_worker = (
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  wasi_refs: any[],
  ctx: Ctx,
) => {
  const util_worker = new util_cmd_worker();

  util_worker.postMessage({
    wasi_refs,
    ctx,
  });
  return util_worker;
};
