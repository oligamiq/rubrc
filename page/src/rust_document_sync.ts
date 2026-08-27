import type { TextDocument } from "vscode";
import type { TextDocumentSynchronizationMiddleware } from "vscode-languageclient/browser.js";

export type VfsWriter = (path: string, content: string) => Promise<void>;
export type TimerScheduler = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

type Snapshot = { uri: string; path: string; content: string };
type PendingSnapshot = Snapshot & { handle: unknown };
type WriteFailure = { error: unknown; snapshot: Snapshot };
type DidOpenWaiter = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

const defaultScheduler: TimerScheduler = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as number),
};

export class RustDocumentSync {
  readonly middleware: TextDocumentSynchronizationMiddleware;
  private readonly debounceMs: number;
  private readonly scheduler: TimerScheduler;
  private readonly logger: (message: string, error: unknown) => void;
  private readonly onDidOpenComplete?: (uri: string) => void;
  private readonly onDocumentChanged?: (version: number) => void;
  private readonly pending = new Map<string, PendingSnapshot>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly writeFailures = new Map<string, WriteFailure>();
  private readonly didOpenWaiters = new Map<string, DidOpenWaiter>();
  private readonly didCloseWaiters = new Map<string, DidOpenWaiter>();
  private readonly didOpenInFlight = new Map<string, Promise<void>>();
  private readonly strictDidOpen = new Set<string>();
  private disposed = false;

  constructor(
    private readonly write: VfsWriter,
    options: {
      debounceMs?: number;
      scheduler?: TimerScheduler;
      logger?: (message: string, error: unknown) => void;
      onDidOpenComplete?: (uri: string) => void;
      onDocumentChanged?: (version: number) => void;
    } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.logger = options.logger ??
      ((message, error) => console.error(message, error));
    this.onDidOpenComplete = options.onDidOpenComplete;
    this.onDocumentChanged = options.onDocumentChanged;
    this.middleware = {
      didOpen: (document, next) => {
        const uri = document.uri.toString();
        const snapshot = this.snapshot(document);
        const strictVfs = this.strictDidOpen.delete(uri);
        let didOpen: Promise<void>;
        didOpen = (async () => {
          try {
            if (snapshot) await this.queueWrite(snapshot, strictVfs);
            await next(document);
            this.onDidOpenComplete?.(uri);
          } catch (error) {
            this.rejectDidOpen(uri, error);
            throw error;
          }
          this.resolveDidOpen(uri);
        })().finally(() => {
          if (this.didOpenInFlight.get(uri) === didOpen) {
            this.didOpenInFlight.delete(uri);
          }
        });
        this.didOpenInFlight.set(uri, didOpen);
        return didOpen;
      },
      didChange: async (event, next) => {
        const snapshot = this.snapshot(event.document);
        if (snapshot) {
          this.onDocumentChanged?.(event.document.version);
          this.schedule(snapshot);
          await this.didOpenInFlight.get(snapshot.uri);
        }
        await next(event);
      },
      didClose: async (document, next) => {
        const uri = document.uri.toString();
        try {
          await this.didOpenInFlight.get(uri);
          await this.flushDocument(document);
          await next(document);
          this.resolveDidClose(uri);
        } catch (error) {
          this.rejectDidClose(uri, error);
          throw error;
        }
      },
    };
  }

  waitForDidOpen(uri: string): Promise<void> {
    const existing = this.didOpenWaiters.get(uri);
    if (existing) return existing.promise;

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    this.didOpenWaiters.set(uri, { promise, resolve, reject });
    return promise;
  }

  waitForStrictDidOpen(uri: string): Promise<void> {
    this.strictDidOpen.add(uri);
    return this.waitForDidOpen(uri);
  }

  waitForDidClose(uri: string): Promise<void> {
    const existing = this.didCloseWaiters.get(uri);
    if (existing) return existing.promise;

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    this.didCloseWaiters.set(uri, { promise, resolve, reject });
    return promise;
  }

