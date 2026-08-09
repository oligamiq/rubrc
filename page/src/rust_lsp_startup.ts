export type RustLspStartupActions = {
  prepopulateMain(): Promise<void>;
  startClient(): Promise<void>;
  cancelClientStart(): void;
  createMainModel(): Promise<void> | void;
};

export async function runRustLspStartup(
  actions: RustLspStartupActions,
  timeoutMs: number,
  signal: AbortSignal,
  cancellationSettleTimeoutMs = 1_000,
): Promise<void> {
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  let timedOut = false;
  const timeoutError = new Error("rust-analyzer startup timed out");
  const startupTimeout = new Promise<never>((_, reject) => {
    startupTimer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  let startPromise: Promise<void> | undefined;
  let startupPromise: Promise<void> | undefined;

  try {
    startupPromise = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      await actions.prepopulateMain();
      if (timedOut) throw timeoutError;
      signal.throwIfAborted();
      startPromise = Promise.resolve().then(() => actions.startClient());
      void startPromise.catch(() => undefined);
      await startPromise;
      if (timedOut) throw timeoutError;
      signal.throwIfAborted();
      await actions.createMainModel();
    });
    void startupPromise.catch(() => undefined);
    await Promise.race([startupPromise, startupTimeout, aborted]);
  } catch (error) {
    const activelyCancelled =
      error === timeoutError || (signal.aborted && error === signal.reason);
    if (activelyCancelled && startPromise && startupPromise) {
      try {
        actions.cancelClientStart();
      } catch (cleanupError) {
        console.error("Failed to cancel LSP startup:", cleanupError);
      }
      await Promise.race([
        startupPromise.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(resolve, cancellationSettleTimeoutMs);
        }),
      ]);
    }
    throw error;
  } finally {
    if (startupTimer !== undefined) clearTimeout(startupTimer);
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    removeAbortListener();
  }
}
