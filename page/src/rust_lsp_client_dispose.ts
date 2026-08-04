import { closeUnderlyingChannel } from "./shared_object_channel.ts";

export async function disposeRustLspResources(
  sync: { dispose(): Promise<void> } | undefined,
  client: { needsStop(): boolean; stop(): Promise<void> } | undefined,
  connection: { dispose(): void } | undefined,
  vfsSharedRef: unknown | undefined,
  progressDisposable?: { dispose(): void },
  testApiDisposable?: { dispose(): void },
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
    if (sync) await sync.dispose();
  } catch (e) {
    errors.push(e);
  }

  try {
    if (client?.needsStop()) await client.stop();
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
  private sync: { dispose(): Promise<void> } | undefined;
  private client: { needsStop(): boolean; stop(): Promise<void> } | undefined;
  private connection: { dispose(): void } | undefined;
  private vfsSharedRef: unknown | undefined;
  private progressDisposable: { dispose(): void } | undefined;
  private testApiDisposable: { dispose(): void } | undefined;

  private disposePromise: Promise<void> | undefined;

  setSync(s: { dispose(): Promise<void> }) {
    this.sync = s;
  }
  setClient(c: { needsStop(): boolean; stop(): Promise<void> }) {
    this.client = c;
  }
  setConnection(c: { dispose(): void }) {
    this.connection = c;
  }
  setVfsSharedRef(r: unknown) {
    this.vfsSharedRef = r;
  }
  setProgressDisposable(disposable: { dispose(): void }) {
    this.progressDisposable = disposable;
  }
  setTestApiDisposable(disposable: { dispose(): void }) {
    this.testApiDisposable = disposable;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = disposeRustLspResources(
      this.sync,
      this.client,
      this.connection,
      this.vfsSharedRef,
      this.progressDisposable,
      this.testApiDisposable,
    );
    return this.disposePromise;
  }
}
