import { SharedObject } from "@oligami/shared-object";
import { custom_instantiate } from "./vfs_bindings/inst";
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";

const shared: SharedObject[] = [];

globalThis.addEventListener("message", async (event) => {
  const {
    vfs_wasm,
    memory,
    interrupt_id,
    wasi_refs,
  }: {
    vfs_wasm: WebAssembly.Module;
    memory: WebAssembly.Memory;
    interrupt_id: string;
    wasi_refs: any[];
  } = event.data;

  const animal = new WASIFarmAnimal(
    wasi_refs,
    [],
    [],
    {
      can_thread_spawn: false,
      share_memory: {
        memory,
      },
    }
  );

  const dummy_wasi_thread_import = new Proxy({}, {
    get: () => () => { throw new Error("Thread spawning is disabled in interrupt worker"); }
  });

  const vfs_root = await custom_instantiate(
    vfs_wasm,
    animal.wasiImport as any,
    dummy_wasi_thread_import as any,
    memory as any,
  );

  /// TODO!(); The library should provide a function specifically for this purpose
  /// @ts-ignore
  animal.inst = vfs_root;

  shared.push(
    new SharedObject(() => {
      (async () => {
        try {
          console.log("animal.wasiImport", animal.wasiImport);
          console.log("Interrupt worker: Calling interrupt...", vfs_root);
          if (vfs_root.interrupt) {
            vfs_root.interrupt();
            console.log("Interrupt worker: Interrupt called successfully");
          } else {
            console.error("vfs_root.interrupt is not defined");
          }
        } catch (e) {
          console.error("Error calling interrupt:", e);
        }
      })();
    }, interrupt_id),
  );
});
