import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { get_rustc_wasm } from "../../lib/src/get_rustc_wasm";
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx";

let terminal: (string) => void;
let compiler: WebAssembly.Module;
const wasi_refs = [];
let ctx: Ctx;
let rustc_shared: SharedObject;

globalThis.addEventListener('message', async (event) => {
  if (event.data.ctx) {
    ctx = event.data.ctx;
    terminal = new SharedObjectRef(ctx.terminal_id).proxy<(string) => void>();
    terminal("loading rustc\r\n");
    compiler = await get_rustc_wasm();
  } else if (event.data.wasi_ref) {
    const { wasi_ref } = event.data;

    wasi_refs.push(wasi_ref);

    // wait for the compiler to load
    while (!compiler) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    terminal("loaded rustc\r\n");

    while (wasi_refs.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    terminal("loaded wasi\r\n");

    const wasi = new WASIFarmAnimal(
      wasi_refs,
      [], // args
      ["RUST_MIN_STACK=16777216"], // env
      {
        // debug: true,
        can_thread_spawn: true,
        thread_spawn_worker_url: new URL("./thread_spawn.ts", import.meta.url)
          .href,
        // thread_spawn_worker_url: "./thread_spawn.ts",
        thread_spawn_wasm: compiler,
      },
    );

    await wasi.wait_worker_background_worker();

    wasi.get_share_memory().grow(200);

    rustc_shared = new SharedObject((...args) => {
      wasi.args = ["rustc", ...args];
      wasi.block_start_on_thread();
      console.log("wasi.start done");
    }, ctx.rustc_id);
  } else if (event.data.wasi_ref_ui) {
    wasi_refs.push(event.data.wasi_ref_ui);
  }
});
