import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";

const shared: SharedObject[] = [];

globalThis.addEventListener("message", async (event) => {
  const {
    wasi_refs,
    ctx,
  }: {
    // WASIFarmRefObject is not export
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    wasi_refs: any[];
    ctx: Ctx;
  } = event.data;

  const waiter = new SharedObjectRef(ctx.waiter_id).proxy<{
    is_rustc_fetch_end: () => Promise<boolean>;
  }>();

  while (!(await waiter.is_rustc_fetch_end())) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log("loading llvm");

  await ready_llvm_wasm(wasi_refs, ctx);
});

import { get_llvm_wasm } from "../../lib/src/get_llvm_wasm";
import { strace } from "@bjorn3/browser_wasi_shim";
let linker: WebAssembly.Instance & {
  exports: { memory: WebAssembly.Memory; _start: () => unknown };
};
let wasi: WASIFarmAnimal;

const ready_llvm_wasm = async (
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  wasi_refs: any[],
  ctx: Ctx,
) => {
  const linker_wasm = await get_llvm_wasm();

  console.log("linker_wasm", linker_wasm);

  wasi = new WASIFarmAnimal(
    wasi_refs,
    ["llvm"], // args
    [], // env
    // {
      // debug: true,
      // can_thread_spawn: true,
      // thread_spawn_worker_url: new URL(thread_spawn_path, import.meta.url)
      //   .href,
      // thread_spawn_wasm: linker,
    // },
  );

  linker = (await WebAssembly.instantiate(linker_wasm, {
    wasi_snapshot_preview1: strace(wasi.wasiImport, []),
  })) as unknown as {
    exports: { memory: WebAssembly.Memory; _start: () => unknown };
  };

  const memory_reset = linker.exports.memory.buffer;
  const memory_reset_view = new Uint8Array(memory_reset).slice();

  shared.push(
    new SharedObject((...args) => {
      try {
        if (args[0] !== "llvm") {
          wasi.args = ["llvm", ...args];
        } else {
          wasi.args = args;
        }
        console.log(`wasi.start: ${wasi.args}`);
        console.log(wasi);
        const memory_view = new Uint8Array(linker.exports.memory.buffer);
        memory_view.set(memory_reset_view);
        wasi.start(linker);
        console.log("wasi.start done");
      } catch (e) {
        console.error(e);
      }
    }, ctx.llvm_id),
  );

  console.log("llvm loaded");
};
