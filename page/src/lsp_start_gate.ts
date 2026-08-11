import type { VfsReadyResult } from "./vfs_readiness.ts";

export type DisposableLspSession = {
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

export class LspStartGate<TMonaco> {
  private monaco: TMonaco | undefined;
  private vfsResult: VfsReadyResult | undefined;
  private startPromise: Promise<DisposableLspSession> | undefined;
  private session: DisposableLspSession | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly abortController = new AbortController();

  constructor(
    private readonly start: (
      monaco: TMonaco,
      signal: AbortSignal,
    ) => Promise<DisposableLspSession>,
  ) {}

  setMonaco(monaco: TMonaco): void {
    this.monaco = monaco;
    this.tryStart();
  }

  setVfsResult(result: VfsReadyResult): void {
    if (this.vfsResult !== undefined) return;
    this.vfsResult = result;
    this.tryStart();
  }

  started(): Promise<void> | undefined {
    return this.startPromise?.then(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.disposed) throw this.abortController.signal.reason;
    let session: DisposableLspSession | undefined;
    try {
      session = await this.startPromise;
    } catch (error) {
      if (this.abortController.signal.aborted) {
        throw this.abortController.signal.reason;
      }
      return;
    }
    if (this.disposed) throw this.abortController.signal.reason;
    if (session) {
      const signal = this.abortController.signal;
      const onAbort = () => rejectCancellation(signal.reason);
      let rejectCancellation!: (reason: unknown) => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([session.flush(), cancellation]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    if (this.disposed) throw this.abortController.signal.reason;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.abortController.abort(
      new DOMException("LSP startup disposed", "AbortError"),
    );
    this.disposePromise = (async () => {
      let session: DisposableLspSession | undefined;
      try {
        session = await this.startPromise;
      } catch {
        return;
      }
      if (this.session === session) {
        this.session = undefined;
      }
      await session?.dispose();
    })();
    return this.disposePromise;
  }

  private tryStart(): void {
    if (
      this.disposed ||
      this.startPromise ||
      this.vfsResult?.ok !== true ||
      !this.monaco
    )
      return;
    this.startPromise = this.start(
      this.monaco,
      this.abortController.signal,
    ).then((session) => {
      if (!this.disposed) this.session = session;
      return session;
    });
  }
}
