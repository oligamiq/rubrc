import type { VfsReadyResult } from "./vfs_readiness.ts";

export type DisposableLspSession = { dispose(): Promise<void> };

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
        await session?.dispose();
      }
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
    ).then(async (session) => {
      if (this.disposed) await session.dispose();
      else this.session = session;
      return session;
    });
  }
}
