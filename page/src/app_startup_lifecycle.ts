export function createAdditionalTargetLoader(dependencies: {
  prefetch(triples: readonly string[], signal: AbortSignal): Promise<void>;
  load(triple: string): Promise<unknown>;
  signal: AbortSignal;
  completed?: readonly string[];
}) {
  const operations = new Map<string, Promise<void>>();
  const completed = new Set(dependencies.completed);
  let tail = Promise.resolve();

  return {
    load(triple: string): Promise<void> {
      if (completed.has(triple)) return Promise.resolve();
      const existing = operations.get(triple);
      if (existing !== undefined) return existing;
      const operation = tail
        .then(async () => {
          dependencies.signal.throwIfAborted();
          await dependencies.prefetch([triple], dependencies.signal);
          dependencies.signal.throwIfAborted();
          await dependencies.load(triple);
          completed.add(triple);
        })
        .finally(() => operations.delete(triple));
      tail = operation.catch(() => undefined);
      operations.set(triple, operation);
      return operation;
    },
    loading(): boolean {
      return operations.size > 0;
    },
    async settle(): Promise<void> {
      await tail;
    },
  };
}

export async function disposeAppStartup(dependencies: {
  disposeCoordinator(): Promise<void>;
  disposeStore(): void;
  disposeChannels(): void;
}): Promise<void> {
  try {
    await dependencies.disposeCoordinator();
  } finally {
    dependencies.disposeStore();
    dependencies.disposeChannels();
  }
}

export function retainArchiveProgress<TEvent>(
  source: { subscribe(listener: (event: TEvent) => void): () => void },
  report: (event: TEvent) => void,
): { dispose(): void } {
  const unsubscribe = source.subscribe(report);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}

export async function runAcceptedTargetExtraction(dependencies: {
  triple: string;
  endpoint(
    request: import("./vfs_readiness").AdditionalSysrootRequest,
  ): Promise<number>;
  generationSignal: AbortSignal;
  timeoutMs?: number;
  transportTimeoutMs?: number;
  onTerminalWorkerFailure?: (error: unknown) => void;
  now?: () => number;
  sleep?: () => Promise<void>;
}): Promise<void> {
  dependencies.generationSignal.throwIfAborted();
  const timeoutMs = dependencies.timeoutMs ?? 300_000;
  const transportTimeoutMs = dependencies.transportTimeoutMs ?? 5_000;
  const now = dependencies.now ?? performance.now.bind(performance);
  const sleep = dependencies.sleep ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  let requestAccepted = false;
  let workerFailureReported = false;
  const reportWorkerFailure = (error: unknown) => {
    if (workerFailureReported) return;
    workerFailureReported = true;
    dependencies.onTerminalWorkerFailure?.(error);
  };
  const raceGenerationTransport = <T>(operation: Promise<T>): Promise<T> => {
    void operation.catch(() => undefined);
    const signal = dependencies.generationSignal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  };
  const callEndpoint = async (
    request: import("./vfs_readiness").AdditionalSysrootRequest,
  ): Promise<number> => {
    dependencies.generationSignal.throwIfAborted();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        raceGenerationTransport(dependencies.endpoint(request)),
        new Promise<number>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `additional sysroot ${request.operation} transport timed out after ${transportTimeoutMs}ms`,
                ),
              ),
            transportTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (
        dependencies.generationSignal.aborted &&
        error === dependencies.generationSignal.reason
      ) {
        throw error;
      }
      if (
        requestAccepted ||
        (error instanceof Error &&
          error.message.includes("transport timed out"))
      ) {
        reportWorkerFailure(error);
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
  const requestId = await callEndpoint({
    operation: "start",
    triple: dependencies.triple,
  });
  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw new Error(`invalid additional sysroot request id: ${requestId}`);
  }
  requestAccepted = true;
  const deadline = now() + timeoutMs;
  let timeoutFailure: Error | undefined;
  let cancelRequested = false;
  while (true) {
    dependencies.generationSignal.throwIfAborted();
    if (timeoutFailure !== undefined && !cancelRequested) {
      await callEndpoint({ operation: "cancel", requestId });
      cancelRequested = true;
    }
    const state = await callEndpoint({ operation: "state", requestId });
    if (state === 2 || state === 3) {
      let failure: unknown;
      if (
        state === 3 &&
        timeoutFailure === undefined
      ) {
        const errorCode = await callEndpoint({ operation: "error", requestId });
        const detail = errorCode === 1
          ? "fetch failed"
          : errorCode === 2
          ? "extraction failed"
          : errorCode === 4
          ? "was cancelled"
          : `failed with error code ${errorCode}`;
        failure = new Error(`${dependencies.triple} ${detail}`);
      }
      const releaseResult = await callEndpoint({
        operation: "release",
        requestId,
      });
      if (releaseResult !== 1) {
        throw new Error(
          `${dependencies.triple} terminal request ${requestId} failed to release`,
        );
      }
      if (timeoutFailure !== undefined) throw timeoutFailure;
      if (failure !== undefined) throw failure;
      return;
    }
    if (state !== 0 && state !== 1) {
      throw new Error(
        `${dependencies.triple} returned invalid guest state ${state}`,
      );
    }
    if (now() >= deadline && timeoutFailure === undefined) {
      timeoutFailure = new Error(
        `${dependencies.triple} installation timed out after ${timeoutMs}ms`,
      );
    }
    await sleep();
  }
}
