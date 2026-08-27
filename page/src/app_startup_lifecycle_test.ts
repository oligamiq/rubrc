const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

Deno.test("additional target prefetches before guest load and deduplicates", async () => {
  const module = await import("./app_startup_lifecycle.ts").catch(() => ({}));
  const createLoader = (module as Record<string, unknown>)
    .createAdditionalTargetLoader as
      | ((dependencies: {
        prefetch(
          triples: readonly string[],
          signal: AbortSignal,
        ): Promise<void>;
        load(triple: string): Promise<unknown>;
        signal: AbortSignal;
      }) => { load(triple: string): Promise<void>; loading(): boolean })
      | undefined;
  assert(typeof createLoader === "function", "target loader is missing");
  if (createLoader === undefined) return;

  const order: string[] = [];
  const prefetch = deferred<void>();
  let loads = 0;
  const loader = createLoader({
    prefetch: async (triples) => {
      order.push(`prefetch:${triples.join(",")}`);
      await prefetch.promise;
      order.push("prefetch:complete");
    },
    load: async (triple) => {
      loads++;
      order.push(`load:${triple}`);
    },
    signal: new AbortController().signal,
  });

  const first = loader.load("x86_64-unknown-linux-gnu");
  const duplicate = loader.load("x86_64-unknown-linux-gnu");
  assert(first === duplicate, "duplicate target did not share its operation");
  assert(loader.loading(), "loader did not expose its busy state");
  await Promise.resolve();
  assert(loads === 0, "guest load started before archive prefetch completed");

  prefetch.resolve();
  await first;
  assert(
    order.join(",") ===
      "prefetch:x86_64-unknown-linux-gnu,prefetch:complete,load:x86_64-unknown-linux-gnu",
    `wrong target load order: ${order}`,
  );
  assert(loads === 1, `duplicate target loaded ${loads} times`);
  assert(!loader.loading(), "loader remained busy after settlement");

  await loader.load("x86_64-unknown-linux-gnu");
  assert(loads === 1, "completed target was loaded again");
});

Deno.test("startup target is initially complete and is not reinstalled", async () => {
  const { createAdditionalTargetLoader } = await import(
    "./app_startup_lifecycle.ts"
  );
  let prefetches = 0;
  let loads = 0;
  const loader = createAdditionalTargetLoader({
    prefetch: async () => {
      prefetches++;
    },
    load: async () => {
      loads++;
    },
    signal: new AbortController().signal,
    completed: ["wasm32-wasip1"],
  });

  await loader.load("wasm32-wasip1");
  assert(prefetches === 0, "startup target was prefetched again");
  assert(loads === 0, "startup target was installed again");
});

Deno.test("additional target surfaces prefetch failure and skips guest load", async () => {
  const { createAdditionalTargetLoader } = await import(
    "./app_startup_lifecycle.ts"
  );
  const original = new Error("target archive unavailable");
  let guestLoads = 0;
  const loader = createAdditionalTargetLoader({
    prefetch: () => Promise.reject(original),
    load: async () => {
      guestLoads++;
    },
    signal: new AbortController().signal,
  });

  const caught = await loader.load("aarch64-unknown-linux-gnu").then(
    () => undefined,
    (error) => error,
  );
  assert(caught === original, "target prefetch failure identity was replaced");
  assert(guestLoads === 0, "guest load ran after target prefetch failure");
});

Deno.test("different additional targets serialize their archive streams", async () => {
  const { createAdditionalTargetLoader } = await import(
    "./app_startup_lifecycle.ts"
  );
  const firstLoad = deferred<void>();
  const order: string[] = [];
  const loader = createAdditionalTargetLoader({
    prefetch: async ([triple]) => {
      order.push(`prefetch:${triple}`);
    },
    load: async (triple) => {
      order.push(`load:${triple}:start`);
      if (triple === "first") await firstLoad.promise;
      order.push(`load:${triple}:complete`);
    },
    signal: new AbortController().signal,
  });

  const first = loader.load("first");
  const second = loader.load("second");
  await Promise.resolve();
  await Promise.resolve();
  assert(
    !order.includes("prefetch:second"),
    `second archive raced the first extraction: ${order}`,
  );
  firstLoad.resolve();
  await Promise.all([first, second]);
  assert(
    order.join(",") ===
      "prefetch:first,load:first:start,load:first:complete,prefetch:second,load:second:start,load:second:complete",
    `target loads were not serialized: ${order}`,
  );
});

