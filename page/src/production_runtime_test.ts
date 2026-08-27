import { test } from "bun:test";
import { RuntimeSupervisor } from "./app_runtime.ts";
import * as productionRuntime from "./production_runtime.ts";
import {
  createProductionRuntimeDependencies,
  writeFarmTerminal,
} from "./production_runtime.ts";
import type { RuntimeWorkerHandshake } from "./runtime_worker_protocol.ts";
import { workspaceFileSystem } from "./workspace_fs.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test("partial production bridge cleanup is aborted and runtime-settled", async () => {
  const primary = new Error("child bridge construction failed");
  const cleanupError = new Error("HTTP bridge disposal failed");
  const cleanup = deferred<void>();
  let aborted = 0;
  let disposeCalls = 0;
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const dependencies = createProductionRuntimeDependencies(
      {
        workspaceFileSystem,
        utilityWorkerUrl: "unused-utility-worker.js",
        lifecycleWorkerUrl: "unused-lifecycle-worker.js",
        childProcessWorkerUrl: "unused-child-worker.js",
      },
      {
        createHttpBridgeOwner: () => ({
          handle: (() => Promise.resolve({})) as never,
          abort: () => {
            aborted++;
          },
          settle: () => cleanup.promise,
          dispose: () => {
            disposeCalls++;
            return cleanup.promise;
          },
        }),
        createChildProcessBridgeOwner: () => {
          throw primary;
        },
      },
    );
    dependencies.teardownTimeoutMs = 100;
    const runtime = await new RuntimeSupervisor(dependencies).create();
    let settled = false;
    const starting = runtime.start().catch((error) => error).finally(() => {
      settled = true;
    });

    assert(aborted === 1, `partial owner aborted ${aborted} times`);
    assert(disposeCalls === 1, `partial owner disposed ${disposeCalls} times`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(!settled, "runtime released before partial cleanup confirmation");

    cleanup.reject(cleanupError);
    const error = await starting;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert(error instanceof AggregateError, "cleanup rejection was not aggregated");
    assert(error.cause === primary, "partial construction primary was replaced");
    assert(runtime.phase === "disposed", "settled partial cleanup quarantined runtime");
    assert(unhandled === 0, "partial cleanup rejection was unhandled");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

test("forced destroy timeout still starts Animal disposal but withholds acknowledgement", async () => {
  let initializeCalls = 0;
  let disposeCalls = 0;
  const handshake: RuntimeWorkerHandshake = {
    initialize: async () => {
      initializeCalls++;
    },
    dispose: async () => {
      disposeCalls++;
    },
  };
  const module = productionRuntime as unknown as {
    wrapRuntimeWorkerHandshakeForTest(
      handshake: RuntimeWorkerHandshake,
      forceTimeout: () => boolean,
    ): RuntimeWorkerHandshake;
  };
  const forced = module.wrapRuntimeWorkerHandshakeForTest(
    handshake,
    () => true,
  );
  await forced.initialize({} as never, {} as never);
  const disposal = forced.dispose();
  let settled = false;
  void disposal.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();

  assert(initializeCalls === 1, "wrapped handshake skipped initialization");
  assert(disposeCalls === 1, "forced timeout skipped Animal destroy request");
  assert(!settled, "forced timeout acknowledged Animal destruction");

  const ordinary = module.wrapRuntimeWorkerHandshakeForTest(
    handshake,
    () => false,
  );
  await ordinary.dispose();
  assert(disposeCalls === 2, "ordinary wrapper did not settle disposal");
});

test("farm terminal writes are dropped after the generation data plane detaches", () => {
  const writes: Array<{ sessionId: number; data: Uint8Array; error: boolean }> = [];
  const terminal = {
    write(sessionId: number, data: Uint8Array, error: boolean) {
      writes.push({ sessionId, data, error });
    },
  };
  const data = new Uint8Array([1, 2, 3]);

  const attached = writeFarmTerminal(false, terminal, 7, data, true);
  const detached = writeFarmTerminal(true, terminal, 7, data, true);

  assert(writes.length === 1, `terminal received ${writes.length} writes`);
  assert(writes[0].sessionId === 7, "attached write used the wrong session");
  assert(writes[0].data === data, "attached write copied the byte buffer");
  assert(writes[0].error, "attached write lost the stderr flag");
  assert(attached.ret === 0 && attached.nwritten === 3, "attached write failed");
  assert(detached.ret === 0 && detached.nwritten === 3, "detached write failed");
});
