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
import InterruptWorker from "./interrupt_worker.ts?worker";

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
    (string: string) => Promise<void>
  >();
  const waiter = new SharedObjectRef(ctx.waiter_id).proxy<{
    set_end_of_exec: (_end_of_exec: boolean) => Promise<void>;
  }>();
  const download_by_url = new SharedObjectRef(ctx.download_by_url_id).proxy<
    (url: string, name: string) => Promise<void>
  >();

  const vfs_wasm_path = new URL("./vfs_bindings/vfs.core.wasm", import.meta.url).href;
  const vfs_wasm = await fetch(vfs_wasm_path).then(WebAssembly.compileStreaming);

  const animal = new WASIFarmAnimal(
    wasi_refs,
    [], // args
    [], // env
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
    {
      'hello:host/bridge': {
        'Downloader': {
          'download-file-chunk': {
            default: async (...args: unknown[]) => {
              animal.call_unknown_fn(0, {
                name: "download-file-chunk",
                args,
              })
            }
          },
          'download-file-end': {
            default: async (...args: unknown[]) => {
              animal.call_unknown_fn(0, {
                name: "download-file-end",
                args,
              })
            }
          },
          'download-file-start': {
            default: async (...args: unknown[]) => {
              animal.call_unknown_fn(0, {
                name: "download-file-start",
                args,
              })
            }
          },
        },
      },
    },
  );

  console.log("vfs component instantiated", vfs_root);

  // Initialize VFS component (runs its main function which sets up thread pool etc.)
  animal.start(vfs_root as any);

  const interrupt_worker = new InterruptWorker();
  interrupt_worker.postMessage({
    vfs_wasm,
    memory: animal.get_share_memory(),
    interrupt_id: ctx.interrupt_id,
    wasi_refs,
  });

  // Keep other shared objects for backward compatibility if needed
  shared.push(
    new SharedObject((c: number) => {
      (async () => {
        try {
          vfs_root.inputChar(c);
        } catch (e) {
          await terminal(`Error: ${e}\r\n`);
        }
      })();
    }, ctx.input_char_id),
  );

  shared.push(
    new SharedObject((cols: number, rows: number) => {
      (async () => {
        try {
          vfs_root.resize(cols, rows);
        } catch (e) {
          await terminal(`Error: ${e}\r\n`);
        }
      })();
    }, ctx.resize_id),
  );
});
