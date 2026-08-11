import type { TextDocument } from "vscode";
import type { TextDocumentSynchronizationMiddleware } from "vscode-languageclient/browser.js";

export type VfsWriter = (path: string, content: string) => Promise<void>;
export type TimerScheduler = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

type Snapshot = { uri: string; path: string; content: string };
type PendingSnapshot = Snapshot & { handle: unknown };
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
  private readonly pending = new Map<string, PendingSnapshot>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly writeFailures = new Map<string, unknown>();
  private readonly didOpenWaiters = new Map<string, DidOpenWaiter>();
  private disposed = false;

  constructor(
    private readonly write: VfsWriter,
    options: {
      debounceMs?: number;
      scheduler?: TimerScheduler;
      logger?: (message: string, error: unknown) => void;
      onDidOpenComplete?: (uri: string) => void;
    } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.logger =
      options.logger ?? ((message, error) => console.error(message, error));
    this.onDidOpenComplete = options.onDidOpenComplete;
    this.middleware = {
      didOpen: async (document, next) => {
        const uri = document.uri.toString();
        const snapshot = this.snapshot(document);
        try {
          try {
            if (snapshot) await this.queueWrite(snapshot);
          } finally {
            await next(document);
            this.onDidOpenComplete?.(uri);
          }
        } catch (error) {
          this.rejectDidOpen(uri, error);
          throw error;
        }
        this.resolveDidOpen(uri);
      },
      didChange: (event, next) => {
        const snapshot = this.snapshot(event.document);
        if (snapshot) this.schedule(snapshot);
        return next(event);
      },
      didClose: async (document, next) => {
        try {
          await this.flushDocument(document);
        } finally {
          await next(document);
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

  async flush(): Promise<void> {
    const snapshots = [...this.pending.values()];
    this.pending.clear();
    for (const snapshot of snapshots) {
      this.scheduler.clear(snapshot.handle);
      this.queueWrite(snapshot);
    }
    await Promise.all([...this.writes.values()]);
    const failures = [...this.writeFailures.values()];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "workspace VFS writes failed");
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.flush().catch(() => {});
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

  private snapshot(document: TextDocument): Snapshot | undefined {
    const { uri } = document;
    if (
      document.languageId !== "rust" ||
      uri.scheme !== "file" ||
      uri.authority !== "" ||
      !uri.path.startsWith("/")
    )
      return undefined;
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

  private queueWrite(snapshot: Snapshot): Promise<void> {
    const previous = this.writes.get(snapshot.uri) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous
      .then(async () => {
        try {
          await this.write(snapshot.path, snapshot.content);
          this.writeFailures.delete(snapshot.uri);
        } catch (error) {
          this.writeFailures.set(snapshot.uri, error);
          this.logger(`failed to mirror ${snapshot.path}`, error);
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
