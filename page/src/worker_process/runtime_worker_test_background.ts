import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";

let owner: WASIFarmAnimal | undefined;
globalThis.addEventListener("message", async (event) => {
  try {
    if (event.data.type === "create") {
      const module = new WebAssembly.Module(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      );
      owner = new WASIFarmAnimal(event.data.farmRef, [], [], {
        can_thread_spawn: true,
        thread_spawn_worker_url: "",
        thread_spawn_wasm: module,
        share_memory: {},
      });
      await owner.wait_worker_background_worker();
      globalThis.postMessage({ handle: owner.create_destroyer().get_object() });
    } else if (event.data.type === "finish" && owner) {
      await owner.async_destroy();
      globalThis.postMessage({ type: "finished" });
    } else {
      throw new Error("invalid owner fixture command");
    }
  } catch (error) {
    globalThis.postMessage({ type: "fixture-error", message: String(error) });
  }
});
globalThis.postMessage({ type: "fixture-ready", worker: "background" });
