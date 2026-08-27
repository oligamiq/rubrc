import type { RuntimeOperationOwnerAdopter } from "./app_runtime.ts";
import { closeUnderlyingChannel } from "./shared_object_channel.ts";

export async function disposeRustLspResources(
  sync: { abort?(reason?: unknown): void; dispose(): Promise<void> } | undefined,
  client: { needsStop(): boolean; stop(): Promise<void> } | undefined,
  connection: { dispose(): void } | undefined,
  vfsSharedRef: unknown | undefined,
  progressDisposable?: { dispose(): void },
  testApiDisposable?: { dispose(): void },
  readiness?: { dispose(): void },
  modelListener?: { dispose(): void },
  stopClient: boolean | (() => boolean) = true,
): Promise<void> {
  const errors: unknown[] = [];

  try {
    testApiDisposable?.dispose();
  } catch (e) {
    errors.push(e);
  }

  try {
    progressDisposable?.dispose();
  } catch (e) {
    errors.push(e);
  }

  try {
    modelListener?.dispose();
  } catch (e) {
    errors.push(e);
  }

  try {
    readiness?.dispose();
  } catch (e) {
    errors.push(e);
  }

  try {
    if (sync) await sync.dispose();
  } catch (e) {
    errors.push(e);
  }

  try {
    const shouldStopClient =
      typeof stopClient === "function" ? stopClient() : stopClient;
    if (shouldStopClient && client?.needsStop()) await client.stop();
  } catch (e) {
    errors.push(e);
  }

  try {
    connection?.dispose();
  } catch (e) {
    errors.push(e);
  }

  try {
    if (vfsSharedRef) closeUnderlyingChannel(vfsSharedRef);
  } catch (e) {
    errors.push(e);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "LSP resource cleanup failed");
  }
}

export class RustLspResourceOwner {
  readonly settlementLabel = "rust-lsp";
  private sync:
    | { abort?(reason?: unknown): void; dispose(): Promise<void> }
    | undefined;
  private client: { needsStop(): boolean; stop(): Promise<void> } | undefined;
  private connection: { dispose(): void } | undefined;
  private vfsSharedRef: unknown | undefined;
  private progressDisposable: { dispose(): void } | undefined;
  private testApiDisposable: { dispose(): void } | undefined;
  private readiness: { dispose(): void } | undefined;
  private modelListener: { dispose(): void } | undefined;

  private disposePromise: Promise<void> | undefined;
  private disposalReason: unknown;
  private transportAborted = false;
  private readonly lateCleanups: Promise<void>[] = [];

  constructor(adopter?: RuntimeOperationOwnerAdopter) {
    adopter?.adoptOperationOwner(this);
  }

  setSync(s: { abort?(reason?: unknown): void; dispose(): Promise<void> }) {
    this.setOrRelease(
      () => {
        this.sync = s;
      },
      () => s.dispose(),
    );
  }
  setClient(c: { needsStop(): boolean; stop(): Promise<void> }) {
    this.setOrRelease(
      () => {
        this.client = c;
      },
      () => (!this.transportAborted && c.needsStop() ? c.stop() : undefined),
    );
  }
  setConnection(c: { dispose(): void }) {
    this.setOrRelease(
      () => {
        this.connection = c;
      },
      () => c.dispose(),
    );
  }
  setVfsSharedRef(r: unknown) {
    this.setOrRelease(
      () => {
        this.vfsSharedRef = r;
      },
      () => closeUnderlyingChannel(r),
    );
  }
  setProgressDisposable(disposable: { dispose(): void }) {
    this.setOrRelease(
      () => {
        this.progressDisposable = disposable;
      },
      () => disposable.dispose(),
    );
  }
  setTestApiDisposable(disposable: { dispose(): void }) {
    this.setOrRelease(
      () => {
        this.testApiDisposable = disposable;
      },
      () => disposable.dispose(),
    );
  }
  setReadiness(readiness: { dispose(): void }) {
    this.setOrRelease(
      () => {
        this.readiness = readiness;
      },
      () => readiness.dispose(),
    );
  }
  setModelListener(listener: { dispose(): void }) {
    this.setOrRelease(
      () => {
        this.modelListener = listener;
      },
      () => listener.dispose(),
    );
  }
  abort(reason?: unknown): void {
    this.disposalReason ??=
      reason ?? new DOMException("Rust LSP resources aborted", "AbortError");
    const firstAbort = !this.transportAborted;
    this.transportAborted = true;
    const connection = this.connection;
    this.connection = undefined;
    connection?.dispose();
    if (firstAbort) this.sync?.abort?.(this.disposalReason);
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposalReason ??= new DOMException(
      "Rust LSP resources disposed",
      "AbortError",
    );
    let resolveDisposal!: () => void;
    let rejectDisposal!: (reason: unknown) => void;
    this.disposePromise = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    void this.disposePromise.catch(() => undefined);
    const connection = this.connection;
    let guardedConnection: { dispose(): void } | undefined;
    if (connection !== undefined) {
      let disposed = false;
      guardedConnection = {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          if (this.connection === guardedConnection)
            this.connection = undefined;
          connection.dispose();
        },
      };
      this.connection = guardedConnection;
    }
    const disposal = this.drainDisposal(
      disposeRustLspResources(
        this.sync,
        this.client,
        guardedConnection,
        this.vfsSharedRef,
        this.progressDisposable,
        this.testApiDisposable,
        this.readiness,
        this.modelListener,
        () => !this.transportAborted,
      ),
    );
    this.sync = undefined;
    this.client = undefined;
    this.vfsSharedRef = undefined;
    this.progressDisposable = undefined;
    this.testApiDisposable = undefined;
    this.readiness = undefined;
    this.modelListener = undefined;
    disposal.then(resolveDisposal, rejectDisposal);
    return this.disposePromise;
  }

  private async drainDisposal(initialDisposal: Promise<void>): Promise<void> {
    let initialError: unknown;
    const lateErrors: unknown[] = [];
    try {
      await initialDisposal;
    } catch (error) {
      initialError = error;
    }
    let drained = 0;
    while (drained < this.lateCleanups.length) {
      const batch = this.lateCleanups.slice(drained);
      drained = this.lateCleanups.length;
      const results = await Promise.allSettled(batch);
      for (const result of results) {
        if (result.status === "rejected") lateErrors.push(result.reason);
      }
    }
    if (initialError !== undefined && lateErrors.length === 0) {
      throw initialError;
    }
    if (initialError !== undefined) lateErrors.unshift(initialError);
    if (lateErrors.length > 0) {
      throw new AggregateError(lateErrors, "LSP resource cleanup failed");
    }
  }

  private setOrRelease(
    set: () => void,
    release: () => void | Promise<void>,
  ): void {
    if (this.disposalReason === undefined) {
      set();
      return;
    }
    try {
      const cleanup = release();
      if (cleanup !== undefined) {
        const observed = Promise.resolve(cleanup);
        this.lateCleanups.push(observed);
        void observed.catch(() => undefined);
      }
    } catch (error) {
      const observed = Promise.reject(error);
      this.lateCleanups.push(observed);
      void observed.catch(() => undefined);
    }
    throw this.disposalReason;
  }
}
