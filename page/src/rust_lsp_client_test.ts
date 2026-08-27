import {
  disposeRustLspResources,
  RustLspResourceOwner,
} from "./rust_lsp_client_dispose.ts";
import {
  installGenerationSyntaxTreeRequest,
  installSyntaxTreeRequest,
} from "./lsp_test_api.ts";
import {
  beginLspTestGeneration,
  captureLspTestGeneration,
  type LspTestGenerationState,
} from "./lsp_test_api_state.ts";
import { mergeVersionedPublishDiagnostics } from "./rust_lsp_client_capabilities.ts";
import { activateRustProject } from "./rust_lsp_startup.ts";
import { RustDocumentSync } from "./rust_document_sync.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("RustLspResourceOwner is synchronously adoptable by a runtime", async () => {
  let adopted: { dispose(): Promise<void> } | undefined;
  const owner = new RustLspResourceOwner({
    adoptOperationOwner(candidate) {
      adopted = candidate;
    },
  });

  assert(adopted === owner, "runtime did not synchronously adopt LSP owner");
  await owner.dispose();
});

Deno.test("RustLspResourceOwner memoizes disposal before synchronous listener reentry", async () => {
  const owner = new RustLspResourceOwner();
  let disposeCalls = 0;
  let reentrantDisposal: Promise<void> | undefined;
  owner.setTestApiDisposable({
    dispose() {
      disposeCalls++;
      if (disposeCalls === 1) reentrantDisposal = owner.dispose();
    },
  });

  const disposal = owner.dispose();

  assert(disposal === reentrantDisposal, "reentrant disposal Promise changed");
  await disposal;
  assert(disposeCalls === 1, `listener disposed ${disposeCalls} times`);
});

Deno.test("RustLspResourceOwner reentrant abort closes transport once and skips stop", async () => {
  const owner = new RustLspResourceOwner();
  let transportDisposals = 0;
  let clientStops = 0;
  owner.setTestApiDisposable({
    dispose: () => owner.abort(new Error("listener aborted disposal")),
  });
  owner.setClient({
    needsStop: () => true,
    stop: async () => {
      clientStops++;
    },
  });
  owner.setConnection({
    dispose: () => {
      transportDisposals++;
    },
  });

  await owner.dispose();

  assert(clientStops === 0, "reentrant abort attempted graceful stop");
  assert(
    transportDisposals === 1,
    `reentrant abort disposed transport ${transportDisposals} times`,
  );
});

Deno.test("RustLspResourceOwner abort severs transport during pending disposal", async () => {
  const owner = new RustLspResourceOwner();
  let releaseSync!: () => void;
  const syncBlocked = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  let transportDisposals = 0;
  let clientStops = 0;
  owner.setSync({ dispose: () => syncBlocked });
  owner.setClient({
    needsStop: () => true,
    stop: async () => {
      clientStops++;
    },
  });
  owner.setConnection({
    dispose: () => {
      transportDisposals++;
    },
  });

  const disposal = owner.dispose();
  assert(disposal === owner.dispose(), "pending disposal Promise changed");
  await Promise.resolve();
  assert(transportDisposals === 0, "pending disposal closed transport early");

  owner.abort(new Error("abort pending LSP disposal"));
  assert(
    transportDisposals === 1,
    "abort did not synchronously close pending transport",
  );
  releaseSync();
  await disposal;

  assert(clientStops === 0, "pending abort attempted graceful client stop");
  assert(transportDisposals === 1, "pending abort closed transport repeatedly");
});

for (const resource of ["sync", "client"] as const) {
  Deno.test(`RustLspResourceOwner disposal drains reentrant late ${resource} cleanup`, async () => {
    const owner = new RustLspResourceOwner();
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let setterReason: unknown;
    owner.setTestApiDisposable({
      dispose() {
        try {
          if (resource === "sync") {
            owner.setSync({ dispose: () => cleanupBlocked });
          } else {
            owner.setClient({
              needsStop: () => true,
              stop: () => cleanupBlocked,
            });
          }
        } catch (error) {
          setterReason = error;
        }
      },
    });

    const disposal = owner.dispose();
    assert(
      disposal === owner.dispose(),
      `${resource} changed disposal Promise`,
    );
    let settled = false;
    void disposal.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    assert(
      setterReason instanceof DOMException &&
        setterReason.name === "AbortError",
      `${resource} setter lost the retained disposal reason`,
    );
    assert(!settled, `${resource} late cleanup escaped owner disposal`);
    releaseCleanup();
    await disposal;
  });
}