  async flush(): Promise<void> {
    let retryFailedWrites = true;
    for (;;) {
      const snapshots = new Map<string, Snapshot>();
      if (retryFailedWrites) {
        retryFailedWrites = false;
        for (const failure of this.writeFailures.values()) {
          snapshots.set(failure.snapshot.uri, failure.snapshot);
        }
      }
      for (const pending of this.pending.values()) {
        this.scheduler.clear(pending.handle);
        snapshots.set(pending.uri, pending);
      }
      this.pending.clear();
      for (const snapshot of snapshots.values()) {
        this.queueWrite(snapshot);
      }
      await Promise.all([...this.writes.values()]);
      if (this.pending.size === 0 && this.writes.size === 0) break;
    }
    const failures = [...this.writeFailures.values()].map(({ error }) => error);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "workspace VFS writes failed");
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const disposalError = new Error("Rust document sync is disposed");
    this.rejectWaiters(disposalError);
    this.strictDidOpen.clear();
    await this.flush().catch(() => {});
    await Promise.allSettled([...this.didOpenInFlight.values()]);
  }

  abort(
    reason: unknown = new DOMException(
      "Rust document sync aborted",
      "AbortError",
    ),
  ): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const snapshot of this.pending.values()) {
      this.scheduler.clear(snapshot.handle);
    }
    this.pending.clear();
    this.rejectWaiters(reason);
    this.strictDidOpen.clear();
    this.didOpenInFlight.clear();
  }

  private rejectWaiters(error: unknown): void {
    for (const [uri, waiter] of this.didOpenWaiters) {
      this.didOpenWaiters.delete(uri);
      waiter.reject(error);
    }
    for (const [uri, waiter] of this.didCloseWaiters) {
      this.didCloseWaiters.delete(uri);
      waiter.reject(error);
    }
  }

  private resolveDidOpen(uri: string): void {
    const waiter = this.didOpenWaiters.get(uri);
    if (!waiter) return;
    this.didOpenWaiters.delete(uri);
    waiter.resolve();
  }

  private rejectDidOpen(uri: string, error: unknown): void {
    const waiter = this.didOpenWaiters.get(uri);
    if (!waiter) return;
    this.didOpenWaiters.delete(uri);
    waiter.reject(error);
  }

  private resolveDidClose(uri: string): void {
    const waiter = this.didCloseWaiters.get(uri);
    if (!waiter) return;
    this.didCloseWaiters.delete(uri);
    waiter.resolve();
  }

  private rejectDidClose(uri: string, error: unknown): void {
    const waiter = this.didCloseWaiters.get(uri);
    if (!waiter) return;
    this.didCloseWaiters.delete(uri);
    waiter.reject(error);
  }

  private snapshot(document: TextDocument): Snapshot | undefined {
    const { uri } = document;
    if (
      document.languageId !== "rust" ||
      uri.scheme !== "file" ||
      uri.authority !== "" ||
      !uri.path.startsWith("/")
    ) {
      return undefined;
    }
    return { uri: uri.toString(), path: uri.path, content: document.getText() };
  }

  private schedule(snapshot: Snapshot): void {
    if (this.disposed) return;
    const previous = this.pending.get(snapshot.uri);
    if (previous) this.scheduler.clear(previous.handle);
    let handle: unknown;
    handle = this.scheduler.set(() => {
      const current = this.pending.get(snapshot.uri);
      if (!current || current.handle !== handle) return;
      this.pending.delete(snapshot.uri);
      void this.queueWrite(current);
    }, this.debounceMs);
    this.pending.set(snapshot.uri, { ...snapshot, handle });
  }

  private async flushDocument(document: TextDocument): Promise<void> {
    const snapshot = this.snapshot(document);
    if (!snapshot) return;
    const pending = this.pending.get(snapshot.uri);
    if (pending) {
      this.scheduler.clear(pending.handle);
      this.pending.delete(snapshot.uri);
      await this.queueWrite(snapshot);
    } else {
      await this.writes.get(snapshot.uri);
    }
  }

  private queueWrite(snapshot: Snapshot, strict = false): Promise<void> {
    const previous = this.writes.get(snapshot.uri)?.catch(() => undefined) ??
      Promise.resolve();
    let current: Promise<void>;
    current = previous
      .then(async () => {
        try {
          await this.write(snapshot.path, snapshot.content);
          this.writeFailures.delete(snapshot.uri);
        } catch (error) {
          this.writeFailures.set(snapshot.uri, { error, snapshot });
          this.logger(`failed to mirror ${snapshot.path}`, error);
          if (strict) throw error;
        }
      })
      .finally(() => {
        if (this.writes.get(snapshot.uri) === current) {
          this.writes.delete(snapshot.uri);
        }
      });
    this.writes.set(snapshot.uri, current);
    return current;
  }
}
