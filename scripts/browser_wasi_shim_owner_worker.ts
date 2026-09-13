import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";

let owner: WASIFarmAnimal | undefined;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "create") {
      owner = new WASIFarmAnimal(data.farmRef, [], [], {
        can_thread_spawn: true,
        thread_spawn_worker_url: "",
        share_memory: {},
        thread_spawn_wasm: new WebAssembly.Module(
          new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
        ),
        worker_background_worker_url: data.failBootstrap
          ? new URL(
            "./browser_wasi_shim_failing_coordinator.ts",
            import.meta.url,
          ).href
          : undefined,
      });
      self.postMessage({
        type: "created",
        handle: owner.create_destroyer().get_object(),
      });
      await owner.wait_worker_background_worker();
      self.postMessage({ type: "ready" });
    } else if (data.type === "finish" && owner) {
      await owner.async_destroy();
      self.postMessage({ type: "finished" });
    } else {
      throw new Error("invalid owner request");
    }
  } catch (error) {
    self.postMessage({ type: "failed", message: String(error) });
  }
};