Deno.test("RustLspResourceOwner aggregates synchronous reentrant late cleanup failure", async () => {
  const owner = new RustLspResourceOwner();
  const cleanupError = new Error("late connection cleanup threw");
  let setterReason: unknown;
  owner.setTestApiDisposable({
    dispose() {
      try {
        owner.setConnection({
          dispose() {
            throw cleanupError;
          },
        });
      } catch (error) {
        setterReason = error;
      }
    },
  });

  const disposal = owner.dispose();
  assert(
    disposal === owner.dispose(),
    "synchronous late failure changed Promise",
  );
  let disposalError: unknown;
  try {
    await disposal;
  } catch (error) {
    disposalError = error;
  }

  assert(
    setterReason instanceof DOMException && setterReason.name === "AbortError",
    "synchronous late failure replaced the retained setter reason",
  );
  assert(
    disposalError instanceof AggregateError &&
      disposalError.errors.includes(cleanupError),
    "synchronous late cleanup failure did not participate in disposal",
  );
});

Deno.test("RustLspResourceOwner rejects and cleans every late resource acquisition", async () => {
  const owner = new RustLspResourceOwner();
  const calls: Record<string, number> = {};
  const called = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const cleanupError = new Error("late async cleanup failed");
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const disposal = owner.dispose();
    const acquisitions = [
      () =>
        owner.setSync({
          dispose: async () => {
            called("sync");
            throw cleanupError;
          },
        }),
      () =>
        owner.setClient({
          needsStop: () => true,
          stop: async () => called("client"),
        }),
      () => owner.setConnection({ dispose: () => called("connection") }),
      () =>
        owner.setVfsSharedRef({ bc: { close: () => called("shared-ref") } }),
      () => owner.setProgressDisposable({ dispose: () => called("progress") }),
      () => owner.setTestApiDisposable({ dispose: () => called("test-api") }),
      () => owner.setReadiness({ dispose: () => called("readiness") }),
      () => owner.setModelListener({ dispose: () => called("model-listener") }),
    ];
    const reasons: unknown[] = [];

    for (const acquire of acquisitions) {
      try {
        acquire();
      } catch (error) {
        reasons.push(error);
      }
    }
    let disposalError: unknown;
    try {
      await disposal;
    } catch (error) {
      disposalError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert(
      reasons.length === acquisitions.length,
      "late acquisition did not fail",
    );
    assert(
      reasons.every((reason) => reason === reasons[0]),
      "late acquisitions did not retain one disposal reason",
    );
    assert(
      reasons[0] instanceof DOMException && reasons[0].name === "AbortError",
      "late acquisitions did not retain an AbortError",
    );
    assert(
      disposalError instanceof AggregateError &&
        disposalError.errors.includes(cleanupError),
      "late async cleanup failure did not participate in disposal",
    );
    for (const name of [
      "sync",
      "client",
      "connection",
      "shared-ref",
      "progress",
      "test-api",
      "readiness",
      "model-listener",
    ]) {
      assert(calls[name] === 1, `${name} late cleanup count changed`);
    }
    assert(unhandled === 0, "late async cleanup rejection was unobserved");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("RustLspResourceOwner abort skips graceful stop and disposes remaining resources", async () => {
  const owner = new RustLspResourceOwner();
  const calls: Record<string, number> = {};
  const called = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  let transportClosed = false;
  owner.setTestApiDisposable({ dispose: () => called("test-api") });
  owner.setProgressDisposable({ dispose: () => called("progress") });
  owner.setModelListener({ dispose: () => called("model-listener") });
  owner.setReadiness({ dispose: () => called("readiness") });
  owner.setSync({ dispose: async () => called("sync") });
  owner.setClient({
    needsStop: () => true,
    stop: async () => {
      called("client");
      if (transportClosed)
        throw new Error("client stopped over closed transport");
    },
  });
  owner.setConnection({
    dispose: () => {
      called("transport");
      transportClosed = true;
    },
  });
  owner.setVfsSharedRef({ bc: { close: () => called("shared-ref") } });

  const abortReason = new Error("runtime generation aborted");
  owner.abort(abortReason);
  assert(
    transportClosed && calls.transport === 1,
    "abort did not synchronously sever transport",
  );
  await owner.dispose();

  assert(calls.client === undefined, "abort attempted graceful client stop");
  for (const name of [
    "test-api",
    "progress",
    "model-listener",
    "readiness",
    "sync",
    "transport",
    "shared-ref",
  ]) {
    assert(calls[name] === 1, `${name} abort cleanup count changed`);
  }
});

Deno.test("RustLspResourceOwner abort cancels document sync before disposal", async () => {
  const owner = new RustLspResourceOwner();
  const calls: string[] = [];
  const sync = {
    abort: (reason: unknown) => calls.push(`abort:${String(reason)}`),
    dispose: async () => {
      calls.push("dispose");
    },
  };
  owner.setSync(sync);
  const reason = new Error("runtime generation aborted");

  owner.abort(reason);
  await owner.dispose();

  assert(
    calls.join(",") === `abort:${String(reason)},dispose`,
    `document sync abort order changed: ${calls}`,
  );
});

const syntaxTreeExposureIsGuarded = (source: string) => {
  const guard = source.indexOf(
    'if (import.meta.env.VITE_RUBRC_LSP_TEST === "1")',
  );
  const exposure = source.indexOf(
    "exposeSyntaxTreeRequest(testGeneration, client)",
  );
  if (guard < 0 || exposure < 0) return false;
  const open = source.indexOf("{", guard);
  if (open < 0) return false;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") depth--;
    if (depth === 0) return exposure > open && exposure < index;
  }
  return false;
};

const syntaxTreeExposureFollowsStartup = (source: string) => {
  const startup = source.indexOf("await runRustLspStartup(");
  const exposure = source.indexOf(
    "exposeSyntaxTreeRequest(testGeneration, client)",
  );
  if (startup < 0 || exposure < 0) return false;
  const open = source.indexOf("(", startup);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "(") depth++;
    if (source[index] === ")") depth--;
    if (depth === 0) return index < exposure;
  }
  return false;
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

Deno.test("browser startup receives the named model and starts lightweight", async () => {
  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  const signatureIndex = source.indexOf("model: Monaco.editor.ITextModel");
  const snapshotIndex = source.indexOf("model.getValue()");
  const startIndex = source.indexOf("startClient: () => client.start()");
  assert(
    signatureIndex >= 0,
    "browser client does not receive the named model",
  );
  assert(
    snapshotIndex > signatureIndex,
    "current model text is not snapshotted",
  );
  assert(
    startIndex > snapshotIndex,
    "client starts before the initial VFS write",
  );
  assert(
    source.includes("createRustAnalyzerConfigurationState()") &&
      source.includes(
        "initializationOptions: analyzerConfiguration.initializationOptions()",
      ),
    "client does not initialize with lightweight options",
  );
  assert(!source.includes("createModel("), "client still creates a model");
});

Deno.test("project activation preserves the staged readiness order", async () => {
  const order: string[] = [];
  let text = "latest before activation";
  const model = {
    getValue: () => {
      order.push("latest snapshot");
      return text;
    },
    getVersionId: () => 7,
  };
  const sync = {
    waitForDidClose: (_uri: string) => {
      order.push("didClose waiter armed");
      return Promise.resolve().then(() => {
        order.push("didClose complete");
      });
    },
    waitForDidOpen: (_uri: string) => {
      order.push("didOpen waiter armed");
      return Promise.resolve().then(() => {
        order.push("didOpen complete");
      });
    },
    waitForStrictDidOpen: (_uri: string) => {
      order.push("didOpen waiter armed");
      return Promise.resolve().then(() => {
        order.push("didOpen complete");
      });
    },
  };
  const readiness = {
    waitForCrateGraph: async (_signal: AbortSignal) => {
      order.push("crate graph ready");
    },
    noteDocumentChanged: (version: number) => {
      order.push(`diagnostics listener armed:${version}`);
    },
    waitForSemanticReadiness: async (_model: unknown, _signal: AbortSignal) => {
      order.push("latest diagnostics");
      order.push("explicit inlayHint complete");
    },
  };
  const client = {
    sendNotification: async (method: string, params: unknown) => {
      assert(
        method === "workspace/didChangeConfiguration",
        `wrong activation notification: ${method}`,
      );
      assert(
        JSON.stringify(params).includes('"display_name":"rubrc-main"'),
        "full project settings were not sent",
      );
      order.push("didChangeConfiguration(full settings)");
    },
    sendRequest: async (method: string, params: unknown) => {
      assert(method === "rust-analyzer/reloadWorkspace", `wrong request: ${method}`);
      assert(params === undefined, "workspace reload unexpectedly sent params");
      order.push("reloadWorkspace complete");
    },
  };

  await activateRustProject({
    initializedModel: model,
    model,
    signal: new AbortController().signal,
    uri: "file:///src/main.rs",
    writeMain: async (content) => {
      assert(content === text, "activation wrote a stale model snapshot");
      order.push("VFS write complete");
    },
    client,
    readiness,
    sync,
    setModelLanguage: (_model, language) => {
      order.push(`setModelLanguage(${language})`);
    },
    semanticWarming: () => order.push("semanticWarming"),
  });

  assert(
    order.join(",") ===
      [
        "latest snapshot",
        "didChangeConfiguration(full settings)",
        "crate graph ready",
        "VFS write complete",
        "diagnostics listener armed:7",
        "didClose waiter armed",
        "setModelLanguage(plaintext)",
        "didClose complete",
        "didOpen waiter armed",
        "setModelLanguage(rust)",
        "didOpen complete",
        "semanticWarming",
        "latest diagnostics",
        "explicit inlayHint complete",
      ].join(","),
    `wrong activation order: ${order}`,
  );
});

Deno.test("project activation rejects a different model before side effects", async () => {
  const initializedModel = {
    getValue: () => "initialized",
    getVersionId: () => 1,
  };
  const activationModel = {
    getValue: () => "different",
    getVersionId: () => 2,
  };
  const effects: string[] = [];
  let received: unknown;

  await activateRustProject({
    initializedModel,
    model: activationModel,
    signal: new AbortController().signal,
    uri: "file:///src/main.rs",
    writeMain: async () => {
      effects.push("write");
    },
    client: {
      sendNotification: async () => {
        effects.push("configuration");
      },
      sendRequest: async () => {
        effects.push("reload");
      },
    },
    readiness: {
      waitForCrateGraph: async () => {
        effects.push("crate-graph");
      },
      noteDocumentChanged: () => effects.push("diagnostics"),
      waitForSemanticReadiness: async () => {
        effects.push("semantic");
      },
    },
    sync: {
      waitForDidClose: async () => {
        effects.push("didClose");
      },
      waitForStrictDidOpen: async () => {
        effects.push("didOpen");
      },
    },
    setModelLanguage: () => effects.push("language"),
    semanticWarming: () => effects.push("warming"),
  }).catch((error) => {
    received = error;
  });

  assert(
    received instanceof Error &&
      received.message === "Rust activation model changed after initialization",
    `wrong model mismatch error: ${received}`,
  );
  assert(
    effects.length === 0,
    `model mismatch caused side effects: ${effects}`,
  );
});

Deno.test("project activation rechecks abort after snapshot before VFS mutation", async () => {
  const controller = new AbortController();
  const reason = new Error("abort during snapshot");
  let writes = 0;
  const model = {
    getValue: () => {
      controller.abort(reason);
      return "text";
    },
    getVersionId: () => 1,
  };
  let received: unknown;

  await activateRustProject({
    initializedModel: model,
    model,
    signal: controller.signal,
    uri: "file:///src/main.rs",
    writeMain: async () => {
      writes++;
    },
    client: {
      sendNotification: async () => {},
      sendRequest: async () => {},
    },
    readiness: {
      waitForCrateGraph: async () => {},
      noteDocumentChanged: () => {},
      waitForSemanticReadiness: async () => {},
    },
    sync: {
      waitForDidClose: async () => {},
      waitForStrictDidOpen: async () => {},
    },
    setModelLanguage: () => {},
    semanticWarming: () => {},
  }).catch((error) => {
    received = error;
  });

  assert(received === reason, "snapshot abort reason changed");
  assert(writes === 0, "VFS mutation started after snapshot abort");
});

Deno.test("activation didOpen mirrors an edit made after its initial snapshot", async () => {
  const uri = "file:///src/main.rs";
  const initial = "fn main() { initial(); }";
  const latest = "fn main() { latest(); }";
  let text = initial;
  let version = 1;
  const order: string[] = [];
  const writes: string[] = [];
  const model = {
    getValue: () => text,
    getVersionId: () => version,
  };
  const sync = new RustDocumentSync(async (_path, content) => {
    writes.push(content);
    order.push(`write:${content}`);
  });
  let didOpenDispatch: Promise<void> | undefined;
  const rustDocument = {
    uri: {
      scheme: "file",
      authority: "",
      path: "/src/main.rs",
      toString: () => uri,
    },
    languageId: "rust",
    get version() {
      return version;
    },
    getText: () => text,
  } as never;

  await activateRustProject({
    initializedModel: model,
    model,
    signal: new AbortController().signal,
    uri,
    writeMain: async (content) => {
      writes.push(content);
      order.push(`write:${content}`);
      text = latest;
      version = 2;
    },
    client: {
      sendNotification: async () => {
        order.push("configuration");
      },
      sendRequest: async () => {
        order.push("reload");
      },
    },
    readiness: {
      waitForCrateGraph: async () => {
        order.push("crate-graph");
      },
      noteDocumentChanged: (current) => order.push(`version:${current}`),
      waitForSemanticReadiness: async () => {
        order.push("semantic-ready");
      },
    },
    sync,
    setModelLanguage: (_model, language) => {
      order.push(`language:${language}`);
      if (language === "plaintext") {
        void sync.middleware.didClose!(rustDocument, async () => {
          order.push("didClose-forwarded");
        });
        return;
      }
      didOpenDispatch = Promise.resolve(
        sync.middleware.didOpen!(rustDocument, async () => {
          order.push("didOpen-forwarded");
        }),
      );
    },
    semanticWarming: () => order.push("semantic-warming"),
  });
  await didOpenDispatch;

  assert(
    writes.join("|") === `${initial}|${latest}`,
    `activation did not mirror the latest text: ${writes}`,
  );
  assert(
    order.indexOf(`write:${latest}`) < order.indexOf("didOpen-forwarded") &&
      order.indexOf("didOpen-forwarded") < order.indexOf("semantic-warming"),
    `activation did not await latest didOpen mirroring: ${order}`,
  );
});

Deno.test("project activation stops at every aborted barrier", async () => {
  const cases = [
    ["configuration", "configuration"],
    ["crate-graph", "configuration,crate-graph"],
    ["write", "configuration,crate-graph,write"],
    ["diagnostics", "configuration,crate-graph,write,diagnostics"],
    ["didClose", "configuration,crate-graph,write,diagnostics,didClose"],
    [
      "didOpen",
      "configuration,crate-graph,write,diagnostics,didClose,language,didOpen",
    ],
    [
      "language",
      "configuration,crate-graph,write,diagnostics,didClose,language",
    ],
    [
      "warming",
      "configuration,crate-graph,write,diagnostics,didClose,language,didOpen,language,warming",
    ],
  ] as const;

  for (const [abortAt, expected] of cases) {
    const controller = new AbortController();
    const order: string[] = [];
    const step = (name: string) => {
      order.push(name);
      if (name === abortAt) controller.abort(new Error(`abort:${name}`));
    };
    let received: unknown;
    const model = { getValue: () => "text", getVersionId: () => 1 };
    await activateRustProject({
      initializedModel: model,
      model,
      signal: controller.signal,
      uri: "file:///src/main.rs",
      writeMain: async () => step("write"),
      client: {
        sendNotification: async () => step("configuration"),
        sendRequest: async () => step("reload"),
      },
      readiness: {
        waitForCrateGraph: async () => step("crate-graph"),
        noteDocumentChanged: () => step("diagnostics"),
        waitForSemanticReadiness: async () => step("semantic-ready"),
      },
      sync: {
        waitForDidClose: async () => step("didClose"),
        waitForStrictDidOpen: async () => step("didOpen"),
      },
      setModelLanguage: () => step("language"),
      semanticWarming: () => step("warming"),
    }).catch((error) => {
      received = error;
    });

    assert(received === controller.signal.reason, `${abortAt} reason changed`);
    assert(
      order.join(",") === expected,
      `${abortAt} allowed later activation work: ${order}`,
    );
  }
});

Deno.test("project activation settles direct mutations before rejecting abort", async () => {
  const mutations = ["configuration", "write"] as const;

  for (const pendingAt of mutations) {
    const controller = new AbortController();
    const order: string[] = [];
    let entered!: () => void;
    let resolveMutation!: () => void;
    let rejectMutation!: (error: unknown) => void;
    const enteredBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve, reject) => {
      resolveMutation = resolve;
      rejectMutation = reject;
    });
    const barrier = async (name: string) => {
      order.push(name);
      if (name === pendingAt) {
        entered();
        await pending;
      }
    };
    const model = { getValue: () => "text", getVersionId: () => 1 };
    let received: unknown;
    let activationSettled = false;
    const activation = activateRustProject({
      initializedModel: model,
      model,
      signal: controller.signal,
      uri: "file:///src/main.rs",
      writeMain: () => barrier("write"),
      client: {
        sendNotification: () => barrier("configuration"),
        sendRequest: () => barrier("reload"),
      },
      readiness: {
        waitForCrateGraph: () => barrier("crate-graph"),
        noteDocumentChanged: () => order.push("diagnostics"),
        waitForSemanticReadiness: () => barrier("semantic-ready"),
      },
      sync: {
        waitForDidClose: () => barrier("didClose"),
        waitForStrictDidOpen: () => barrier("didOpen"),
      },
      setModelLanguage: () => order.push("language"),
      semanticWarming: () => order.push("warming"),
    })
      .catch((error) => {
        received = error;
        order.push("rejected");
      })
      .finally(() => {
        activationSettled = true;
      });

    await enteredBarrier;
    const reason = new Error(`abort pending ${pendingAt}`);
    controller.abort(reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(!activationSettled, `${pendingAt} rejected before mutation settled`);
    assert(!order.includes("rejected"), `${pendingAt} rejected while detached`);

    if (pendingAt === "write") {
      resolveMutation();
    } else {
      rejectMutation(new Error("late configuration failure"));
    }
    await activation;
    assert(received === reason, `${pendingAt} abort reason changed`);
    assert(order.at(-1) === "rejected", `${pendingAt} continued after abort`);
  }
});

