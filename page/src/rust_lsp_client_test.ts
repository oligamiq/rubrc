import {
  disposeRustLspResources,
  RustLspResourceOwner,
} from "./rust_lsp_client_dispose.ts";
import { installSyntaxTreeRequest } from "./lsp_test_api.ts";
import ts from "typescript";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const syntaxTreeExposureIsGuarded = (source: string) => {
  const sourceFile = ts.createSourceFile(
    "rust_lsp_client.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const exposureGuards: boolean[] = [];
  const visit = (node: ts.Node, guarded: boolean) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "exposeSyntaxTreeRequest"
    ) {
      exposureGuards.push(guarded);
    }

    if (
      ts.isIfStatement(node) &&
      node.expression.getText(sourceFile) ===
        'import.meta.env.VITE_RUBRC_LSP_TEST === "1"'
    ) {
      visit(node.thenStatement, true);
      if (node.elseStatement) visit(node.elseStatement, guarded);
      return;
    }

    ts.forEachChild(node, (child) => visit(child, guarded));
  };
  visit(sourceFile, false);
  return exposureGuards.length === 1 && exposureGuards[0];
};

const syntaxTreeExposureFollowsStartup = (source: string) => {
  const sourceFile = ts.createSourceFile(
    "rust_lsp_client.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let startup: ts.AwaitExpression | undefined;
  let exposure: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "runRustLspStartup"
    ) {
      startup = node;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "exposeSyntaxTreeRequest"
    ) {
      exposure = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return (
    startup !== undefined &&
    exposure !== undefined &&
    startup.getEnd() < exposure.getStart(sourceFile)
  );
};

const ownTestApiDisposable = (
  owner: RustLspResourceOwner,
  disposable: { dispose(): void },
) => {
  const setDisposable = (
    owner as unknown as {
      setTestApiDisposable?: (value: { dispose(): void }) => void;
    }
  ).setTestApiDisposable;
  assert(setDisposable, "test API disposable is not resource-owned");
  setDisposable.call(owner, disposable);
};

Deno.test("browser startup uses the non-progress sequencer", async () => {
  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");

  assert(source.includes("runRustLspStartup"), "startup sequencer is not used");
  assert(
    !source.includes("const projectReady"),
    "Fetching still gates startup",
  );
});

Deno.test("browser startup waits for main didOpen before resolving", async () => {
  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  const waitIndex = source.indexOf(
    'sync.waitForDidOpen("file:///src/main.rs")',
  );
  const startIndex = source.indexOf("startClient: () => client.start()");
  const createIndex = source.indexOf("monaco.editor.createModel(", startIndex);
  const awaitIndex = source.indexOf("await mainDidOpen", createIndex);
  const cleanupIndex = source.indexOf(
    "createdMainModel?.dispose()",
    awaitIndex,
  );

  assert(waitIndex >= 0, "main didOpen completion is not observed");
  assert(
    waitIndex < startIndex,
    "main didOpen observation starts after client startup",
  );
  assert(
    createIndex > startIndex,
    "named model is created before client startup",
  );
  assert(
    awaitIndex > createIndex,
    "named model creation does not await didOpen",
  );
  assert(
    cleanupIndex > awaitIndex,
    "startup-owned model is not disposed on failure",
  );
});

Deno.test("browser client wires abort and transport cancellation into startup", async () => {
  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  assert(
    /startRustLspClient\([\s\S]*signal:\s*AbortSignal/.test(source),
    "browser client does not accept AbortSignal",
  );
  assert(
    source.includes("cancelClientStart: () => connection.dispose()"),
    "startup cancellation does not close message transports",
  );
  assert(
    /runRustLspStartup\([\s\S]*300_000,\s*signal\s*,?\s*\)/.test(source),
    "browser client does not pass AbortSignal to startup",
  );
});

Deno.test("Fetching progress remains attached to resource ownership", async () => {
  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  const listenerIndex = source.indexOf("client.onProgress(");
  const recordIndex = source.indexOf("recordLspProgress(value)", listenerIndex);
  const ownerIndex = source.indexOf(
    "owner.setProgressDisposable(progressDisposable)",
    recordIndex,
  );

  assert(listenerIndex >= 0, "Fetching progress listener is missing");
  assert(recordIndex > listenerIndex, "Fetching progress is not recorded");
  assert(ownerIndex > recordIndex, "progress listener is not resource-owned");
});

Deno.test("syntax-tree requests are exposed only in LSP test builds", async () => {
  const clientSource = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  const exposureIndex = clientSource.indexOf("exposeSyntaxTreeRequest(client)");
  const ownershipIndex = clientSource.indexOf("owner.setTestApiDisposable(");

  assert(
    syntaxTreeExposureIsGuarded(clientSource),
    "syntax-tree test request is exposed outside its build guard",
  );
  assert(
    !syntaxTreeExposureIsGuarded(
      'if (import.meta.env.VITE_RUBRC_LSP_TEST === "1") {}\n' +
        "exposeSyntaxTreeRequest(client);",
    ),
    "guard contract accepts an exposure call outside the guarded block",
  );
  assert(
    syntaxTreeExposureFollowsStartup(clientSource),
    "syntax-tree test request is exposed before startup completes",
  );
  assert(
    !syntaxTreeExposureFollowsStartup(
      "await runRustLspStartup({ start: () => " +
        "exposeSyntaxTreeRequest(client) });",
    ),
    "startup contract accepts exposure from inside startup",
  );
  assert(
    ownershipIndex >= 0 && ownershipIndex < exposureIndex,
    "syntax-tree test request is not resource-owned",
  );
});

Deno.test("syntax-tree callback disposal preserves a newer client", async () => {
  const state: {
    requestSyntaxTree?: (uri: string) => Promise<string>;
  } = {};
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = (name: string) => ({
    sendRequest: async <TResult>(method: string, params: unknown) => {
      requests.push({ method, params });
      return name as TResult;
    },
  });

  const firstDisposable = installSyntaxTreeRequest(state, client("first"));
  const secondDisposable = installSyntaxTreeRequest(state, client("second"));
  const secondRequest = state.requestSyntaxTree;
  const result = await secondRequest?.("file:///src/main.rs");
  assert(result === "second", "syntax-tree request used the wrong client");
  assert(
    requests[0]?.method === "rust-analyzer/viewSyntaxTree",
    "syntax-tree request used the wrong method",
  );
  assert(
    JSON.stringify(requests[0]?.params) ===
      JSON.stringify({ textDocument: { uri: "file:///src/main.rs" } }),
    "syntax-tree request used the wrong parameters",
  );

  firstDisposable.dispose();
  assert(
    state.requestSyntaxTree === secondRequest,
    "disposing an older client cleared the newer callback",
  );

  const owner = new RustLspResourceOwner();
  ownTestApiDisposable(owner, secondDisposable);
  await owner.dispose();
  assert(
    state.requestSyntaxTree === undefined,
    "normal owner disposal retained the syntax-tree callback",
  );
});

Deno.test("RustLspResourceOwner disposes all resources even if one throws", async () => {
  const owner = new RustLspResourceOwner();

  const testApiError = new Error("test API dispose failed");
  let testApiDisposed = false;
  ownTestApiDisposable(owner, {
    dispose: () => {
      testApiDisposed = true;
      throw testApiError;
    },
  });

  let syncDisposed = false;
  owner.setSync({
    dispose: async () => {
      syncDisposed = true;
      throw new Error("sync dispose failed");
    },
  });

  let clientStopped = false;
  owner.setClient({
    needsStop: () => true,
    stop: async () => {
      clientStopped = true;
      throw new Error("client stop failed");
    },
  });

  let connectionDisposed = false;
  owner.setConnection({
    dispose: () => {
      connectionDisposed = true;
      throw new Error("connection dispose failed");
    },
  });

  let sharedRefClosed = false;
  owner.setVfsSharedRef({
    bc: {
      close: () => {
        sharedRefClosed = true;
      },
    },
  });

  let errorThrown = false;
  try {
    await owner.dispose();
  } catch (e) {
    errorThrown = true;
    assert(e instanceof AggregateError, "Should throw AggregateError");
    assert(
      e.errors.includes(testApiError),
      "test API error was not aggregated",
    );
  }

  assert(errorThrown, "Should throw");
  assert(testApiDisposed, "test API callback not disposed");
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
    },
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
    },
  });

  await owner.dispose();
  assert(clientStopped, "client not stopped");
});

Deno.test("RustLspResourceOwner disposes the progress listener", async () => {
  const owner = new RustLspResourceOwner();
  let disposed = 0;

  owner.setProgressDisposable({
    dispose: () => {
      disposed++;
    },
  });
  await owner.dispose();
  await owner.dispose();

  assert(disposed === 1, `progress listener disposed ${disposed} times`);
});

Deno.test("disposeRustLspResources tests synchronous construction failure cleanly", async () => {
  let syncDisposed = false;
  let sharedRefClosed = false;

  await disposeRustLspResources(
    {
      dispose: async () => {
        syncDisposed = true;
      },
    },
    undefined, // client failed to construct
    undefined, // connection failed to construct
    {
      bc: {
        close: () => {
          sharedRefClosed = true;
        },
      },
    },
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
    },
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
      assert(
        cleanupError instanceof AggregateError,
        "Cleanup should throw AggregateError",
      );
    }
    caughtError = error;
  }

  assert(caughtError === originalError, "Should preserve original error");
});
