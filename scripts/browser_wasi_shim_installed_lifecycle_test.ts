import { assertEquals, assertRejects } from "jsr:@std/assert";
import { DestroyerHandle } from "@oligami/browser_wasi_shim-threads";
import { createPublicOwner } from "./browser_wasi_shim_test_owner.ts";

Deno.test("coordinator bootstrap failure rejects owner and external public handles", async () => {
  const owner = await createPublicOwner(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const clones = [0, 1].map(() =>
          DestroyerHandle.init_self(structuredClone(owner.object))
        );
        await assertRejects(() => owner.ready, Error, "CoordinatorBootstrap");
        const outcomes = await Promise.allSettled([
          owner.finish(),
          ...clones.map((handle) => handle.async_destroy()),
        ]);
        assertEquals(outcomes.map((outcome) => outcome.status), [
          "rejected",
          "rejected",
          "rejected",
        ]);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("bootstrap failure left teardown pending")),
          3_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await owner.dispose().catch(() => {});
  }
});
