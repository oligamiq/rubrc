import { DestroyerHandle } from "@oligami/browser_wasi_shim-threads";
import { createPublicOwner } from "./browser_wasi_shim_test_owner.ts";

async function verify() {
  for (let generation = 0; generation < 3; generation++) {
    const owner = await createPublicOwner();
    try {
      await owner.ready;
      const clones = [0, 1].map(() =>
        DestroyerHandle.init_self(structuredClone(owner.object))
      );
      await Promise.all(clones.map((handle) => handle.async_destroy()));
      await owner.finish();
    } finally {
      await owner.dispose();
    }
  }
  const failedOwner = await createPublicOwner(true);
  try {
    let rejected = false;
    await failedOwner.ready.catch(() => {
      rejected = true;
    });
    if (!rejected) throw new Error("invalid coordinator became ready");
    const outcomes = await Promise.allSettled([
      DestroyerHandle.init_self(structuredClone(failedOwner.object))
        .async_destroy(),
      failedOwner.finish(),
    ]);
    if (outcomes.some((outcome) => outcome.status !== "rejected")) {
      throw new Error(
        "coordinator bootstrap failure was reported as successful",
      );
    }
  } finally {
    await failedOwner.dispose().catch(() => {});
  }
  return { generations: 3, bootstrapFailure: "rejected" };
}

(globalThis as typeof globalThis & { lifecycleResult: Promise<unknown> })
  .lifecycleResult = verify();
