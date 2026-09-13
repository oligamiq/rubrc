import { expect, test } from "bun:test";
import { DestroyerHandle } from "@oligami/browser_wasi_shim-threads";
import { createPublicOwner } from "./browser_wasi_shim_test_owner.ts";

function request(
  worker: Worker,
  object: unknown,
  mode: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = reject;
    worker.postMessage({ object, mode });
  });
}

test(
  "public destroyer survives a real structured clone into another worker",
  async () => {
    const owner = await createPublicOwner();
    const worker = new Worker(
      new URL("./browser_wasi_shim_public_dist_worker.ts", import.meta.url)
        .href,
    );
    try {
      await owner.ready;
      expect(await request(worker, owner.object, "reconstruct"))
        .toEqual({ reconstructed: true });
    } finally {
      worker.terminate();
      await owner.dispose();
    }
  },
  10_000,
);

test(
  "concurrent public clones and the owner await the same teardown",
  async () => {
    const owner = await createPublicOwner();
    const workers = [0, 1].map(() =>
      new Worker(
        new URL("./browser_wasi_shim_public_dist_worker.ts", import.meta.url)
          .href,
      )
    );
    try {
      await owner.ready;
      const object = owner.object;
      expect(
        await Promise.all(
          workers.map((worker) => request(worker, object, "destroy")),
        ),
      )
        .toEqual([{ destroyed: true }, { destroyed: true }]);
      await owner.finish();
      await DestroyerHandle.init_self(structuredClone(object)).async_destroy();
    } finally {
      for (const worker of workers) worker.terminate();
      await owner.dispose();
    }
  },
  10_000,
);

test(
  "public destroy initiation can be followed by repeated async completion",
  async () => {
    const owner = await createPublicOwner();
    try {
      await owner.ready;
      const handle = DestroyerHandle.init_self(owner.object);
      handle.destroy();
      await Promise.all([
        handle.async_destroy(),
        handle.async_destroy(),
        owner.finish(),
      ]);
    } finally {
      await owner.dispose();
    }
  },
  10_000,
);
