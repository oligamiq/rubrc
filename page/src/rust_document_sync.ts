import type { TextDocument } from "vscode";
import type { TextDocumentSynchronizationMiddleware } from "vscode-languageclient/browser.js";

export type VfsWriter = (path: string, content: string) => Promise<void>;
export type TimerScheduler = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

type Snapshot = { uri: string; path: string; content: string };
type PendingSnapshot = Snapshot & { handle: unknown };

const defaultScheduler: TimerScheduler = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as number),
};

export class RustDocumentSync {
  readonly middleware: TextDocumentSynchronizationMiddleware;
  private readonly debounceMs: number;
  private readonly scheduler: TimerScheduler;
  private readonly logger: (message: string, error: unknown) => void;
  private readonly pending = new Map<string, PendingSnapshot>();
  private readonly writes = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly write: VfsWriter,
    options: {
      debounceMs?: number;
      scheduler?: TimerScheduler;
      logger?: (message: string, error: unknown) => void;
    } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.logger = options.logger ??
      ((message, error) => console.error(message, error));
    this.middleware = {
      didOpen: async (document, next) => {
        const snapshot = this.snapshot(document);
        try {
          if (snapshot) await this.queueWrite(snapshot);
        } finally {
          await next(document);
        }
      },
      didChange: (event, next) => {
        const snapshot = this.snapshot(event.document);
        if (snapshot) this.schedule(snapshot);
        return next(event);
      },
      didClose: async (document, next) => {
        try {
          await this.flush(document);
        } finally {
          await next(document);
        }
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const snapshots = [...this.pending.values()];
    this.pending.clear();
    for (const snapshot of snapshots) {
      this.scheduler.clear(snapshot.handle);
    }
    const queued = snapshots.map((snapshot) => this.queueWrite(snapshot));
    await Promise.all(queued);
    await Promise.all([...this.writes.values()]);
  }

  private snapshot(document: TextDocument): Snapshot | undefined {
    const { uri } = document;
    if (
      document.languageId !== "rust" || uri.scheme !== "file" ||
      uri.authority !== "" || !uri.path.startsWith("/")
    ) return undefined;
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

  private async flush(document: TextDocument): Promise<void> {
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
      .then(() => this.write(snapshot.path, snapshot.content))
      .catch((error) => this.logger(`failed to mirror ${snapshot.path}`, error))
      .finally(() => {
        if (this.writes.get(snapshot.uri) === current) {
          this.writes.delete(snapshot.uri);
        }
      });
    this.writes.set(snapshot.uri, current);
    return current;
  }
}
