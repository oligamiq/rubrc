export function closeUnderlyingChannel(sharedObj: unknown) {
  const obj = sharedObj as { bc?: { close(): void } };
  obj?.bc?.close();
}

export function disposeRustLspResources(
  sync: { dispose(): Promise<void> } | undefined,
  client: { needsStop(): boolean; stop(): Promise<void> } | undefined,
  connection: { dispose(): void } | undefined,
  vfsSharedRef: unknown | undefined
): Promise<void> {
  return (async () => {
    try {
      await sync?.dispose();
    } finally {
      try {
        if (client?.needsStop()) {
          await client.stop();
        }
      } finally {
        try {
          connection?.dispose();
        } finally {
          if (vfsSharedRef) {
            closeUnderlyingChannel(vfsSharedRef);
          }
        }
      }
    }
  })();
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
