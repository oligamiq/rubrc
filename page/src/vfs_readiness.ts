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

const BOOTSTRAP_EVENT = 8;

export async function waitForRustSrcBootstrap(
  root: BootstrapRoot,
  sleep: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 50)),
): Promise<VfsReadyResult> {
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
    await sleep();
  }
}
