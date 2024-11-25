import { SharedObject } from "@oligami/shared-object";
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";
import lsr from "./wasm/lsr.wasm?url";
import tre from "./wasm/tre.wasm?url";

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

  const ls_wasm = await WebAssembly.compile(
    await (await fetch(lsr)).arrayBuffer(),
  );

  const ls_wasi = new WASIFarmAnimal(
    wasi_refs,
    [], // args
    [], // env
  );

  const ls_inst = (await WebAssembly.instantiate(ls_wasm, {
    wasi_snapshot_preview1: ls_wasi.wasiImport,
  })) as unknown as {
    exports: { memory: WebAssembly.Memory; _start: () => unknown };
  };

  const ls_memory_reset = ls_inst.exports.memory.buffer;
  const ls_memory_reset_view = new Uint8Array(ls_memory_reset).slice();

  shared.push(
    new SharedObject((...args) => {
      // If I don't reset memory, I get some kind of error.
      const memory_view = new Uint8Array(ls_inst.exports.memory.buffer);
      memory_view.set(ls_memory_reset_view);
      ls_wasi.args = ["lsr", ...args];
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      ls_wasi.start(ls_inst as any);
    }, ctx.ls_id),
  );

  const tree_wasm = await WebAssembly.compile(
    await (await fetch(tre)).arrayBuffer(),
  );

  const tree_wasi = new WASIFarmAnimal(
    wasi_refs,
    [], // args
    [], // env
  );

  const tree_inst = (await WebAssembly.instantiate(tree_wasm, {
    wasi_snapshot_preview1: tree_wasi.wasiImport,
  })) as unknown as {
    exports: { memory: WebAssembly.Memory; _start: () => unknown };
  };

  console.log("tree_inst", tree_inst);

  const tree_memory_reset = tree_inst.exports.memory.buffer;
  const tree_memory_reset_view = new Uint8Array(tree_memory_reset).slice();

  shared.push(
    new SharedObject((...args) => {
      // If I don't reset memory, I get some kind of error.
      tree_wasi.args = ["tre", ...args];
      const memory_view = new Uint8Array(tree_inst.exports.memory.buffer);
      memory_view.set(tree_memory_reset_view);
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      tree_wasi.start(tree_inst as any);
    }, ctx.tree_id),
  );

  console.log("lsr_inst", ls_inst);

  console.log("lsr and tre loaded");
});