Deno.test("app cleanup waits for aborted guest settlement before releasing resources", async () => {
  const module = await import("./app_startup_lifecycle.ts");
  const disposeAppStartup = (module as Record<string, unknown>)
    .disposeAppStartup as
      | ((dependencies: {
        disposeCoordinator(): Promise<void>;
        disposeStore(): void;
        disposeChannels(): void;
      }) => Promise<void>)
      | undefined;
  assert(typeof disposeAppStartup === "function", "app cleanup helper missing");
  if (disposeAppStartup === undefined) return;

  const guestSettlement = deferred<void>();
  const order: string[] = [];
  const cleanup = disposeAppStartup({
    disposeCoordinator: async () => {
      order.push("coordinator:abort");
      await guestSettlement.promise;
      order.push("guest:settled");
    },
    disposeStore: () => order.push("store:dispose"),
    disposeChannels: () => order.push("channels:dispose"),
  });
  await Promise.resolve();
  assert(
    order.join(",") === "coordinator:abort",
    `resources released before guest settlement: ${order}`,
  );
  guestSettlement.resolve();
  await cleanup;
  assert(
    order.join(",") ===
      "coordinator:abort,guest:settled,store:dispose,channels:dispose",
    `wrong cleanup order: ${order}`,
  );
});

Deno.test("archive progress subscription remains active through extraction", async () => {
  const module = await import("./app_startup_lifecycle.ts");
  const retainArchiveProgress = (module as Record<string, unknown>)
    .retainArchiveProgress as
      | ((
        source: { subscribe(listener: (event: string) => void): () => void },
        report: (event: string) => void,
      ) => { dispose(): void })
      | undefined;
  assert(
    typeof retainArchiveProgress === "function",
    "archive progress lifetime helper missing",
  );
  if (retainArchiveProgress === undefined) return;

  let listener: ((event: string) => void) | undefined;
  let unsubscribes = 0;
  const events: string[] = [];
  const retained = retainArchiveProgress(
    {
      subscribe(next) {
        listener = next;
        return () => {
          unsubscribes++;
          listener = undefined;
        };
      },
    },
    (event) => events.push(event),
  );

  listener?.("ready");
  listener?.("reading");
  listener?.("complete");
  assert(
    events.join(",") === "ready,reading,complete",
    `extraction progress was lost: ${events}`,
  );
  assert(unsubscribes === 0, "progress unsubscribed before extraction");
  retained.dispose();
  retained.dispose();
  assert(unsubscribes === 1, `progress unsubscribed ${unsubscribes} times`);
});

Deno.test("target loader settlement waits for an accepted extraction after abort", async () => {
  const { createAdditionalTargetLoader } = await import(
    "./app_startup_lifecycle.ts"
  );
  const controller = new AbortController();
  const extraction = deferred<void>();
  let loadStarted = false;
  const loader = createAdditionalTargetLoader({
    prefetch: async () => {},
    load: async () => {
      loadStarted = true;
      await extraction.promise;
    },
    signal: controller.signal,
  });
  const operation = loader.load("wasm32-wasip2").catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert(loadStarted, "target extraction did not start");

  controller.abort(new Error("app disposed"));
  let settled = false;
  const settlement = loader.settle().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert(settled === false, "loader settled before accepted extraction");
  extraction.resolve();
  await Promise.all([operation, settlement]);
  assert(settled, "loader did not settle after extraction");
});

Deno.test("generation abort issues no accepted target follow-up calls", async () => {
  const module = await import("./app_startup_lifecycle.ts");
  const runAcceptedTargetExtraction = (module as Record<string, unknown>)
    .runAcceptedTargetExtraction as
      | ((dependencies: {
        triple: string;
        endpoint(request: unknown): Promise<number>;
        generationSignal: AbortSignal;
        sleep(): Promise<void>;
      }) => Promise<void>)
      | undefined;
  assert(
    typeof runAcceptedTargetExtraction === "function",
    "accepted extraction helper missing",
  );
  if (runAcceptedTargetExtraction === undefined) return;

  const generation = new AbortController();
  const requests: unknown[] = [];
  const operation = runAcceptedTargetExtraction({
    triple: "wasm32-wasip2",
    async endpoint(request) {
      requests.push(request);
      const operation = (request as { operation: string }).operation;
      if (operation === "start") {
        generation.abort(new Error("app disposed"));
        return 41;
      }
      throw new Error(`unexpected post-abort request: ${operation}`);
    },
    generationSignal: generation.signal,
    sleep: async () => {},
  });
  const caught = await operation.then(
    () => undefined,
    (error) => error,
  );
  assert(
    caught === generation.signal.reason,
    "guest settlement replaced generation abort reason",
  );
  assert(
    JSON.stringify(requests) ===
      JSON.stringify([{ operation: "start", triple: "wasm32-wasip2" }]),
    `generation abort issued endpoint calls: ${JSON.stringify(requests)}`,
  );
});

