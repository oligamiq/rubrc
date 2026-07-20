import { RustLspResourceOwner } from "./rust_lsp_client_dispose.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("RustLspResourceOwner disposes all resources even if one throws", async () => {
  const owner = new RustLspResourceOwner();
  
  let syncDisposed = false;
  owner.setSync({
    dispose: async () => {
      syncDisposed = true;
      throw new Error("sync dispose failed");
    }
  });

  let clientStopped = false;
  owner.setClient({
    needsStop: () => true,
    stop: async () => {
      clientStopped = true;
      throw new Error("client stop failed");
    }
  });

  let connectionDisposed = false;
  owner.setConnection({
    dispose: () => {
      connectionDisposed = true;
      throw new Error("connection dispose failed");
    }
  });

  let sharedRefClosed = false;
  owner.setVfsSharedRef({
    bc: {
      close: () => {
        sharedRefClosed = true;
      }
    }
  });

  await owner.dispose().catch(() => {});

  assert(syncDisposed, "sync not disposed");
  assert(clientStopped, "client not stopped");
  assert(connectionDisposed, "connection not disposed");
  assert(sharedRefClosed, "shared ref not closed");
});

Deno.test("RustLspResourceOwner is idempotent", async () => {
  const owner = new RustLspResourceOwner();
  
  let disposes = 0;
  owner.setSync({
    dispose: async () => {
      disposes++;
    }
  });

  await owner.dispose();
  await owner.dispose();
  
  assert(disposes === 1, "disposed multiple times");
});

Deno.test("RustLspResourceOwner gracefully handles missing resources", async () => {
  const owner = new RustLspResourceOwner();
  
  let clientStopped = false;
  owner.setClient({
    needsStop: () => true,
    stop: async () => {
      clientStopped = true;
    }
  });

  await owner.dispose();
  assert(clientStopped, "client not stopped");
});