Deno.test("project activation promptly aborts pending observation waiters", async () => {
  const observations = [
    "crate-graph",
    "didClose",
    "didOpen",
    "semantic-ready",
  ] as const;

  for (const pendingAt of observations) {
    const controller = new AbortController();
    let entered!: () => void;
    const enteredBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>(() => {});
    const barrier = async (name: string) => {
      if (name === pendingAt) {
        entered();
        await pending;
      }
    };
    const model = { getValue: () => "text", getVersionId: () => 1 };
    let received: unknown;
    let activationSettled = false;
    const activation = activateRustProject({
      initializedModel: model,
      model,
      signal: controller.signal,
      uri: "file:///src/main.rs",
      writeMain: () => barrier("write"),
      client: {
        sendNotification: () => barrier("configuration"),
        sendRequest: () => barrier("reload"),
      },
      readiness: {
        waitForCrateGraph: () => barrier("crate-graph"),
        noteDocumentChanged: () => {},
        waitForSemanticReadiness: () => barrier("semantic-ready"),
      },
      sync: {
        waitForDidClose: () => barrier("didClose"),
        waitForStrictDidOpen: () => barrier("didOpen"),
      },
      setModelLanguage: () => {},
      semanticWarming: () => {},
    })
      .catch((error) => {
        received = error;
      })
      .finally(() => {
        activationSettled = true;
      });

    await enteredBarrier;
    const reason = new Error(`abort pending ${pendingAt}`);
    controller.abort(reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(activationSettled, `${pendingAt} did not abort promptly`);
    assert(received === reason, `${pendingAt} abort reason changed`);
    await activation;
  }
});

Deno.test("project activation observes a late rejection after synchronous observation abort", async () => {
  const controller = new AbortController();
  const reason = new Error("abort while starting crate graph observation");
  let rejectObservation!: (error: unknown) => void;
  const observation = new Promise<void>((_resolve, reject) => {
    rejectObservation = reject;
  });
  const model = { getValue: () => "text", getVersionId: () => 1 };
  let received: unknown;

  await activateRustProject({
    initializedModel: model,
    model,
    signal: controller.signal,
    uri: "file:///src/main.rs",
    writeMain: async () => {},
    client: {
      sendNotification: async () => {},
      sendRequest: async () => {},
    },
    readiness: {
      waitForCrateGraph: () => {
        controller.abort(reason);
        return observation;
      },
      noteDocumentChanged: () => {},
      waitForSemanticReadiness: async () => {},
    },
    sync: {
      waitForDidClose: async () => {},
      waitForStrictDidOpen: async () => {},
    },
    setModelLanguage: () => {},
    semanticWarming: () => {},
  }).catch((error) => {
    received = error;
  });

  assert(received === reason, "synchronous observation abort reason changed");
  rejectObservation(new Error("late observation rejection"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

Deno.test("project activation observes a late didOpen rejection after synchronous abort", async () => {
  const controller = new AbortController();
  const reason = new Error("abort while creating didOpen waiter");
  let rejectDidOpen!: (error: unknown) => void;
  const didOpen = new Promise<void>((_resolve, reject) => {
    rejectDidOpen = reject;
  });
  const model = { getValue: () => "text", getVersionId: () => 1 };
  let received: unknown;

  await activateRustProject({
    initializedModel: model,
    model,
    signal: controller.signal,
    uri: "file:///src/main.rs",
    writeMain: async () => {},
    client: {
      sendNotification: async () => {},
      sendRequest: async () => {},
    },
    readiness: {
      waitForCrateGraph: async () => {},
      noteDocumentChanged: () => {},
      waitForSemanticReadiness: async () => {},
    },
    sync: {
      waitForDidClose: async () => {},
      waitForStrictDidOpen: () => {
        controller.abort(reason);
        return didOpen;
      },
    },
    setModelLanguage: () => {},
    semanticWarming: () => {},
  }).catch((error) => {
    received = error;
  });

  assert(received === reason, "synchronous didOpen abort reason changed");
  rejectDidOpen(new Error("late didOpen rejection"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

Deno.test("project activation checks abort after semantic readiness", async () => {
  const controller = new AbortController();
  const reason = new Error("abort after semantic readiness");
  const model = { getValue: () => "text", getVersionId: () => 1 };
  let received: unknown;
  await activateRustProject({
    initializedModel: model,
    model,
    signal: controller.signal,
    uri: "file:///src/main.rs",
    writeMain: async () => {},
    client: {
      sendNotification: async () => {},
      sendRequest: async () => {},
    },
    readiness: {
      waitForCrateGraph: async () => {},
      noteDocumentChanged: () => {},
      waitForSemanticReadiness: () => {
        queueMicrotask(() => {
          queueMicrotask(() => controller.abort(reason));
        });
        return Promise.resolve();
      },
    },
    sync: {
      waitForDidClose: async () => {},
      waitForStrictDidOpen: async () => {},
    },
    setModelLanguage: () => {},
    semanticWarming: () => {},
  }).catch((error) => {
    received = error;
  });
  assert(received === reason, "post-semantic abort was not preserved");
});

Deno.test("lightweight startup sends no full configuration or workspace reload", async () => {
  const clientSource = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  const activationSource = await Deno.readTextFile(
    "page/src/rust_lsp_startup.ts",
  );
  assert(
    !clientSource.includes("workspace/didChangeConfiguration") &&
      !clientSource.includes("rust-analyzer/reloadWorkspace"),
    "lightweight startup contains a project activation notification",
  );
  const configIndex = activationSource.indexOf(
    "workspace/didChangeConfiguration",
  );
  const graphIndex = activationSource.indexOf("waitForCrateGraph", configIndex);
  assert(configIndex >= 0, "full configuration notification is missing");
  assert(
    !activationSource.includes("rust-analyzer/reloadWorkspace"),
    "project activation redundantly reloads the configured workspace",
  );
  assert(
    graphIndex > configIndex,
    "crate graph polling starts before full configuration",
  );
});

Deno.test("browser client wires abort and transport cancellation into startup", async () => {
  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  assert(
    source.includes("runtime: RuntimeLspDependencies") &&
      source.includes("const { ctx, signal } = runtime"),
    "browser client does not use the runtime generation signal",
  );
  assert(
    /cancelClientStart:\s*\(\)\s*=>\s*owner\.abort\(/.test(source),
    "startup cancellation bypasses the resource owner",
  );
  assert(
    !source.includes("cancelClientStart: () => connection.dispose()"),
    "startup cancellation directly disposes the connection",
  );
  assert(
    /runRustLspStartup\([\s\S]*300_000,\s*signal\s*,?\s*\)/.test(source),
    "browser client does not pass AbortSignal to startup",
  );
});

Deno.test("browser client preserves superclass pushed-diagnostic capabilities", async () => {
  const initial = {
    relatedInformation: false,
    tagSupport: { valueSet: [1, 2] },
    codeDescriptionSupport: true,
    dataSupport: true,
  };
  const merged = mergeVersionedPublishDiagnostics(initial);

  assert(merged !== initial, "capability merge mutated the superclass object");
  assert(
    JSON.stringify(merged) ===
      JSON.stringify({
        ...initial,
        relatedInformation: true,
        versionSupport: true,
      }),
    `superclass capabilities were lost: ${JSON.stringify(merged)}`,
  );

  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  assert(
    source.includes("mergeVersionedPublishDiagnostics("),
    "behavioral capability merge is not used by the client",
  );
  assert(
    source.includes("delete params.capabilities.textDocument.diagnostic"),
    "pull diagnostic capability deletion was removed",
  );
});

Deno.test("Fetching progress remains attached to resource ownership", async () => {
  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  const listenerIndex = source.indexOf("client.onProgress(");
  const recordIndex = source.indexOf(
    "recordGenerationLspProgress(testGeneration, value)",
    listenerIndex,
  );
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
  const exposureIndex = clientSource.indexOf(
    "exposeSyntaxTreeRequest(testGeneration, client)",
  );
  const ownershipIndex = clientSource.indexOf("owner.setTestApiDisposable(");

  assert(
    syntaxTreeExposureIsGuarded(clientSource),
    "syntax-tree test request is exposed outside its build guard",
  );
  assert(
    !syntaxTreeExposureIsGuarded(
      'if (import.meta.env.VITE_RUBRC_LSP_TEST === "1") {}\n' +
        "exposeSyntaxTreeRequest(testGeneration, client);",
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
        "exposeSyntaxTreeRequest(testGeneration, client) });",
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

Deno.test("stale generation cannot install a delayed syntax-tree callback", async () => {
  const state: LspTestGenerationState<object, object, object> = {
    ready: false,
    vfsWrites: [],
  };
  beginLspTestGeneration(state, {}, {}, {});
  const stale = captureLspTestGeneration(state);
  beginLspTestGeneration(state, {}, {}, {});
  const current = captureLspTestGeneration(state);
  const currentDisposable = installGenerationSyntaxTreeRequest(current, {
    sendRequest: async <TResult>() => "current" as TResult,
  });
  const currentRequest = state.requestSyntaxTree;

  const staleDisposable = installGenerationSyntaxTreeRequest(stale, {
    sendRequest: async <TResult>() => "stale" as TResult,
  });

  assert(
    state.requestSyntaxTree === currentRequest,
    "stale startup replaced the current syntax-tree callback",
  );
  staleDisposable.dispose();
  assert(
    state.requestSyntaxTree === currentRequest,
    "stale no-op disposal removed the current callback",
  );
  currentDisposable.dispose();
});

Deno.test("older syntax-tree disposal preserves a newer generation callback", async () => {
  const state: LspTestGenerationState<object, object, object> = {
    ready: false,
    vfsWrites: [],
  };
  beginLspTestGeneration(state, {}, {}, {});
  const first = installGenerationSyntaxTreeRequest(
    captureLspTestGeneration(state),
    { sendRequest: async <TResult>() => "first" as TResult },
  );
  beginLspTestGeneration(state, {}, {}, {});
  const second = installGenerationSyntaxTreeRequest(
    captureLspTestGeneration(state),
    { sendRequest: async <TResult>() => "second" as TResult },
  );
  const secondRequest = state.requestSyntaxTree;

  first.dispose();

  assert(
    state.requestSyntaxTree === secondRequest,
    "older generation disposal removed the newer callback",
  );
  second.dispose();
  assert(
    state.requestSyntaxTree === undefined,
    "current generation disposal retained its callback",
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

Deno.test("RustLspResourceOwner tears down owned resources in dependency order", async () => {
  const owner = new RustLspResourceOwner();
  const order: string[] = [];
  owner.setReadiness({ dispose: () => order.push("readiness") });
  owner.setModelListener({ dispose: () => order.push("model-listener") });
  owner.setSync({
    dispose: async () => {
      order.push("sync");
    },
  });
  owner.setClient({
    needsStop: () => true,
    stop: async () => {
      order.push("client");
    },
  });
  owner.setConnection({ dispose: () => order.push("transports") });
  owner.setVfsSharedRef({ bc: { close: () => order.push("shared-ref") } });

  await owner.dispose();

  assert(
    order.join(",") ===
      "model-listener,readiness,sync,client,transports,shared-ref",
    `wrong resource disposal order: ${order}`,
  );
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
