import { closeUnderlyingChannel } from "./shared_object_channel.ts";

export async function disposeRustLspResources(
  sync: { dispose(): Promise<void> } | undefined,
  client: { needsStop(): boolean; stop(): Promise<void> } | undefined,
  connection: { dispose(): void } | undefined,
  vfsSharedRef: unknown | undefined
): Promise<void> {
  const errors: unknown[] = [];

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
    if (connection) connection.dispose();
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

  private disposePromise: Promise<void> | undefined;

  setSync(s: { dispose(): Promise<void> }) { this.sync = s; }
  setClient(c: { needsStop(): boolean; stop(): Promise<void> }) { this.client = c; }
  setConnection(c: { dispose(): void }) { this.connection = c; }
  setVfsSharedRef(r: unknown) { this.vfsSharedRef = r; }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = disposeRustLspResources(
      this.sync,
      this.client,
      this.connection,
      this.vfsSharedRef
    );
    return this.disposePromise;
  }
}
