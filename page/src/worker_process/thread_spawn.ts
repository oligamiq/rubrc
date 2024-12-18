import { thread_spawn_on_worker } from "@oligami/browser_wasi_shim-threads";

self.onmessage = async (event) => {
  await thread_spawn_on_worker(event.data);
};
