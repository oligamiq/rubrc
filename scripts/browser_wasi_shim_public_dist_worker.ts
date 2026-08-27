import { DestroyerHandle } from "@oligami/browser_wasi_shim-threads";

self.onmessage = (event: MessageEvent) => {
  const { object, mode } = event.data;
  try {
    const handle = DestroyerHandle.init_self(object);
    if (mode === "reconstruct") {
      const restored = handle.get_object();
      self.postMessage({
        allocatorShared: restored.sender.allocator.share_arrays_memory instanceof SharedArrayBuffer,
        destroyStatusShared: restored.destroy_status instanceof SharedArrayBuffer,
      });
      return;
    }

    handle.destroy();
    self.postMessage({ state: Atomics.load(new Int32Array(object.destroy_status), 1) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
