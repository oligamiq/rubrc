import { DestroyerHandle } from "../node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.ts";
import { WorkerBackgroundRef } from "../node_modules/@oligami/browser_wasi_shim-threads/src/shared_array_buffer/worker_background/worker_background_ref.ts";

self.onmessage = (event: MessageEvent) => {
  const { object, syncBuffer, fail } = event.data;
  const sync = new Int32Array(syncBuffer);
  const sender = Object.create(WorkerBackgroundRef.prototype);
  sender.destroy = () => {
    Atomics.add(sync, 0, 1);
    Atomics.store(sync, 1, 1);
    Atomics.notify(sync, 1);
    Atomics.wait(sync, 2, 0, 75);
    if (fail) throw new Error("sender destroy failed");
  };
  WorkerBackgroundRef.init_self = () => sender;

  const handle = DestroyerHandle.init_self(object);
  try {
    handle.destroy();
    self.postMessage({ state: Atomics.load(new Int32Array(object.destroy_status), 1) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      state: Atomics.load(new Int32Array(object.destroy_status), 1),
    });
  }
};
