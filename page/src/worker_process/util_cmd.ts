import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { wasi } from "@bjorn3/browser_wasi_shim";
import type { Ctx } from "../ctx";
import { get_data } from "../cat";
import { write_data } from "../write_data";
import { custom_instantiate } from "./vfs_bindings/inst";
import { set_fake_worker } from "./vfs_bindings/common";

import thread_spawn_path from "./vfs_bindings/thread_spawn.ts?worker&url";
import worker_background_worker_url from "./vfs_bindings/worker_background_worker.ts?worker&url";

await set_fake_worker();

const shared: SharedObject[] = [];

globalThis.addEventListener("message", async (event) => {
  const {
    wasi_refs,
    ctx,
  }: {
    wasi_refs: any[];
    ctx: Ctx;
  } = event.data;

  console.log("loading virtualized vfs component");

  const terminal = new SharedObjectRef(ctx.terminal_id).proxy<
    (session_id: number, data: Uint8Array) => Promise<void>
  >();
  const waiter = new SharedObjectRef(ctx.waiter_id).proxy<{
    set_end_of_exec: (_end_of_exec: boolean) => Promise<void>;
  }>();
  const download_by_url = new SharedObjectRef(ctx.download_by_url_id).proxy<
    (url: string, name: string) => Promise<void>
  >();

  const vfs_wasm_path = new URL("./vfs_bindings/vfs.core.wasm", import.meta.url).href;
  const vfs_wasm = await fetch(vfs_wasm_path).then(WebAssembly.compileStreaming);

  const vfs_threads = Math.max(4, Math.floor(navigator.hardwareConcurrency / 2) - 3);
  const animal = new WASIFarmAnimal(
    wasi_refs,
    [], // args
    [`VFS_THREADS=${vfs_threads}`], // env
    {
      can_thread_spawn: true,
      thread_spawn_worker_url: new URL(thread_spawn_path, import.meta.url).href,
      thread_spawn_wasm: vfs_wasm,
      worker_background_worker_url: new URL(worker_background_worker_url, import.meta.url).href,
      share_memory: {
        memory: new WebAssembly.Memory({
          initial: 83,
          maximum: 32775,
          shared: true,
        }),
      },
    }
  );

  await animal.wait_worker_background_worker();

  const vfs_root = await custom_instantiate(
    vfs_wasm,
    animal.wasiImport as any,
    animal.wasiThreadImport as any,
    animal.get_share_memory(),
    (idx, unknown: any) => {
      if (unknown.name === "terminalWrite") {
        terminal(unknown.args.session_id, unknown.args.data);
      } else {
        animal.call_unknown_fn(idx, unknown);
      }
    },
  );

  console.log("vfs component instantiated", vfs_root);

  // Initialize VFS component (runs its main function which sets up thread pool etc.)
  animal.start(vfs_root as any);

  // Initialize main session
  vfs_root.dispatch(0, 3, 0, 0);

  const get_terminal_size = new SharedObjectRef(ctx.get_terminal_size_id).proxy<
    () => Promise<{ cols: number; rows: number }>
  >();
  const { cols, rows } = await get_terminal_size();
  vfs_root.dispatch(0, 1, cols, rows);

  shared.push(
    new SharedObject(({ sessionId }: { sessionId: number }) => {
      vfs_root.dispatch(sessionId, 3, 0, 0);
    }, ctx.create_session_id),
  );

  shared.push(
    new SharedObject(({ sessionId, c }: { sessionId: number, c: number }) => {
      (async () => {
        try {
          vfs_root.dispatch(sessionId, 0, c, 0);
        } catch (e) {
          await terminal(sessionId, new TextEncoder().encode(`Error: ${e}\r\n`));
        }
      })();
    }, ctx.input_char_id),
  );

  shared.push(
    new SharedObject(({ sessionId, data }: { sessionId: number, data: string }) => {
      (async () => {
        try {
          const bytes = new TextEncoder().encode(data);
          const ptr = vfs_root.allocBuf(bytes.length);
          const view = new Uint8Array(animal.get_share_memory().memory.buffer);
          view.set(bytes, ptr);
          vfs_root.dispatch(sessionId, 4, ptr, bytes.length);
          vfs_root.freeBuf(ptr, bytes.length);
        } catch (e) {
          await terminal(sessionId, new TextEncoder().encode(`Error: ${e}\r\n`));
        }
      })();
    }, ctx.input_string_id),
  );

  shared.push(
    new SharedObject(({ sessionId }: { sessionId: number }) => {
      vfs_root.dispatch(sessionId, 2, 0, 0);
    }, ctx.interrupt_id),
  );

  shared.push(
    new SharedObject(({ sessionId, cols, rows }: { sessionId: number, cols: number, rows: number }) => {
      (async () => {
        try {
          vfs_root.dispatch(sessionId, 1, cols, rows);
        } catch (e) {
          await terminal(sessionId, new TextEncoder().encode(`Error: ${e}\r\n`));
        }
      })();
    }, ctx.resize_id),
  );
});
