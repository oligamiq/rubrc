export type VfsReadyResult = { ok: true } | { ok: false; error: string };

type BootstrapRoot = {
  dispatch(
    sessionId: number,
    eventType: number,
    arg1: number,
    arg2: number,
  ): void;
  rustSrcLoadState(): number;
};

export type RustSrcBootstrapTiming = {
  timeoutMs?: number;
  now?: () => number;
  sleep?: () => Promise<void>;
};

const BOOTSTRAP_EVENT = 8;
export const RUST_SRC_BOOTSTRAP_TIMEOUT_MS = 300_000;

export async function waitForRustSrcBootstrap(
  root: BootstrapRoot,
  timing: RustSrcBootstrapTiming = {},
): Promise<VfsReadyResult> {
  const timeoutMs = timing.timeoutMs ?? RUST_SRC_BOOTSTRAP_TIMEOUT_MS;
  const now = timing.now ?? performance.now.bind(performance);
  const sleep =
    timing.sleep ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  const deadline = now() + timeoutMs;
  root.dispatch(0, BOOTSTRAP_EVENT, 0, 0);
  while (true) {
    const state = root.rustSrcLoadState();
    if (state === 2) return { ok: true };
    if (state === 3) {
      return {
        ok: false,
        error:
          "rust-src bootstrap failed: missing /sysroot/lib/rustlib/src/rust/library/core/src/lib.rs",
      };
    }
    if (state !== 0 && state !== 1) {
      return {
        ok: false,
        error: `rust-src bootstrap returned invalid state ${state}`,
      };
    }
    if (now() >= deadline) {
      const stateName = state === 0 ? "NotStarted" : "Loading";
      return {
        ok: false,
        error: `rust-src bootstrap timed out after ${timeoutMs}ms while guest state remained ${stateName}`,
      };
    }
    await sleep();
  }
}
