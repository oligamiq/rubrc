import { waitForRustSrcBootstrap } from "./vfs_readiness.ts";

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

Deno.test("rust-src bootstrap dispatches once and settles ready", async () => {
  const states = [0, 1, 2];
  const calls: string[] = [];
  const result = await waitForRustSrcBootstrap({
    dispatch(session, event, arg1, arg2) {
      calls.push(`${session}:${event}:${arg1}:${arg2}`);
    },
    rustSrcLoadState() {
      return states.shift() ?? 2;
    },
  }, async () => {});
  assert(result.ok, "ready result failed");
  assert(calls.join(",") === "0:8:0:0", "bootstrap dispatched incorrectly");
});

Deno.test("rust-src bootstrap settles failed", async () => {
  const result = await waitForRustSrcBootstrap({
    dispatch() {},
    rustSrcLoadState: () => 3,
  }, async () => {});
  assert(
    "error" in result && result.error.includes("core/src/lib.rs"),
    "wrong failure",
  );
});

Deno.test("rust-src bootstrap rejects an invalid guest state", async () => {
  const result = await waitForRustSrcBootstrap({
    dispatch() {},
    rustSrcLoadState: () => 99,
  }, async () => {});
  assert(
    "error" in result && result.error.includes("99"),
    "invalid state accepted",
  );
});