Deno.test("correlated target failure reads error and releases request", async () => {
  const { runAcceptedTargetExtraction } = await import(
    "./app_startup_lifecycle.ts"
  );
  const requests: unknown[] = [];
  let terminalFailures = 0;
  const operation = runAcceptedTargetExtraction({
    triple: "x86_64-unknown-linux-gnu",
    async endpoint(request) {
      requests.push(request);
      const operation = (request as { operation: string }).operation;
      if (operation === "start") return 7;
      if (operation === "state") return 3;
      if (operation === "error") return 1;
      return 1;
    },
    generationSignal: new AbortController().signal,
    onTerminalWorkerFailure: () => terminalFailures++,
    sleep: async () => {},
  });
  const caught = await operation.then(
    () => undefined,
    (error) => error,
  );
  assert(
    caught instanceof Error && caught.message.includes("fetch failed"),
    `wrong guest failure: ${caught}`,
  );
  assert(
    JSON.stringify(requests.slice(-2)) ===
      JSON.stringify([
        { operation: "error", requestId: 7 },
        { operation: "release", requestId: 7 },
      ]),
    `wrong failure cleanup: ${JSON.stringify(requests)}`,
  );
  assert(terminalFailures === 0, "guest-reported failure became fatal");
});

Deno.test("generation abort races state, error, and release transports", async () => {
  const { runAcceptedTargetExtraction } = await import(
    "./app_startup_lifecycle.ts"
  );
  for (const blocked of ["state", "error", "release"] as const) {
    const generation = new AbortController();
    const entered = deferred<void>();
    const transport = deferred<number>();
    const requests: string[] = [];
    let terminalFailures = 0;
    const operation = runAcceptedTargetExtraction({
      triple: "wasm32-wasip2",
      endpoint: async (request) => {
        requests.push(request.operation);
        if (request.operation === "start") return 71;
        if (request.operation === "state") {
          if (blocked === "state") {
            entered.resolve();
            return await transport.promise;
          }
          return blocked === "error" ? 3 : 2;
        }
        if (request.operation === blocked) {
          entered.resolve();
          return await transport.promise;
        }
        return 1;
      },
      generationSignal: generation.signal,
      onTerminalWorkerFailure: () => terminalFailures++,
      sleep: async () => {},
    });
    await entered.promise;
    const reason = new Error(`abort during ${blocked}`);
    generation.abort(reason);
    const caught = await operation.then(
      () => undefined,
      (error) => error,
    );
    assert(caught === reason, `${blocked} transport lost generation abort`);
    assert(terminalFailures === 0, `${blocked} abort became fatal`);
    const requestCount = requests.length;
    transport.reject(new Error(`late ${blocked} rejection`));
    await Promise.resolve();
    assert(
      requests.length === requestCount,
      `${blocked} abort issued another endpoint call`,
    );
  }
});

Deno.test("correlated target timeout releases a pending request", async () => {
  const { runAcceptedTargetExtraction } = await import(
    "./app_startup_lifecycle.ts"
  );
  let now = 0;
  let state = 0;
  const requests: unknown[] = [];
  const caught = await runAcceptedTargetExtraction({
    triple: "wasm32-wasip2",
    async endpoint(request) {
      requests.push(request);
      const operation = (request as { operation: string }).operation;
      if (operation === "start") return 12;
      if (operation === "state") return state;
      if (operation === "cancel") {
        state = 3;
        return 1;
      }
      if (operation === "release") return 1;
      return 4;
    },
    generationSignal: new AbortController().signal,
    timeoutMs: 10,
    now: () => now,
    sleep: async () => {
      now += 10;
    },
  }).then(
    () => undefined,
    (error) => error,
  );
  assert(
    caught instanceof Error && caught.message.includes("timed out"),
    `pending request did not time out: ${caught}`,
  );
  assert(
    JSON.stringify(requests.at(-1)) ===
      JSON.stringify({ operation: "release", requestId: 12 }),
    "timed out request was not released",
  );
});

