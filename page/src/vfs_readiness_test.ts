import {
  RUST_SRC_BOOTSTRAP_TIMEOUT_MS,
  waitForRustSrcBootstrap,
} from "./vfs_readiness.ts";

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

Deno.test("rust-src bootstrap default timeout is 300 seconds", () => {
  assert(
    Number(RUST_SRC_BOOTSTRAP_TIMEOUT_MS) === 300_000,
    `wrong default timeout: ${RUST_SRC_BOOTSTRAP_TIMEOUT_MS}`,
  );
});

Deno.test("rust-src bootstrap dispatches once and settles ready", async () => {
  const states = [0, 1, 2];
  const calls: string[] = [];
  const result = await waitForRustSrcBootstrap(
    {
      dispatch(session, event, arg1, arg2) {
        calls.push(`${session}:${event}:${arg1}:${arg2}`);
      },
      rustSrcLoadState() {
        return states.shift() ?? 2;
      },
    },
    { sleep: async () => {} },
  );
  assert(result.ok, "ready result failed");
  assert(calls.join(",") === "0:8:0:0", "bootstrap dispatched incorrectly");
});

Deno.test("rust-src bootstrap settles failed", async () => {
  const result = await waitForRustSrcBootstrap(
    {
      dispatch() {},
      rustSrcLoadState: () => 3,
    },
    { sleep: async () => {} },
  );
  assert(
    "error" in result && result.error.includes("core/src/lib.rs"),
    "wrong failure",
  );
});

Deno.test("rust-src bootstrap rejects an invalid guest state", async () => {
  const result = await waitForRustSrcBootstrap(
    {
      dispatch() {},
      rustSrcLoadState: () => 99,
    },
    { sleep: async () => {} },
  );
  assert(
    "error" in result && result.error.includes("99"),
    "invalid state accepted",
  );
});

Deno.test("rust-src bootstrap Loading state times out once", async () => {
  let now = 0;
  let dispatches = 0;
  let reads = 0;
  let state = 1;
  const result = await waitForRustSrcBootstrap(
    {
      dispatch() {
        dispatches++;
      },
      rustSrcLoadState() {
        reads++;
        return state;
      },
    },
    {
      timeoutMs: 100,
      now: () => now,
      sleep: async () => {
        now += 25;
      },
    },
  );
  assert(
    "error" in result &&
      result.error ===
        "rust-src bootstrap timed out after 100ms while guest state remained Loading",
    `wrong timeout result: ${JSON.stringify(result)}`,
  );
  const readsAtSettlement = reads;
  state = 2;
  await Promise.resolve();
  assert(dispatches === 1, `bootstrap dispatched ${dispatches} times`);
  assert(reads === readsAtSettlement, "waiter polled after timeout settlement");
});
