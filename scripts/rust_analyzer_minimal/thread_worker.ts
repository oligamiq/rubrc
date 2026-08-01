import {
  thread_spawn_on_worker,
  type WASIFarmAnimal,
} from "@oligami/browser_wasi_shim-threads";
import { createHostRunCargoImport } from "./host_run_cargo.ts";
import { createLspStdinFdRead } from "./lsp_stdin.ts";

let animal: WASIFarmAnimal | undefined;

globalThis.onmessage = async (event) => {
  await thread_spawn_on_worker(
    event.data,
    async (wasmModule, imports) => {
      if (!animal) throw new Error("thread WASI animal is not initialized");
      const originalFdRead = imports.wasi_snapshot_preview1.fd_read;
      const wasiImport = {
        ...imports.wasi_snapshot_preview1,
        fd_read: createLspStdinFdRead(
          imports.env.memory,
          originalFdRead,
          (maxLength) =>
            animal!.call_unknown_fn(0, {
              name: "lspStdinRead",
              args: { maxLength },
            }),
        ),
      };
      const hostRunCargo = createHostRunCargoImport(
        imports.env.memory,
        (request) =>
          animal!.call_unknown_fn(0, { type: "host_run_cargo", request }),
      );
      const instance = await WebAssembly.instantiate(wasmModule, {
        ...imports,
        wasi_snapshot_preview1: wasiImport,
        "__wasip1_vfs-host": {
          host_run_cargo: hostRunCargo,
          host_free_memory: (_ptr: number, _len: number) => {},
        },
      });
      return instance;
    },
    (newAnimal) => {
      animal = newAnimal;
    },
  );
};
