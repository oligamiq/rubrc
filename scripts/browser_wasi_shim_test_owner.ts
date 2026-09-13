import {
  DestroyerHandle,
  type DestroyerHandleObject,
  WASIFarm,
} from "@oligami/browser_wasi_shim-threads";
import { File, OpenFile } from "@bjorn3/browser_wasi_shim";

export async function createPublicOwner(failBootstrap = false) {
  const fd = () => new OpenFile(new File([]));
  const farm = new WASIFarm(fd(), fd(), fd());
  const worker = new Worker(
    new URL("./browser_wasi_shim_owner_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const created = Promise.withResolvers<DestroyerHandleObject>();
  const ready = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  void finished.promise.catch(() => {});
  worker.onmessage = ({ data }) => {
    if (data.type === "created") created.resolve(data.handle);
    else if (data.type === "ready") ready.resolve();
    else if (data.type === "finished") finished.resolve();
    else if (data.type === "failed") {
      const error = new Error(data.message);
      created.reject(error);
      ready.reject(error);
      finished.reject(error);
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message);
    created.reject(error);
    ready.reject(error);
    finished.reject(error);
  };
  worker.postMessage({
    type: "create",
    farmRef: farm.get_ref(),
    failBootstrap,
  });
  try {
    const object = await created.promise;
    let finishing = false;
    return {
      object,
      ready: ready.promise,
      async finish() {
        if (!finishing) {
          finishing = true;
          worker.postMessage({ type: "finish" });
        }
        await finished.promise;
      },
      async dispose() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await DestroyerHandle.init_self(object).async_destroy();
              if (!finishing) {
                finishing = true;
                worker.postMessage({ type: "finish" });
              }
              await finished.promise;
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("public owner cleanup timed out")),
                2_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          worker.terminate();
          farm.destroy();
        }
      },
    };
  } catch (error) {
    worker.terminate();
    farm.destroy();
    throw error;
  }
}