Deno.test("pending timeout cancellation race waits for guest terminal state", async () => {
  const { runAcceptedTargetExtraction } = await import(
    "./app_startup_lifecycle.ts"
  );
  let now = 0;
  let state = 0;
  let cancels = 0;
  let releases = 0;
  const caught = await runAcceptedTargetExtraction({
    triple: "wasm32-wasip2",
    async endpoint(request) {
      const operation = (request as { operation: string }).operation;
      if (operation === "start") return 13;
      if (operation === "state") return state;
      if (operation === "cancel") {
        cancels++;
        state = 1;
        return 1;
      }
      if (operation === "release") return ++releases;
      return 4;
    },
    generationSignal: new AbortController().signal,
    timeoutMs: 10,
    now: () => now,
    sleep: async () => {
      now += 10;
      if (state === 1) state = 3;
    },
  }).then(
    () => undefined,
    (error) => error,
  );
  assert(
    caught instanceof Error && caught.message.includes("timed out"),
    `cancellation race lost timeout: ${caught}`,
  );
  assert(cancels === 1, `request cancel count was ${cancels}`);
  assert(releases === 1, `request release count was ${releases}`);
});

Deno.test("generation abort wins an accepted transport rejection", async () => {
  const { runAcceptedTargetExtraction } = await import(
    "./app_startup_lifecycle.ts"
  );
  const controller = new AbortController();
  const abortReason = new Error("generation disposed");
  let terminalFailures = 0;
  const caught = await runAcceptedTargetExtraction({
    triple: "wasm32-wasip2",
    async endpoint(request) {
      const operation = (request as { operation: string }).operation;
      if (operation === "start") return 21;
      if (operation === "state") {
        controller.abort(abortReason);
        throw new Error("status transport closed");
      }
      return 1;
    },
    generationSignal: controller.signal,
    onTerminalWorkerFailure: () => terminalFailures++,
    sleep: async () => {},
  }).then(
    () => undefined,
    (error) => error,
  );
  assert(
    caught === abortReason,
    `generation abort was masked by transport failure: ${caught}`,
  );
  assert(terminalFailures === 0, "generation abort became fatal");
});

Deno.test("correlated target rejects a failed terminal release", async () => {
  const { runAcceptedTargetExtraction } = await import(
    "./app_startup_lifecycle.ts"
  );
  const caught = await runAcceptedTargetExtraction({
    triple: "wasm32-wasip2",
    async endpoint(request) {
      const operation = (request as { operation: string }).operation;
      if (operation === "start") return 31;
      if (operation === "state") return 2;
      if (operation === "release") return 0;
      return 0;
    },
    generationSignal: new AbortController().signal,
    sleep: async () => {},
  }).then(
    () => undefined,
    (error) => error,
  );
  assert(
    caught instanceof Error && caught.message.includes("release"),
    `failed release was accepted: ${caught}`,
  );
});

Deno.test("additional sysroot endpoint calls have a bounded transport deadline", async () => {
  const { runAcceptedTargetExtraction } = await import(
    "./app_startup_lifecycle.ts"
  );
  let terminalFailures = 0;
  const caught = await runAcceptedTargetExtraction({
    triple: "wasm32-wasip2",
    endpoint: () => new Promise<number>(() => {}),
    generationSignal: new AbortController().signal,
    transportTimeoutMs: 1,
    onTerminalWorkerFailure() {
      terminalFailures++;
    },
    sleep: async () => {},
  }).then(
    () => undefined,
    (error) => error,
  );
  assert(
    caught instanceof Error && caught.message.includes("transport timed out"),
    `unbounded endpoint call did not fail as transport loss: ${caught}`,
  );
  assert(terminalFailures === 1, `worker terminated ${terminalFailures} times`);
});

Deno.test("accepted endpoint rejection terminates worker before settlement", async () => {
  const { runAcceptedTargetExtraction } = await import(
    "./app_startup_lifecycle.ts"
  );
  const order: string[] = [];
  const caught = await runAcceptedTargetExtraction({
    triple: "wasm32-wasip2",
    async endpoint(request) {
      if (request.operation === "start") return 44;
      order.push("transport:rejected");
      throw new Error("worker channel closed");
    },
    generationSignal: new AbortController().signal,
    onTerminalWorkerFailure() {
      order.push("worker:terminated");
    },
    sleep: async () => {},
  }).then(
    () => undefined,
    (error) => error,
  );
  order.push("loader:settled");
  assert(
    caught instanceof Error && caught.message.includes("worker channel closed"),
    `wrong terminal worker failure: ${caught}`,
  );
  assert(
    order.join(",") === "transport:rejected,worker:terminated,loader:settled",
    `worker was not terminated before settlement: ${order}`,
  );
});
