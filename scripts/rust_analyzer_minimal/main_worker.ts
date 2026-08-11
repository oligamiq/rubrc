import {
  WASIFarmAnimal,
  type WASIFarmRefObject,
} from "@oligami/browser_wasi_shim-threads";
import { createHostRunCargoImport } from "./host_run_cargo.ts";
import { createLspStdinFdRead } from "./lsp_stdin.ts";

type StartMessage = {
  wasiRef: WASIFarmRefObject;
  wasmModule: WebAssembly.Module;
  memory: WebAssembly.Memory;
  threadWorkerUrl: string;
  backgroundWorkerUrl: string;
};

globalThis.onmessage = async (event: MessageEvent<StartMessage>) => {
  try {
    const {
      wasiRef,
      wasmModule,
      memory,
      threadWorkerUrl,
      backgroundWorkerUrl,
    } = event.data;
    const animal = new WASIFarmAnimal(
      wasiRef,
      ["rust-analyzer"],
      ["HOME=/"],
      {
        can_thread_spawn: true,
        thread_spawn_worker_url: threadWorkerUrl,
        thread_spawn_wasm: wasmModule,
        worker_background_worker_url: backgroundWorkerUrl,
        share_memory: { memory },
      },
    );

    await animal.wait_worker_background_worker();
    const hostRunCargo = createHostRunCargoImport(
      memory,
      (request) =>
        animal.call_unknown_fn(0, { type: "host_run_cargo", request }),
    );
    const originalFdRead = animal.wasiImport.fd_read;
    if (originalFdRead === undefined) {
      throw new Error("WASI fd_read import is missing");
    }
    const wasiImport = {
      ...animal.wasiImport,
      fd_read: createLspStdinFdRead(
        memory,
        originalFdRead,
        (maxLength) =>
          animal.call_unknown_fn(0, {
            name: "lspStdinRead",
            args: { maxLength },
          }),
      ),
    };
    const instance = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1: wasiImport,
      wasi: animal.wasiThreadImport,
      env: animal.get_share_memory(),
      "__wasip1_vfs-host": {
        host_run_cargo: hostRunCargo,
        host_free_memory: (_ptr: number, _len: number) => {},
      },
    });

    globalThis.postMessage({ type: "started" });
    const code = animal.start(
      instance as unknown as Parameters<
        WASIFarmAnimal["start"]
      >[0],
    );
    globalThis.postMessage({ type: "exit", code });
  } catch (error) {
    globalThis.postMessage({
      type: "error",
      error: error instanceof Error
        ? error.stack ?? error.message
        : String(error),
    });
  }
};
