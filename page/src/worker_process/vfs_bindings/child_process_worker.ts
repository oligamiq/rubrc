import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";

interface ChildProcessWorkerInput {
  module: ArrayBuffer;
  wasiRef: ConstructorParameters<typeof WASIFarmAnimal>[0];
  args: string[];
  env: string[];
}

globalThis.onmessage = async (event: MessageEvent<ChildProcessWorkerInput>) => {
  try {
    const { module, wasiRef, args, env } = event.data;
    const animal = new WASIFarmAnimal(wasiRef, args, env);
    const { instance } = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: animal.wasiImport,
    });
    const status = animal.start(
      instance as WebAssembly.Instance & {
        exports: { memory: WebAssembly.Memory; _start(): unknown };
      },
    );
    globalThis.postMessage({ status, graceful: true });
  } catch (error) {
    globalThis.postMessage({
      status: 126,
      error: String(error),
      graceful: false,
    });
  }
};
