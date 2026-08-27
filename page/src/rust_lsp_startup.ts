import { createRustAnalyzerProjectSettings } from "./rust_lsp_config.ts";

export type RustLspStartupActions = {
  prepopulateMain(): Promise<void>;
  startClient(): Promise<void>;
  cancelClientStart(): void;
};

export type RustProjectActivation<TModel> = {
  initializedModel: TModel;
  model: TModel & { getValue(): string; getVersionId(): number };
  signal: AbortSignal;
  uri: string;
  writeMain(content: string): Promise<void>;
  client: {
    sendNotification(method: string, params: unknown): Promise<void>;
    sendRequest?(method: string, params?: unknown): Promise<unknown>;
  };
  readiness: {
    waitForCrateGraph(signal: AbortSignal): Promise<void>;
    noteDocumentChanged(version: number): void;
    waitForSemanticReadiness(
      model: TModel,
      signal: AbortSignal,
    ): Promise<void>;
  };
  sync: {
    waitForDidClose(uri: string): Promise<void>;
    waitForStrictDidOpen(uri: string): Promise<void>;
  };
  setModelLanguage(model: TModel, language: string): void;
  semanticWarming(): void;
};

const awaitWithAbort = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  void operation.catch(() => undefined);
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const awaitMutationWithAbort = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  try {
    return await awaitWithAbort(operation, signal);
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      await operation.then(
        () => undefined,
        () => undefined,
      );
    }
    throw error;
  }
};

export async function activateRustProject<TModel>(
  activation: RustProjectActivation<TModel>,
): Promise<void> {
  const {
    model,
    initializedModel,
    signal,
    uri,
    writeMain,
    client,
    readiness,
    sync,
    setModelLanguage,
    semanticWarming,
  } = activation;
  if (model !== initializedModel) {
    throw new Error("Rust activation model changed after initialization");
  }
  signal.throwIfAborted();
  const content = model.getValue();
  signal.throwIfAborted();
  await awaitMutationWithAbort(
    client.sendNotification("workspace/didChangeConfiguration", {
      settings: createRustAnalyzerProjectSettings(),
    }),
    signal,
  );
  signal.throwIfAborted();
  await awaitWithAbort(readiness.waitForCrateGraph(signal), signal);
  signal.throwIfAborted();
  await awaitMutationWithAbort(writeMain(content), signal);
  signal.throwIfAborted();
  readiness.noteDocumentChanged(model.getVersionId());
  signal.throwIfAborted();
  const didClose = sync.waitForDidClose(uri);
  void didClose.catch(() => undefined);
  signal.throwIfAborted();
  setModelLanguage(model, "plaintext");
  await awaitWithAbort(didClose, signal);
  signal.throwIfAborted();
  const didOpen = sync.waitForStrictDidOpen(uri);
  void didOpen.catch(() => undefined);
  signal.throwIfAborted();
  setModelLanguage(model, "rust");
  await awaitWithAbort(didOpen, signal);
  signal.throwIfAborted();
  semanticWarming();
  signal.throwIfAborted();
  await awaitWithAbort(
    readiness.waitForSemanticReadiness(model, signal),
    signal,
  );
  signal.throwIfAborted();
}

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
    });
    void startupPromise.catch(() => undefined);
    await Promise.race([startupPromise, startupTimeout, aborted]);
  } catch (error) {
    const activelyCancelled = error === timeoutError ||
      (signal.aborted && error === signal.reason);
    if (activelyCancelled && startupPromise) {
      if (startPromise) {
        try {
          actions.cancelClientStart();
        } catch (cleanupError) {
          console.error("Failed to cancel LSP startup:", cleanupError);
        }
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
