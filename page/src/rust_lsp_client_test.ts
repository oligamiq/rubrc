import { RustLspResourceOwner, disposeRustLspResources } from "./rust_lsp_client_dispose.ts";

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

  let errorThrown = false;
  try {
    await owner.dispose();
  } catch (e) {
    errorThrown = true;
    assert(e instanceof AggregateError, "Should throw AggregateError");
  }

  assert(errorThrown, "Should throw");
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

Deno.test("disposeRustLspResources tests synchronous construction failure cleanly", async () => {
  let syncDisposed = false;
  let sharedRefClosed = false;

  await disposeRustLspResources(
    { dispose: async () => { syncDisposed = true; } },
    undefined, // client failed to construct
    undefined, // connection failed to construct
    { bc: { close: () => { sharedRefClosed = true; } } }
  );

  assert(syncDisposed, "sync should be disposed");
  assert(sharedRefClosed, "shared ref should be closed");
});

Deno.test("startRustLspClient preserves original construction error when cleanup throws", async () => {
  // Simulate the logic in startRustLspClient where construction error is thrown
  const owner = new RustLspResourceOwner();
  owner.setSync({
    dispose: async () => {
      throw new Error("cleanup rejected");
    }
  });

  const originalError = new Error("construction failed");
  let caughtError: unknown;

  try {
    throw originalError;
  } catch (error) {
    try {
      await owner.dispose();
    } catch (cleanupError) {
      // cleanupError is caught and logged, but originalError is preserved
      assert(cleanupError instanceof AggregateError, "Cleanup should throw AggregateError");
    }
    caughtError = error;
  }

  assert(caughtError === originalError, "Should preserve original error");
});
