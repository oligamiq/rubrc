import { waitForStartupSysroots } from "./vfs_readiness.ts";

Deno.test("sysroot readiness observations report each installed archive once", async () => {
  const states = [2, 1];
  const observed: number[] = [];
  let sleeps = 0;
  const timing = {
    onReady: (kind: number) => observed.push(kind),
    sleep: async () => { if (++sleeps === 2) states[1] = 2; },
  };
  const result = await waitForStartupSysroots({
    dispatch() {},
    startupSysrootLoadState: kind => states[kind],
    startupSysrootErrorCode: () => 0,
  }, timing);
  if (!result.ok || JSON.stringify(observed) !== "[0,1]") throw new Error(`unexpected readiness observations: ${JSON.stringify(observed)}`);
});
