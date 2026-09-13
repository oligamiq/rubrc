import { DestroyerHandle } from "@oligami/browser_wasi_shim-threads";

self.onmessage = async (event: MessageEvent) => {
  const { object, mode } = event.data;
  try {
    const handle = DestroyerHandle.init_self(object);
    if (mode === "reconstruct") {
      const restored = handle.get_object();
      self.postMessage({
        reconstructed:
          typeof DestroyerHandle.init_self(structuredClone(restored))
            .async_destroy === "function",
      });
      return;
    }

    await handle.async_destroy();
    self.postMessage({ destroyed: true });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
