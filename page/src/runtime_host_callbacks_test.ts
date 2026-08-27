import { Directory } from "@bjorn3/browser_wasi_shim";
import {
  type ChildProcessBridgeOwner,
  createChildProcessBridgeOwner,
} from "../../lib/src/child_process_bridge.ts";
import {
  type HttpBridgeOwner,
  createHttpBridgeOwner,
} from "../../lib/src/http_bridge.ts";
import { createRuntimeHostCallbackOwner } from "./runtime_host_callbacks.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
};

function idleHttpOwner(): HttpBridgeOwner {
  return {
    handle: (() => Promise.resolve({})) as unknown as HttpBridgeOwner["handle"],
    abort: () => {},
    settle: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

function idleChildOwner(): ChildProcessBridgeOwner {
  return {
    handle: (() => Promise.resolve({})) as unknown as ChildProcessBridgeOwner["handle"],
    abort: () => {},
    settle: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

function realDependencies(fetchImpl: typeof fetch = fetch) {
  return {
    http: createHttpBridgeOwner(fetchImpl),
    child: createChildProcessBridgeOwner({
      getWasiRef: () => ({}),
      workerUrl: new URL(
        "./worker_process/vfs_bindings/child_process_worker.ts",
        import.meta.url,
      ),
      filesystemRoot: new Directory(new Map()),
      uploadTimeoutMs: 30_000,
      executionTimeoutMs: 120_000,
      createWorker: () => {
        throw new Error("unexpected child Worker creation");
      },
    }),
  };
}

Deno.test("runtime host owner keeps sysroot and app callbacks synchronous", () => {
  const sysrootResponse = { has_archive: true, data_len: 4 };
  const synchronousResponse = { terminal: "written" };
  const owner = createRuntimeHostCallbackOwner({
    signal: new AbortController().signal,
    sysroot: (message) =>
      (message as { name?: string }).name === "sysrootArchiveGetMeta"
        ? sysrootResponse
        : undefined,
    http: idleHttpOwner(),
    child: idleChildOwner(),
    handleSynchronousMessage: () => synchronousResponse,
  });

  assertEquals(
    owner.handle({ name: "sysrootArchiveGetMeta", args: {} }),
    sysrootResponse,
    "sysroot callback result",
  );
  assertEquals(
    owner.handle({ name: "terminalWrite", args: { data: [] } }),
    synchronousResponse,
    "synchronous app callback result",
  );
});

Deno.test("runtime host owner rejects active and future dispatch after generation abort", async () => {
  const generation = new AbortController();
  const reason = new DOMException("generation replaced", "AbortError");
  let httpCalls = 0;
  let rejectHttp!: (reason: unknown) => void;
  const http: HttpBridgeOwner = {
    handle: () => {
      httpCalls++;
      return new Promise<never>((_resolve, reject) => (rejectHttp = reject));
    },
    abort: (abortReason) => rejectHttp?.(abortReason),
    settle: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
  const owner = createRuntimeHostCallbackOwner({
    signal: generation.signal,
    sysroot: () => undefined,
    http,
    child: idleChildOwner(),
    handleSynchronousMessage: () => {
      throw new Error("unexpected synchronous dispatch");
    },
  });
  const callback = owner.handle({
    name: "httpRequestStart",
    args: { method: [], url: [], headers: [], body: [] },
  });
  assert(callback instanceof Promise, "HTTP callback was not asynchronous");
  void callback.catch(() => undefined);

  generation.abort(reason);
  await owner.settle();

  let activeRejected = false;
  try {
    await callback;
  } catch (error) {
    activeRejected = true;
    assert(
      error === reason,
      "active callback lost the generation abort reason",
    );
  }
  assert(activeRejected, "active callback resolved after generation abort");
  try {
    owner.handle({
      name: "httpRequestStart",
      args: { method: [], url: [], headers: [], body: [] },
    });
  } catch (error) {
    assert(
      error === reason,
      "future callback lost the generation abort reason",
    );
    assertEquals(
      httpCalls,
      1,
      "aborted generation dispatched another callback",
    );
    return;
  }
  throw new Error("aborted generation accepted another callback");
});

Deno.test("runtime host owner removes settled callbacks from tracking", async () => {
  let observations = 0;
  const operation = Promise.resolve({
    request_id: 1,
    status: 200,
    headers_len: 0,
    body_len: 0,
    error_len: 0,
  });
  const originalThen = operation.then.bind(operation);
  operation.then = ((...args: Parameters<typeof operation.then>) => {
    observations++;
    return originalThen(...args);
  }) as typeof operation.then;
  const http: HttpBridgeOwner = {
    handle: (() => operation) as unknown as HttpBridgeOwner["handle"],
    abort: () => {},
    settle: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
  const owner = createRuntimeHostCallbackOwner({
    signal: new AbortController().signal,
    sysroot: () => undefined,
    http,
    child: idleChildOwner(),
    handleSynchronousMessage: () => undefined,
  });

  owner.handle({
    name: "httpRequestStart",
    args: { method: [], url: [], headers: [], body: [] },
  });
  await Promise.resolve();
  await Promise.resolve();
  const observationsAfterSettlement = observations;
  await owner.settle();

  assertEquals(
    observations,
    observationsAfterSettlement,
    "settled callback remained in the tracked set",
  );
});

Deno.test("runtime host owner rejects before first dispatch and disposes once", async () => {
  const generation = new AbortController();
  const reason = { generation: "stale" };
  let fetchCalls = 0;
  const dependencies = realDependencies(() => {
    fetchCalls++;
    return Promise.resolve(new Response());
  });
  generation.abort(reason);
  const owner = createRuntimeHostCallbackOwner({
    signal: generation.signal,
    sysroot: () => undefined,
    ...dependencies,
    handleSynchronousMessage: () => undefined,
  });

  let rejectedWith: unknown;
  try {
    owner.handle({
      name: "httpRequestStart",
      args: { method: [], url: [], headers: [], body: [] },
    });
  } catch (error) {
    rejectedWith = error;
  }
  assert(rejectedWith === reason, "pre-start abort reason identity changed");
  assertEquals(fetchCalls, 0, "pre-start abort reached Fetch");

  const firstDispose = owner.dispose();
  const secondDispose = owner.dispose();
  assert(firstDispose === secondDispose, "runtime disposal Promise changed");
  await firstDispose;
});

for (const outcome of ["resolve", "reject"] as const) {
  Deno.test(`runtime owner settles an HTTP ${outcome} concurrent with disposal`, async () => {
    let resolveFetch!: (response: Response) => void;
    let rejectFetch!: (reason: unknown) => void;
    let seenSignal: AbortSignal | undefined;
    const dependencies = realDependencies((_input, init) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve;
        rejectFetch = reject;
      });
    });
    const owner = createRuntimeHostCallbackOwner({
      signal: new AbortController().signal,
      sysroot: () => undefined,
      ...dependencies,
      handleSynchronousMessage: () => undefined,
    });
    const pending = owner.handle({
      name: "httpRequestStart",
      args: {
        method: Array.from(new TextEncoder().encode("GET")),
        url: Array.from(new TextEncoder().encode("https://example.test")),
        headers: [],
        body: [],
      },
    });
    assert(pending instanceof Promise, "runtime HTTP callback was synchronous");
    void pending.catch(() => undefined);
    const disposing = owner.dispose();
    const disposalReason = seenSignal?.reason;

    if (outcome === "resolve") {
      resolveFetch(new Response(new Uint8Array([1])));
    } else {
      rejectFetch(new Error("network failed during runtime disposal"));
    }
    await disposing;

    let rejectedWith: unknown;
    try {
      await pending;
    } catch (error) {
      rejectedWith = error;
    }
    assert(
      rejectedWith === disposalReason,
      `${outcome} concurrent with runtime disposal changed the reason`,
    );
  });
}

Deno.test("runtime owner observes dependency disposal rejection", async () => {
  const dependencyError = new Error("dependency disposal failed");
  let disposeCalls = 0;
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const http: HttpBridgeOwner = {
      ...idleHttpOwner(),
      dispose: () => {
        disposeCalls++;
        return Promise.reject(dependencyError);
      },
    };
    const owner = createRuntimeHostCallbackOwner({
      signal: new AbortController().signal,
      sysroot: () => undefined,
      http,
      child: idleChildOwner(),
      handleSynchronousMessage: () => undefined,
    });

    await owner.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(disposeCalls, 1, "dependency disposal call count");
    assertEquals(unhandled, 0, "dependency rejection was unhandled");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("runtime host owner preserves a synchronous app delegate throw", async () => {
  const thrown = { app: "failed" };
  const dependencies = realDependencies(() =>
    Promise.resolve(new Response())
  );
  const owner = createRuntimeHostCallbackOwner({
    signal: new AbortController().signal,
    sysroot: () => undefined,
    ...dependencies,
    handleSynchronousMessage: () => {
      throw thrown;
    },
  });

  let caught: unknown;
  try {
    owner.handle({ name: "terminalWrite", args: { data: [] } });
  } catch (error) {
    caught = error;
  }
  assert(caught === thrown, "synchronous delegate throw was changed");
  await owner.dispose();
});
