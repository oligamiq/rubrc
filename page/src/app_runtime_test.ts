import {
  type AppRuntime,
  type AppRuntimeDependencies,
  type AppRuntimeState,
  ReloadRequiredError,
  RuntimeSupervisor,
} from "./app_runtime.ts";
import type { Ctx } from "./ctx.ts";
import type { RuntimeSharedObjectFactories } from "./runtime_command_service.ts";
import type { RuntimeHostCallbackOwner } from "./runtime_host_callbacks.ts";
import type {
  RuntimeWorkerEndpoint,
  RuntimeWorkerHandshake,
} from "./runtime_worker_protocol.ts";
import { createRuntimeWorkerHandshake } from "./runtime_worker_protocol.ts";
import { RustLspResourceOwner } from "./rust_lsp_client_dispose.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualValue = JSON.stringify(actual);
  const expectedValue = JSON.stringify(expected);
  if (actualValue !== expectedValue) {
    throw new Error(
      `${message}: expected ${expectedValue}, got ${actualValue}`,
    );
  }
}

async function captureReject(operation: Promise<unknown>, message: string) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error(message);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeWorker extends EventTarget implements RuntimeWorkerEndpoint {
  readonly posted: unknown[] = [];
  terminateCalls = 0;

  constructor(
    private readonly label: string,
    private readonly events: string[],
  ) {
    super();
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminateCalls++;
    this.events.push(`${this.label}-worker-terminated`);
  }
}

type HarnessOptions = {
  callbacks?: Promise<void>;
  destroy?: Promise<void>;
  startup?: Promise<void>;
  coordinatorDispose?: Promise<void>;
  failFactory?:
    | "ctx"
    | "store"
    | "terminal"
    | "parser"
    | "commands"
    | "channels"
    | "callbacks"
    | "farm"
    | "utility"
    | "lifecycle"
    | "handshake";
  targetEndpoint?: (request: {
    operation: string;
    triple?: string;
    requestId?: number;
  }) => Promise<number>;
  prefetch?: (triples: readonly string[], signal: AbortSignal) => Promise<void>;
  run?: (triple?: string) => Promise<void>;
  timeoutMs?: number;
  onStartFactoryAcquired?: (
    factory: "callbacks" | "farm" | "utility" | "lifecycle" | "handshake",
  ) => void;
};

function context(generation: number): Ctx {
  const id = (name: string) => `${name}-${generation}`;
  return {
    terminal_id: id("terminal"),
    waiter_id: id("waiter"),
    cmd_parser_id: id("parser"),
    tree_id: id("tree"),
    ls_id: id("ls"),
    exec_file_id: id("exec"),
    load_additional_sysroot_id: id("target"),
    install_startup_sysroots_id: id("startup"),
    input_char_id: id("char"),
    input_string_id: id("string"),
    interrupt_id: id("interrupt"),
    resize_id: id("resize"),
    get_terminal_size_id: id("size"),
    create_session_id: id("create-session"),
    vfs_ready_id: id("ready"),
    close_session_id: id("close-session"),
  };
}

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const stores: Array<{
    disposed: boolean;
    prefetch(triples: readonly string[], signal: AbortSignal): Promise<void>;
    dispose(): void;
  }> = [];
  const farms: Array<{ destroyed: boolean; destroy(): void }> = [];
  const terminals: Array<{
    disposed: boolean;
    attaches: number;
    attach(): { dispose(): void };
    write(): void;
    size(): { cols: number; rows: number };
    out(): string;
    error(): string;
    dispose(): void;
  }> = [];
  const parsers: Array<{ ready: Promise<void>; dispose(): void }> = [];
  const commands: Array<{
    run(triple?: string): Promise<void>;
    download(): Promise<void>;
    dispose(): void;
  }> = [];
  const utilityWorkers: FakeWorker[] = [];
  const lifecycleWorkers: FakeWorker[] = [];
  const handshakes: RuntimeWorkerHandshake[] = [];
  const workerFatalReporters: Array<(error: Error) => void> = [];
  const hostCallbacks: Array<RuntimeHostCallbackOwner & { disposed: boolean }> =
    [];
  const channelOwners: Array<{
    added: unknown[];
    disposed: boolean;
    add<T>(channel: T): T;
    dispose(): void;
  }> = [];
  const cleared: string[] = [];
  const proxyCalls: Array<{ id: string; args: unknown[] }> = [];
  let generation = 0;
  const workspaceFileSystem = {};
  const farmWorkspaces: unknown[] = [];
  const sharedObjectFactories: RuntimeSharedObjectFactories = {
    createSharedObject: (_value, id) => ({ id, kind: "object" }),
    createSharedObjectRef: (id) => ({
      id,
      kind: "ref",
      proxy: <T>() =>
        ((...args: unknown[]) => {
          proxyCalls.push({ id, args });
          return Promise.resolve();
        }) as T,
    }),
  };

  const fail = (name: HarnessOptions["failFactory"]) => {
    if (options.failFactory === name) throw new Error(`${name} failed`);
  };

  const dependencies: AppRuntimeDependencies = {
    teardownTimeoutMs: options.timeoutMs ?? 20,
    createGeneration: () => `generation-${++generation}`,
    workspaceFileSystem,
    createCtx: () => {
      fail("ctx");
      return context(generation);
    },
    createArchiveStore: () => {
      fail("store");
      const store = {
        disposed: false,
        prefetch: options.prefetch ?? (() => Promise.resolve()),
        dispose() {
          this.disposed = true;
          events.push("store-disposed");
        },
      };
      stores.push(store);
      return store;
    },
    createTerminalService: () => {
      fail("terminal");
      const terminal = {
        disposed: false,
        attaches: 0,
        attach() {
          this.attaches++;
          return { dispose() {} };
        },
        write() {},
        size: () => ({ cols: 80, rows: 24 }),
        out: () => "",
        error: () => "",
        dispose() {
          this.disposed = true;
        },
      };
      terminals.push(terminal);
      return terminal;
    },
    createParserService: () => {
      fail("parser");
      const parser = { ready: Promise.resolve(), dispose() {} };
      parsers.push(parser);
      return parser;
    },
    createCommandService: () => {
      fail("commands");
      const command = {
        run: (triple?: string) => options.run?.(triple) ?? Promise.resolve(),
        download: () => Promise.resolve(),
        dispose() {},
      };
      commands.push(command);
      return command;
    },
    createChannelOwner: () => {
      fail("channels");
      const owner = {
        added: [] as unknown[],
        disposed: false,
        add<T>(channel: T): T {
          this.added.push(channel);
          return channel;
        },
        dispose() {
          this.disposed = true;
          events.push("channels-disposed");
        },
      };
      channelOwners.push(owner);
      return owner;
    },
    sharedObjectFactories,
    createHostCallbacks: ({ signal }) => {
      fail("callbacks");
      signal.addEventListener(
        "abort",
        () => events.push("generation-aborted"),
        { once: true },
      );
      let disposePromise: Promise<void> | undefined;
      const owner = {
        disposed: false,
        handle: () => undefined,
        abort: () => events.push("host-producers-aborted"),
        settle: () => options.callbacks ?? Promise.resolve(),
        dispose() {
          if (!disposePromise) {
            disposePromise = (options.callbacks ?? Promise.resolve()).then(
              () => {
                owner.disposed = true;
                events.push("host-callbacks-settled");
              },
              (error) => {
                throw error;
              },
            );
          }
          return disposePromise;
        },
      };
      hostCallbacks.push(owner);
      options.onStartFactoryAcquired?.("callbacks");
      return owner;
    },
    createFarm: ({ workspaceFileSystem: workspace }) => {
      fail("farm");
      farmWorkspaces.push(workspace);
      const farm = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
          events.push("farm-destroyed");
        },
      };
      farms.push(farm);
      const resources = {
        farm,
        wasiRef: {} as Parameters<RuntimeWorkerHandshake["initialize"]>[0],
        detachDataPlane: () => events.push("data-plane-detached"),
      };
      options.onStartFactoryAcquired?.("farm");
      return resources;
    },
    createUtilityWorker: () => {
      fail("utility");
      const worker = new FakeWorker("utility", events);
      utilityWorkers.push(worker);
      options.onStartFactoryAcquired?.("utility");
      return worker;
    },
    createLifecycleWorker: () => {
      fail("lifecycle");
      const worker = new FakeWorker("lifecycle", events);
      lifecycleWorkers.push(worker);
      options.onStartFactoryAcquired?.("lifecycle");
      return worker;
    },
    createWorkerHandshake: ({ onFatalError }) => {
      fail("handshake");
      let disposePromise: Promise<void> | undefined;
      const handshake: RuntimeWorkerHandshake = {
        initialize: () => options.startup ?? Promise.resolve(),
        dispose() {
          if (!disposePromise) {
            events.push("animal-destroy-requested");
            disposePromise = (options.destroy ?? Promise.resolve()).then(() => {
              events.push("animal-destroyed");
            });
          }
          return disposePromise;
        },
      };
      handshakes.push(handshake);
      workerFatalReporters.push(onFatalError);
      options.onStartFactoryAcquired?.("handshake");
      return handshake;
    },
    targetEndpoint: options.targetEndpoint,
    clearRegistrations: (runtimeGeneration) => {
      cleared.push(runtimeGeneration);
      events.push("registrations-cleared");
    },
    operationsSettled: () => events.push("operations-settled"),
  };

  return {
    events,
    stores,
    farms,
    terminals,
    parsers,
    commands,
    utilityWorkers,
    lifecycleWorkers,
    handshakes,
    workerFatalReporters,
    hostCallbacks,
    channelOwners,
    workspaceFileSystem,
    farmWorkspaces,
    cleared,
    proxyCalls,
    dependencies,
    supervisor: new RuntimeSupervisor(dependencies),
  };
}

Deno.test("supervisor creates fresh generation resources and waits for ordinary teardown", async () => {
  const destroy = deferred<void>();
  const harness = createHarness({ destroy: destroy.promise });
  const first = await harness.supervisor.create();
  await first.start();
  const disposing = first.dispose();
  const next = harness.supervisor.create();
  let nextSettled = false;
  void next.finally(() => {
    nextSettled = true;
  });
  await tick();

  assert(!nextSettled, "new generation overlapped ordinary teardown");
  destroy.resolve();
  await disposing;
  const second = await next;
  await second.start();

  assert(first !== second, "runtime instance was reused");
  assert(first.ctx !== second.ctx, "Ctx was reused");
  assert(first.archiveStore !== second.archiveStore, "store was reused");
  assert(first.terminal !== second.terminal, "terminal service was reused");
  assert(
    harness.parsers[0] !== harness.parsers[1],
    "parser service was reused",
  );
  assert(
    harness.commands[0] !== harness.commands[1],
    "command service was reused",
  );
  assert(
    harness.channelOwners[0] !== harness.channelOwners[1],
    "channel owner was reused",
  );
  assert(
    harness.hostCallbacks[0] !== harness.hostCallbacks[1],
    "host callback owner was reused",
  );
  assert(harness.farms[0] !== harness.farms[1], "farm was reused");
  assert(
    harness.utilityWorkers[0] !== harness.utilityWorkers[1],
    "utility worker was reused",
  );
  assert(
    harness.lifecycleWorkers[0] !== harness.lifecycleWorkers[1],
    "lifecycle worker was reused",
  );
  assert(
    harness.handshakes[0] !== harness.handshakes[1],
    "worker handshake was reused",
  );
  assertEquals(
    harness.farmWorkspaces,
    [harness.workspaceFileSystem, harness.workspaceFileSystem],
    "persistent workspace identity changed between generations",
  );
  assertEquals(first.generation, "generation-1", "first generation token");
  assertEquals(second.generation, "generation-2", "second generation token");
  await second.dispose();
});

Deno.test("runtime start and coordinator adoption are synchronous one-shot gates", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  const coordinator = { dispose: () => Promise.resolve() };
  runtime.adoptCoordinator(coordinator);

  let adoptionError: unknown;
  try {
    runtime.adoptCoordinator({ dispose: () => Promise.resolve() });
  } catch (error) {
    adoptionError = error;
  }
  assert(adoptionError instanceof Error, "duplicate coordinator was accepted");

  await runtime.start();
  const startError = await captureReject(
    runtime.start(),
    "duplicate start resolved",
  );
  assert(
    startError instanceof Error &&
      startError.message.includes("already started"),
    "duplicate start error was not visible",
  );
  await runtime.dispose();
});

Deno.test("terminal remount reuses the runtime terminal service", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  await runtime.start();

  runtime
    .attachTerminal(4, { write() {}, size: () => ({ cols: 80, rows: 24 }) })
    .dispose();
  runtime
    .attachTerminal(4, { write() {}, size: () => ({ cols: 80, rows: 24 }) })
    .dispose();

  assertEquals(harness.terminals.length, 1, "terminal service was recreated");
  assertEquals(harness.terminals[0].attaches, 2, "terminal was not remounted");
  await runtime.dispose();
});

Deno.test("terminal remount does not acquire runtime channels", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  const channelsAtCreation = harness.channelOwners[0].added.length;

  await runtime.resizeTerminal(0, 80, 24);
  await runtime.resizeTerminal(0, 100, 30);

  assertEquals(
    harness.proxyCalls.filter((call) => call.id.includes("resize")).length,
    0,
    "pre-ready terminal resize entered the worker transport",
  );
  await runtime.start();
  await runtime.resizeTerminal(0, 120, 40);

  assertEquals(channelsAtCreation, 6, "terminal channels were not preowned");
  assertEquals(
    harness.channelOwners[0].added.length,
    channelsAtCreation,
    "terminal remount acquired more channels",
  );
  await runtime.dispose();
});

Deno.test("runtime state counts resources at actual acquisition and ordinary release", async () => {
  const startup = deferred<void>();
  const harness = createHarness({ startup: startup.promise });
  const runtime = await harness.supervisor.create();
  const snapshots: AppRuntimeState[] = [];
  runtime.subscribe((state) => snapshots.push(state));

  assertEquals(
    {
      utilityWorkers: runtime.state.utilityWorkers,
      lifecycleWorkers: runtime.state.lifecycleWorkers,
      farmCallbacks: runtime.state.farmCallbacks,
    },
    { utilityWorkers: 0, lifecycleWorkers: 0, farmCallbacks: 0 },
    "created runtime synthesized resources before acquisition",
  );

  const starting = runtime.start();
  assertEquals(
    {
      utilityWorkers: runtime.state.utilityWorkers,
      lifecycleWorkers: runtime.state.lifecycleWorkers,
      farmCallbacks: runtime.state.farmCallbacks,
    },
    { utilityWorkers: 1, lifecycleWorkers: 1, farmCallbacks: 1 },
    "starting runtime did not publish acquired resources",
  );
  startup.resolve();
  await starting;
  await runtime.dispose();

  assertEquals(
    {
      utilityWorkers: runtime.state.utilityWorkers,
      lifecycleWorkers: runtime.state.lifecycleWorkers,
      farmCallbacks: runtime.state.farmCallbacks,
    },
    { utilityWorkers: 0, lifecycleWorkers: 0, farmCallbacks: 0 },
    "ordinary teardown retained live resource counts",
  );
  assert(
    Math.max(...snapshots.map((state) => state.utilityWorkers)) === 1 &&
      Math.max(...snapshots.map((state) => state.lifecycleWorkers)) === 1 &&
      Math.max(...snapshots.map((state) => state.farmCallbacks)) === 1,
    "runtime state cannot detect duplicate resource acquisition",
  );
});

Deno.test("quarantine reports retained callbacks but hard-stopped workers", async () => {
  const harness = createHarness({
    callbacks: new Promise<void>(() => {}),
    timeoutMs: 5,
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();

  await captureReject(runtime.dispose(), "callback deadline resolved");

  assert(runtime.phase === "reload-required", "callback timeout did not quarantine");
  assertEquals(
    {
      utilityWorkers: runtime.state.utilityWorkers,
      lifecycleWorkers: runtime.state.lifecycleWorkers,
      farmCallbacks: runtime.state.farmCallbacks,
    },
    { utilityWorkers: 0, lifecycleWorkers: 0, farmCallbacks: 1 },
    "quarantine resource counts lost retained/hard-stopped semantics",
  );
});

Deno.test("confirmed teardown follows the binding safety order", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  runtime.adoptCoordinator({ dispose: () => Promise.resolve() });
  await runtime.start();
  harness.events.length = 0;

  await runtime.dispose();

  assertEquals(
    harness.events,
    [
      "data-plane-detached",
      "generation-aborted",
      "host-producers-aborted",
      "host-callbacks-settled",
      "animal-destroy-requested",
      "animal-destroyed",
      "utility-worker-terminated",
      "lifecycle-worker-terminated",
      "operations-settled",
      "farm-destroyed",
      "channels-disposed",
      "store-disposed",
      "registrations-cleared",
    ],
    "teardown order",
  );
});

Deno.test("runtime publishes the confirmed teardown order for lifecycle acceptance", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  runtime.adoptCoordinator({ dispose: () => Promise.resolve() });
  const lifecycle: string[] = [];
  const unsubscribe = (runtime as AppRuntime & {
    subscribeLifecycle(listener: (event: string) => void): () => void;
  }).subscribeLifecycle((event) => lifecycle.push(event));
  await runtime.start();

  await runtime.dispose();
  unsubscribe();

  assertEquals(
    lifecycle,
    [
      "data-plane-detached",
      "generation-aborted",
      "host-producers-aborted",
      "host-callbacks-settled",
      "animal-destroy-requested",
      "animal-destroyed",
      "utility-worker-terminated",
      "lifecycle-worker-terminated",
      "operations-settled",
      "farm-destroyed",
      "owners-disposed",
      "store-disposed",
      "registrations-cleared",
      "disposed",
    ],
    "published teardown order",
  );
});

Deno.test("dispose before Animal construction cleans normally", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();

  await runtime.dispose();

  assertEquals(
    harness.handshakes.length,
    0,
    "worker handshake was constructed",
  );
  assert(harness.stores[0].disposed, "store was retained without an Animal");
  assertEquals(
    harness.events.includes("animal-destroy-requested"),
    false,
    "destroy was requested without an Animal",
  );
  const next = await harness.supervisor.create();
  await next.dispose();
});

for (const boundary of ["error", "messageerror", "fatal"] as const) {
  Deno.test(`startup ${boundary} becomes one fatal transition`, async () => {
    const startup = deferred<void>();
    const harness = createHarness({ startup: startup.promise });
    const runtime = await harness.supervisor.create();
    const failure = new Error(`${boundary} worker failure`);
    const start = runtime.start();
    startup.reject(failure);

    const startError = await captureReject(start, "startup failure resolved");
    const disposalError = await captureReject(
      runtime.dispose(),
      "fatal disposal resolved",
    );

    assert(startError === failure, "startup replaced the primary failure");
    assert(disposalError === failure, "disposal replaced the primary failure");
    assertEquals(harness.cleared.length, 1, "fatal transition cleaned twice");
  });
}

Deno.test("new operations reject as soon as disposal starts", async () => {
  const destroy = deferred<void>();
  const harness = createHarness({ destroy: destroy.promise });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const disposal = runtime.dispose();

  const error = await captureReject(
    runtime.loadTarget("wasm32-wasip2"),
    "disposing runtime accepted a target",
  );
  assert(
    error instanceof DOMException && error.message.includes("runtime disposed"),
    "operation did not use the generation abort reason",
  );
  destroy.resolve();
  await disposal;
});

Deno.test("run flushes before dispatch and rejects duplicate or target admission", async () => {
  const flush = deferred<void>();
  const order: string[] = [];
  const harness = createHarness({
    run: async (triple) => {
      order.push(`run:${triple}`);
    },
    targetEndpoint: async () => 1,
  });
  const runtime = await harness.supervisor.create();
  runtime.adoptCoordinator({
    flush: async () => {
      order.push("flush:start");
      await flush.promise;
      order.push("flush:complete");
    },
    dispose: () => Promise.resolve(),
  });
  await runtime.start();
  const states: AppRuntimeState[] = [];
  const unsubscribe = runtime.subscribe((state) => states.push(state));

  const first = runtime.run("wasm32-wasip1");
  await Promise.resolve();
  assertEquals(order, ["flush:start"], "run dispatched before flush");
  const duplicateError = await captureReject(
    runtime.run(),
    "duplicate run was accepted",
  );
  assert(
    duplicateError instanceof Error &&
      duplicateError.message === "runtime busy: run",
    `wrong duplicate run error: ${duplicateError}`,
  );
  const targetError = await captureReject(
    runtime.loadTarget("wasm32-wasip2"),
    "target during run was accepted",
  );
  assert(
    targetError instanceof Error && targetError.message === "runtime busy: run",
    `wrong run/target overlap error: ${targetError}`,
  );
  flush.resolve();
  await first;

  assertEquals(
    order,
    ["flush:start", "flush:complete", "run:wasm32-wasip1"],
    "flush did not precede command dispatch",
  );
  assertEquals(
    states.map((state) => state.operation),
    ["idle", "run", "idle"],
    "run operation transitions were not observable",
  );
  unsubscribe();
  await runtime.dispose();
});

Deno.test("workspace flush delegates to the adopted coordinator", async () => {
  let flushes = 0;
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  runtime.adoptCoordinator({
    flush: async () => {
      flushes++;
    },
    dispose: () => Promise.resolve(),
  });
  await runtime.start();

  await runtime.flushWorkspace();

  assertEquals(flushes, 1, "workspace flush did not reach document sync");
  await runtime.dispose();
});

Deno.test("targets serialize with stable identity and persistent status", async () => {
  const firstState = deferred<number>();
  const firstStateRequested = deferred<void>();
  const events: string[] = [];
  const requestIds = new Map<string, number>([
    ["wasm32-wasip2", 41],
    ["wasm32-unknown-unknown", 42],
  ]);
  const harness = createHarness({
    prefetch: async ([triple]) => {
      events.push(`prefetch:${triple}`);
    },
    targetEndpoint: async (request) => {
      if (request.operation === "start") {
        events.push(`extract:${request.triple}`);
        return requestIds.get(request.triple!)!;
      }
      if (request.operation === "state" && request.requestId === 41) {
        firstStateRequested.resolve();
        return await firstState.promise;
      }
      if (request.operation === "state") return 2;
      if (request.operation === "release") return 1;
      throw new Error(`unexpected target request: ${request.operation}`);
    },
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  let state!: AppRuntimeState;
  const unsubscribe = runtime.subscribe((next) => {
    state = next;
  });

  const first = runtime.loadTarget("wasm32-wasip2");
  assert(
    runtime.loadTarget("wasm32-wasip2") === first,
    "duplicate target did not return the identical Promise",
  );
  const second = runtime.loadTarget("wasm32-unknown-unknown");
  await firstStateRequested.promise;
  const runError = await captureReject(
    runtime.run(),
    "run during queued target was accepted",
  );
  assert(
    runError instanceof Error && runError.message === "runtime busy: target",
    `wrong target/run overlap error: ${runError}`,
  );
  assert(
    state.selectedTarget === "wasm32-unknown-unknown",
    "selected target did not follow the latest user choice",
  );
  assert(
    state.activeTarget === "wasm32-wasip2",
    "active target did not remain the extracting target",
  );
  assertEquals(
    state.queuedTargets,
    ["wasm32-wasip2", "wasm32-unknown-unknown"],
    "target queue snapshot was wrong",
  );
  assertEquals(
    events,
    ["prefetch:wasm32-wasip2", "extract:wasm32-wasip2"],
    "second target overlapped the first",
  );

  firstState.resolve(2);
  await Promise.all([first, second]);
  assertEquals(
    state.completedTargets,
    ["wasm32-wasip1", "wasm32-wasip2", "wasm32-unknown-unknown"],
    "completed targets were not retained",
  );
  assert(state.operation === "idle", "target queue did not restore idle");
  await runtime.loadTarget("wasm32-wasip2");
  assert(
    events.filter((event) => event === "extract:wasm32-wasip2").length === 1,
    "completed target was extracted again",
  );
  unsubscribe();
  await runtime.dispose();
});

Deno.test("target status publication cannot reenter an admission gap", async () => {
  let extractions = 0;
  const harness = createHarness({
    targetEndpoint: async (request) => {
      if (request.operation === "start") {
        extractions++;
        return 43;
      }
      if (request.operation === "state") return 2;
      if (request.operation === "release") return 1;
      throw new Error(`unexpected request: ${request.operation}`);
    },
  });
  const runtime = await harness.supervisor.create();
  runtime.adoptCoordinator({
    flush: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  });
  await runtime.start();
  let reentered = false;
  let duplicate!: Promise<void>;
  let run!: Promise<void>;
  runtime.subscribe((state) => {
    if (state.selectedTarget !== "wasm32-wasip2" || reentered) return;
    reentered = true;
    run = runtime.run();
    duplicate = runtime.loadTarget("wasm32-wasip2");
  });

  const first = runtime.loadTarget("wasm32-wasip2");
  const runError = await captureReject(run, "reentrant run was admitted");
  await Promise.all([first, duplicate]);
  assert(duplicate === first, "reentrant duplicate changed Promise identity");
  assert(
    runError instanceof Error && runError.message === "runtime busy: target",
    `reentrant run saw an admission gap: ${runError}`,
  );
  assert(extractions === 1, `reentrant target extracted ${extractions} times`);
  await runtime.dispose();
});

Deno.test("throwing target subscriber cannot interrupt admission or later subscribers", async () => {
  const terminalState = deferred<number>();
  const stateRequested = deferred<void>();
  const harness = createHarness({
    targetEndpoint: async (request) => {
      if (request.operation === "start") return 44;
      if (request.operation === "state") {
        stateRequested.resolve();
        return await terminalState.promise;
      }
      if (request.operation === "release") return 1;
      throw new Error(`unexpected request: ${request.operation}`);
    },
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const listenerFailure = new Error("target subscriber failed");
  let shouldThrow = true;
  runtime.subscribe((state) => {
    if (state.selectedTarget === "wasm32-wasip2" && shouldThrow) {
      throw listenerFailure;
    }
  });
  const healthySnapshots: AppRuntimeState[] = [];
  runtime.subscribe((state) => healthySnapshots.push(state));
  const originalConsoleError = console.error;
  let reports = 0;
  console.error = () => {
    reports++;
    throw new Error("subscriber reporter failed");
  };
  let first: Promise<void> | undefined;
  let synchronousError: unknown;
  try {
    try {
      first = runtime.loadTarget("wasm32-wasip2");
    } catch (error) {
      synchronousError = error;
      shouldThrow = false;
    }
    const duplicate = runtime.loadTarget("wasm32-wasip2");
    await stateRequested.promise;
    terminalState.resolve(2);
    await duplicate;

    assert(synchronousError === undefined, "subscriber escaped loadTarget");
    assert(
      first === duplicate,
      "subscriber changed installed Promise identity",
    );
    assert(reports === 1, `subscriber failure was reported ${reports} times`);
    assert(
      healthySnapshots.some(
        (state) =>
          state.operation === "target" &&
          state.selectedTarget === "wasm32-wasip2",
      ),
      "later subscriber missed target snapshot",
    );
  } finally {
    console.error = originalConsoleError;
    await runtime.dispose();
  }
});

Deno.test("guest target failure restores ready idle without becoming fatal", async () => {
  const harness = createHarness({
    targetEndpoint: async (request) => {
      if (request.operation === "start") return 51;
      if (request.operation === "state") return 3;
      if (request.operation === "error") return 1;
      if (request.operation === "release") return 1;
      throw new Error(`unexpected request: ${request.operation}`);
    },
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  let state!: AppRuntimeState;
  runtime.subscribe((next) => {
    state = next;
  });

  const error = await captureReject(
    runtime.loadTarget("wasm32-wasip2"),
    "guest failure resolved",
  );
  assert(
    error instanceof Error && error.message.includes("fetch failed"),
    `wrong guest failure: ${error}`,
  );
  assert(runtime.phase === "ready", "guest failure disposed the runtime");
  assert(state.operation === "idle", "guest failure did not restore idle");
  assertEquals(
    state.completedTargets,
    ["wasm32-wasip1"],
    "failed guest target was marked complete",
  );
  await runtime.dispose();
});

Deno.test("accepted target transport loss reports fatal through the runtime", async () => {
  const transportFailure = new Error("target transport lost");
  const harness = createHarness({
    targetEndpoint: async (request) => {
      if (request.operation === "start") return 52;
      throw transportFailure;
    },
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();

  const targetError = await captureReject(
    runtime.loadTarget("wasm32-wasip2"),
    "accepted transport loss resolved",
  );
  const fatalDisposal = runtime.dispose();
  assert(
    fatalDisposal === runtime.reportFatal(new Error("later fatal")),
    "transport fatal did not use memoized disposal",
  );
  const disposalError = await captureReject(
    fatalDisposal,
    "transport fatal disposal resolved",
  );
  assert(
    targetError === transportFailure,
    "target lost transport failure identity",
  );
  assert(
    disposalError === transportFailure,
    "runtime did not retain transport failure as fatal primary",
  );
  assert(runtime.phase === "disposed", "transport fatal left runtime active");
});

Deno.test("disposal clears Run state and survives a throwing subscriber", async () => {
  const flush = deferred<void>();
  const harness = createHarness({ timeoutMs: 100 });
  const runtime = await harness.supervisor.create();
  runtime.adoptCoordinator({
    flush: () => flush.promise,
    dispose: () => Promise.resolve(),
  });
  await runtime.start();
  await runtime.loadTarget("wasm32-wasip1");
  const subscriberFailure = new Error("disposing subscriber failed");
  runtime.subscribe((state) => {
    if (state.phase === "disposing") throw subscriberFailure;
  });
  const snapshots: AppRuntimeState[] = [];
  runtime.subscribe((state) => snapshots.push(state));
  const originalConsoleError = console.error;
  let reports = 0;
  console.error = () => {
    reports++;
  };
  const running = runtime.run();
  await Promise.resolve();

  try {
    const disposal = runtime.dispose();
    const runError = await captureReject(
      running,
      "Run resolved during disposal",
    );
    const disposing = snapshots.find((state) => state.phase === "disposing");
    assert(
      disposing !== undefined,
      "later subscriber missed disposing snapshot",
    );
    assert(
      runError === runtime.signal.reason,
      "Run lost generation abort reason",
    );
    assert(disposing.operation === "idle", "disposing Run remained busy");
    assertEquals(disposing.queuedTargets, [], "disposing Run retained queue");
    assert(
      disposing.activeTarget === undefined,
      "disposing Run retained active target",
    );
    assert(
      disposing.selectedTarget === "wasm32-wasip1",
      "disposing Run lost selected target",
    );
    assertEquals(
      disposing.completedTargets,
      ["wasm32-wasip1"],
      "disposing Run lost completed targets",
    );
    assert(
      runtime.signal.aborted,
      "throwing subscriber prevented generation abort",
    );
    await tick();
    assert(
      harness.events.includes("utility-worker-terminated") &&
        harness.events.includes("lifecycle-worker-terminated"),
      "throwing subscriber prevented worker termination",
    );
    flush.resolve();
    await disposal;
    assert(
      harness.events.includes("operations-settled"),
      "throwing subscriber prevented operation settlement",
    );
    assert(
      runtime.phase === "disposed",
      "Run disposal did not finish disposed",
    );
    assert(runtime.state.operation === "idle", "disposed Run rendered busy");
    assertEquals(
      runtime.state.queuedTargets,
      [],
      "disposed Run rendered queue",
    );
    assert(
      runtime.state.activeTarget === undefined,
      "disposed Run rendered active target",
    );
    assert(reports === 1, `disposing subscriber was reported ${reports} times`);
  } finally {
    console.error = originalConsoleError;
    flush.resolve();
    await runtime.dispose();
  }
});

Deno.test("disposal clears target state through reload-required", async () => {
  const neverSettles = new Promise<number>(() => {});
  const stateRequested = deferred<void>();
  const starts: string[] = [];
  const harness = createHarness({
    timeoutMs: 5,
    targetEndpoint: async (request) => {
      if (request.operation === "start") {
        starts.push(request.triple!);
        return 62;
      }
      if (request.operation === "state") {
        stateRequested.resolve();
        return await neverSettles;
      }
      return 1;
    },
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  runtime.subscribe((state) => {
    if (state.phase === "disposing") {
      throw new Error("target disposing subscriber failed");
    }
  });
  const snapshots: AppRuntimeState[] = [];
  runtime.subscribe((state) => snapshots.push(state));
  const originalConsoleError = console.error;
  let reports = 0;
  console.error = () => {
    reports++;
  };
  const active = runtime.loadTarget("wasm32-wasip2");
  const queued = runtime.loadTarget("wasm32-unknown-unknown");
  await stateRequested.promise;

  try {
    const disposal = runtime.dispose();
    const disposing = snapshots.find((state) => state.phase === "disposing");
    assert(disposing !== undefined, "target disposing snapshot was skipped");
    assert(disposing.operation === "idle", "disposing target remained busy");
    assertEquals(
      disposing.queuedTargets,
      [],
      "disposing target retained queue",
    );
    assert(
      disposing.activeTarget === undefined,
      "disposing target retained active target",
    );
    assert(
      disposing.selectedTarget === "wasm32-unknown-unknown",
      "disposing target lost latest selection",
    );
    assertEquals(
      disposing.completedTargets,
      ["wasm32-wasip1"],
      "disposing target lost completed targets",
    );
    const [activeError, queuedError] = await Promise.all([
      captureReject(active, "active target resolved during disposal"),
      captureReject(queued, "queued target resolved during disposal"),
    ]);
    assert(
      activeError === runtime.signal.reason,
      "active target lost abort reason",
    );
    assert(
      queuedError === runtime.signal.reason,
      "queued target lost abort reason",
    );
    const disposalError = await captureReject(
      disposal,
      "blocked target disposal did not quarantine",
    );
    assert(
      disposalError instanceof AggregateError,
      "target did not quarantine",
    );
    assert(
      runtime.phase === "reload-required",
      "target did not require reload",
    );
    assert(runtime.state.operation === "idle", "reload state rendered busy");
    assertEquals(
      runtime.state.queuedTargets,
      [],
      "reload state rendered queue",
    );
    assert(
      runtime.state.activeTarget === undefined,
      "reload state rendered active target",
    );
    assert(
      runtime.state.selectedTarget === "wasm32-unknown-unknown",
      "reload state lost latest selection",
    );
    assertEquals(
      starts,
      ["wasm32-wasip2"],
      "queued target transport started during disposal",
    );
    assert(
      harness.events.includes("generation-aborted") &&
        harness.events.includes("utility-worker-terminated") &&
        harness.events.includes("lifecycle-worker-terminated") &&
        harness.events.includes("operations-settled"),
      "throwing subscriber interrupted target teardown",
    );
    assert(reports === 1, `target subscriber was reported ${reports} times`);
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("disposal aborts queued targets without starting their transports", async () => {
  const blockedState = deferred<number>();
  const stateRequested = deferred<void>();
  const starts: string[] = [];
  const harness = createHarness({
    timeoutMs: 5,
    targetEndpoint: async (request) => {
      if (request.operation === "start") {
        starts.push(request.triple!);
        return 61;
      }
      if (request.operation === "state") {
        stateRequested.resolve();
        return await blockedState.promise;
      }
      return 1;
    },
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const first = runtime.loadTarget("wasm32-wasip2");
  const queued = runtime.loadTarget("wasm32-unknown-unknown");
  await stateRequested.promise;

  const disposal = runtime.dispose();
  const [firstError, queuedError] = await Promise.all([
    captureReject(first, "active target resolved during disposal"),
    captureReject(queued, "queued target resolved during disposal"),
  ]);
  assert(
    firstError === runtime.signal.reason,
    "active target lost abort reason",
  );
  assert(
    queuedError === runtime.signal.reason,
    "queued target lost abort reason",
  );
  assertEquals(
    starts,
    ["wasm32-wasip2"],
    "queued target transport started during disposal",
  );
  await captureReject(
    disposal,
    "blocked transport disposal did not quarantine",
  );
});

Deno.test("blocked target proxy is abort-raced before operation settlement", async () => {
  const neverSettles = new Promise<number>(() => {});
  const stateRequested = deferred<void>();
  const harness = createHarness({
    timeoutMs: 5,
    targetEndpoint: (request) => {
      if (request.operation === "start") return Promise.resolve(41);
      if (request.operation === "state") {
        stateRequested.resolve();
        return neverSettles;
      }
      return Promise.resolve(1);
    },
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const target = runtime.loadTarget("wasm32-wasip2");
  await stateRequested.promise;

  const disposalError = await captureReject(
    runtime.dispose(),
    "blocked target disposal resolved without quiescence",
  );
  const error = await captureReject(target, "blocked target resolved");

  assert(
    disposalError instanceof AggregateError,
    "blocked target did not quarantine unconfirmed transport",
  );
  assert(
    disposalError.errors.some((item) =>
      item instanceof Error &&
      item.message.includes(
        "pending underlying operations: target:wasm32-wasip2:state",
      )
    ),
    `blocked target timeout omitted its operation: ${disposalError}`,
  );
  assert(
    error instanceof DOMException && error.message.includes("runtime disposed"),
    "target wrapper lost the abort reason",
  );
  assert(
    harness.events.indexOf("utility-worker-terminated") <
      harness.events.indexOf("operations-settled"),
    "utility worker waited for blocked target",
  );
  assert(
    harness.events.indexOf("lifecycle-worker-terminated") <
      harness.events.indexOf("operations-settled"),
    "lifecycle worker waited for blocked target",
  );
  assert(
    harness.events.indexOf("generation-aborted") <
      harness.events.indexOf("animal-destroy-requested"),
    "target teardown requested destroy before generation abort",
  );
  assert(
    harness.events.indexOf("animal-destroy-requested") <
      harness.events.indexOf("operations-settled"),
    "target teardown settled operations before requesting destroy",
  );
});

Deno.test("operation owner shutdown starts before hard stop but settles afterward", async () => {
  const ownerSettlement = deferred<void>();
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  runtime.adoptOperationOwner({
    abort: () => harness.events.push("lsp-transport-aborted"),
    dispose: () => {
      harness.events.push("lsp-shutdown-started");
      return ownerSettlement.promise;
    },
  });
  await runtime.start();
  harness.events.length = 0;
  const disposal = runtime.dispose();
  void disposal.catch(() => undefined);
  await tick();

  assert(
    harness.events.indexOf("lsp-transport-aborted") <
      harness.events.indexOf("animal-destroy-requested"),
    "LSP transport abort did not precede Animal teardown",
  );
  assert(
    harness.events.indexOf("lsp-shutdown-started") <
      harness.events.indexOf("animal-destroy-requested"),
    "LSP shutdown was not initiated before Animal teardown",
  );
  assert(
    harness.events.indexOf("utility-worker-terminated") >= 0,
    "blocked LSP shutdown delayed utility hard stop",
  );
  ownerSettlement.resolve();
  await disposal;
  assert(
    harness.events.indexOf("utility-worker-terminated") <
      harness.events.indexOf("operations-settled"),
    "LSP settlement completed before utility hard stop",
  );
});

Deno.test("disposal waits for the observed underlying operation after aborting its caller", async () => {
  const underlying = deferred<void>();
  const harness = createHarness({ timeoutMs: 100 });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const caller = runtime.trackOperation(underlying.promise);
  const disposal = runtime.dispose();
  void disposal.catch(() => undefined);
  const callerError = await captureReject(caller, "operation caller resolved");
  let disposalSettled = false;
  void disposal
    .finally(() => {
      disposalSettled = true;
    })
    .catch(() => {});
  await tick();

  assert(callerError === runtime.signal.reason, "caller lost generation abort");
  assert(!disposalSettled, "disposal ignored the underlying operation");
  assert(
    harness.events.includes("utility-worker-terminated"),
    "underlying operation delayed utility hard stop",
  );
  underlying.resolve();
  await disposal;
});

Deno.test("LSP shutdown needing a worker cannot deadlock hard stop", async () => {
  const shutdown = deferred<void>();
  const harness = createHarness({ timeoutMs: 5 });
  const runtime = await harness.supervisor.create();
  const lspOwner = {
    settlementLabel: "rust-lsp",
    abort: () => harness.events.push("lsp-transport-aborted"),
    dispose: () => {
      harness.events.push("lsp-shutdown-needs-worker");
      return shutdown.promise;
    },
  };
  runtime.adoptOperationOwner(lspOwner);
  await runtime.start();
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const error = await captureReject(
      runtime.dispose(),
      "blocked LSP shutdown resolved",
    );

    assert(error instanceof AggregateError, "blocked LSP did not quarantine");
    assert(
      error.errors.some((item) =>
        item instanceof Error &&
        item.message.includes("pending operation owners: rust-lsp")
      ),
      `blocked LSP timeout omitted its owner: ${error}`,
    );
    assert(
      harness.events.indexOf("lsp-shutdown-needs-worker") <
        harness.events.indexOf("utility-worker-terminated"),
      "LSP shutdown was not initiated before hard stop",
    );
    assert(
      harness.events.indexOf("utility-worker-terminated") <
        harness.events.indexOf("operations-settled"),
      "blocked LSP shutdown delayed utility termination",
    );
    shutdown.reject(new Error("late LSP shutdown rejection"));
    await tick();
    assertEquals(unhandled, 0, "late LSP shutdown rejection was unhandled");
    assert(
      harness.supervisor.reloadRequired,
      "blocked LSP did not require reload",
    );
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

for (const unsafe of ["callbacks", "animal"] as const) {
  Deno.test(`unconfirmed ${unsafe} quiescence quarantines reachable resources`, async () => {
    const pending = new Promise<void>(() => {});
    const harness = createHarness({
      callbacks: unsafe === "callbacks" ? pending : undefined,
      destroy: unsafe === "animal" ? pending : undefined,
      timeoutMs: 5,
    });
    const runtime = await harness.supervisor.create();
    await runtime.start();

    const error = await captureReject(
      runtime.dispose(),
      "unsafe disposal resolved",
    );

    assert(
      error instanceof AggregateError,
      "unsafe disposal was not aggregated",
    );
    assertEquals(
      harness.utilityWorkers[0].terminateCalls,
      1,
      "utility worker survived quarantine",
    );
    assertEquals(
      harness.lifecycleWorkers[0].terminateCalls,
      1,
      "lifecycle worker survived quarantine",
    );
    assert(!harness.farms[0].destroyed, "quarantined farm was destroyed");
    assert(!harness.stores[0].disposed, "quarantined store was disposed");
    assert(
      !harness.events.includes("channels-disposed"),
      "quarantined channels were closed",
    );

    const createError = await captureReject(
      harness.supervisor.create(),
      "quarantined supervisor created another runtime",
    );
    assert(createError instanceof ReloadRequiredError, "reload error type");
    assertEquals(
      createError.message,
      "reload required",
      "reload error message",
    );
  });
}

Deno.test("destroyer receipt without lifecycle adoption quarantines on deadline", async () => {
  const destroy = deferred<void>();
  const harness = createHarness({ destroy: destroy.promise, timeoutMs: 5 });
  const runtime = await harness.supervisor.create();
  await runtime.start();

  const error = await captureReject(
    runtime.dispose(),
    "destroy deadline resolved",
  );
  assert(
    error instanceof AggregateError,
    "destroy deadline was not a cleanup failure",
  );
  assert(!harness.farms[0].destroyed, "unadopted Animal farm was destroyed");
});

Deno.test("real handshake publication without lifecycle adoption retains the generation", async () => {
  const harness = createHarness({ timeoutMs: 5 });
  harness.dependencies.createWorkerHandshake = createRuntimeWorkerHandshake;
  const runtime = await harness.supervisor.create();
  const starting = runtime.start();
  void starting.catch(() => undefined);
  harness.utilityWorkers[0].dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "destroyer",
        generation: runtime.generation,
        handle: {},
      },
    }),
  );
  assertEquals(
    (harness.lifecycleWorkers[0].posted[0] as { type?: string })?.type,
    "adopt",
    "real handshake did not publish lifecycle adoption",
  );

  const error = await captureReject(
    runtime.dispose(),
    "unadopted real handshake disposal resolved",
  );
  const startError = await captureReject(
    starting,
    "unadopted real handshake startup resolved",
  );

  assert(
    startError === runtime.signal.reason,
    "unadopted real handshake startup lost the generation abort",
  );
  assert(
    error instanceof AggregateError,
    "real handshake timeout was not aggregated",
  );
  assert(
    harness.supervisor.reloadRequired,
    "real handshake did not quarantine",
  );
  assert(!harness.farms[0].destroyed, "real handshake released the farm");
  const createError = await captureReject(
    harness.supervisor.create(),
    "real handshake quarantine released the generation slot",
  );
  assert(
    createError instanceof ReloadRequiredError,
    "real handshake released admission",
  );
});

Deno.test("deadline loser rejection is observed after quarantine", async () => {
  const callbacks = deferred<void>();
  const harness = createHarness({ callbacks: callbacks.promise, timeoutMs: 5 });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    await captureReject(runtime.dispose(), "callback deadline resolved");
    callbacks.reject(new Error("late callback failure"));
    await tick();
    assertEquals(unhandled, 0, "deadline loser rejection was unhandled");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("dispose and repeated fatal reports share one promise and preserve primary", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const primary = new Error("primary worker failure");
  const later = new Error("later worker failure");

  const first = runtime.reportFatal(primary);
  const second = runtime.reportFatal(later);
  const third = runtime.dispose();

  assert(first === second && second === third, "fatal/dispose Promise changed");
  const error = await captureReject(first, "fatal disposal resolved");
  assert(error === primary, "later fatal replaced the primary error");
});

Deno.test("cleanup failures aggregate with fatal primary as cause", async () => {
  const cleanup = new Error("coordinator cleanup failed");
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  runtime.adoptCoordinator({ dispose: () => Promise.reject(cleanup) });
  await runtime.start();
  const primary = new Error("worker failed");

  const error = await captureReject(
    runtime.reportFatal(primary),
    "fatal cleanup failure resolved",
  );

  assert(error instanceof AggregateError, "cleanup failure was not aggregated");
  assert(error.cause === primary, "AggregateError lost the primary cause");
  assertEquals(error.errors, [cleanup], "AggregateError cleanup errors");
});

Deno.test("construction failure disposes partial owners and releases supervisor slot", async () => {
  const harness = createHarness({ failFactory: "terminal" });
  const error = await captureReject(
    harness.supervisor.create(),
    "partial construction resolved",
  );
  assert(
    error instanceof Error && error.message === "terminal failed",
    "construction error changed",
  );
  assert(harness.stores[0].disposed, "partial store leaked");

  harness.dependencies.createTerminalService = () => ({
    attach: () => ({ dispose() {} }),
    write() {},
    size: () => ({ cols: 80, rows: 24 }),
    out: () => "",
    error: () => "",
    dispose() {},
  });
  const runtime = await harness.supervisor.create();
  await runtime.dispose();
});

Deno.test("settled construction cleanup permits ordinary teardown and preserves primary", async () => {
  const harness = createHarness();
  const primary = new Error("host bridge construction failed");
  const cleanupError = new Error("partial bridge disposal rejected");
  harness.dependencies.createHostCallbacks = ({
    registerConstructionCleanup,
  }) => {
    registerConstructionCleanup(Promise.reject(cleanupError));
    throw primary;
  };
  const runtime = await harness.supervisor.create();

  const error = await captureReject(runtime.start(), "construction failure resolved");

  assert(error instanceof AggregateError, "cleanup rejection was not aggregated");
  assert(error.cause === primary, "construction primary was not preserved");
  assert(error.errors.includes(cleanupError), "cleanup rejection was not observed");
  assert(runtime.phase === "disposed", "settled cleanup quarantined the runtime");
  const next = await harness.supervisor.create();
  await next.dispose();
});

Deno.test("hanging construction cleanup quarantines at the runtime deadline", async () => {
  const harness = createHarness({ timeoutMs: 5 });
  const primary = new Error("host bridge construction failed");
  harness.dependencies.createHostCallbacks = ({
    registerConstructionCleanup,
  }) => {
    registerConstructionCleanup(new Promise<void>(() => {}));
    throw primary;
  };
  const runtime = await harness.supervisor.create();

  const error = await captureReject(runtime.start(), "hanging cleanup resolved");

  assert(error instanceof AggregateError, "hanging cleanup was not aggregated");
  assert(error.cause === primary, "hanging cleanup lost construction primary");
  assert(runtime.phase === "reload-required", "hanging cleanup did not quarantine");
  assert(harness.supervisor.reloadRequired, "supervisor did not require reload");
});

Deno.test("construction rollback preserves service then channel dependency order", async () => {
  const harness = createHarness();
  const events: string[] = [];
  harness.dependencies.createArchiveStore = () => ({
    prefetch: () => Promise.resolve(),
    dispose: () => events.push("store"),
  });
  harness.dependencies.createTerminalService = () => ({
    attach: () => ({ dispose() {} }),
    write() {},
    size: () => ({ cols: 80, rows: 24 }),
    out: () => "",
    error: () => "",
    dispose: () => events.push("terminal"),
  });
  harness.dependencies.createParserService = () => ({
    get ready(): Promise<void> {
      throw new Error("parser ready acquisition failed");
    },
    dispose: () => events.push("parser"),
  });
  harness.dependencies.createCommandService = () => ({
    run: () => Promise.resolve(),
    download: () => Promise.resolve(),
    dispose: () => events.push("commands"),
  });
  harness.dependencies.createChannelOwner = () => ({
    add<T>(channel: T): T {
      return channel;
    },
    dispose: () => events.push("channels"),
  });
  harness.dependencies.clearRegistrations = () => events.push("registrations");

  await captureReject(
    harness.supervisor.create(),
    "parser ready construction failure resolved",
  );

  assertEquals(
    events,
    ["commands", "parser", "terminal", "channels", "store", "registrations"],
    "construction rollback dependency order",
  );
});

Deno.test("worker partial construction terminates utility and cleans generation", async () => {
  const harness = createHarness({ failFactory: "lifecycle" });
  const runtime = await harness.supervisor.create();
  const error = await captureReject(
    runtime.start(),
    "partial worker startup resolved",
  );

  assert(
    error instanceof Error && error.message === "lifecycle failed",
    "worker factory error changed",
  );
  assertEquals(
    harness.utilityWorkers[0].terminateCalls,
    1,
    "partial utility worker leaked",
  );
  await captureReject(runtime.dispose(), "failed startup disposal resolved");
  assert(harness.stores[0].disposed, "failed startup store leaked");
});

Deno.test("registration cleanup is generation-token conditional", async () => {
  const harness = createHarness();
  const first = await harness.supervisor.create();
  await first.dispose();
  const second = await harness.supervisor.create();
  await second.dispose();

  assertEquals(
    harness.cleared,
    ["generation-1", "generation-2"],
    "cleanup used a stale or missing generation token",
  );
});

Deno.test("parser and command services share the runtime generation signal", async () => {
  const harness = createHarness();
  let parserSignal: AbortSignal | undefined;
  let commandSignal: AbortSignal | undefined;
  harness.dependencies.createParserService = (_ctx, signal) => {
    parserSignal = signal;
    return { ready: Promise.resolve(), dispose() {} };
  };
  harness.dependencies.createCommandService = (_ctx, signal) => {
    commandSignal = signal;
    return {
      run: () => Promise.resolve(),
      download: () => Promise.resolve(),
      dispose() {},
    };
  };

  const runtime = await harness.supervisor.create();
  assert(parserSignal === runtime.signal, "parser received a different signal");
  assert(
    commandSignal === runtime.signal,
    "command service received a different signal",
  );
  const disposal = runtime.dispose();
  assert(parserSignal.aborted, "parser signal was not aborted");
  assert(commandSignal.aborted, "command signal was not aborted");
  await disposal;
});

Deno.test("downloads invoke the generation command service serially", async () => {
  const harness = createHarness();
  const blocked = deferred<void>();
  let active = 0;
  let maximumActive = 0;
  harness.dependencies.createCommandService = () => ({
    run: () => Promise.resolve(),
    download: async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await blocked.promise;
      active--;
    },
    dispose() {},
  });
  const runtime = await harness.supervisor.create();
  await runtime.start();

  const first = runtime.download("/tmp/first");
  const second = runtime.download("/tmp/second");
  await Promise.resolve();
  await Promise.resolve();
  blocked.resolve();
  await Promise.all([first, second]);

  assertEquals(maximumActive, 1, "download command concurrency");
  await runtime.dispose();
});

Deno.test("stale runtime release cannot clear a newer supervisor slot", async () => {
  const harness = createHarness();
  const first = await harness.supervisor.create();
  await first.dispose();
  const second = await harness.supervisor.create();

  harness.supervisor.release(first);
  const error = await captureReject(
    harness.supervisor.create(),
    "stale release cleared the active runtime",
  );

  assert(
    error instanceof Error && error.message.includes("already active"),
    "active overlap rejection changed",
  );
  await second.dispose();
});

for (
  const failed of [
    "ctx",
    "store",
    "terminal",
    "parser",
    "commands",
    "channels",
  ] as const
) {
  Deno.test(`${failed} construction failure rolls back acquired generation owners`, async () => {
    const harness = createHarness({ failFactory: failed });
    const error = await captureReject(
      harness.supervisor.create(),
      `${failed} construction failure resolved`,
    );

    assert(
      error instanceof Error && error.message === `${failed} failed`,
      `${failed} construction error changed`,
    );
    if (failed !== "ctx" && failed !== "store") {
      assert(harness.stores[0].disposed, `${failed} leaked the archive store`);
    }
    if (["parser", "commands", "channels"].includes(failed)) {
      assert(
        harness.terminals[0].disposed,
        `${failed} leaked the terminal service`,
      );
    }
    assertEquals(
      harness.cleared,
      ["generation-1"],
      `${failed} rollback did not clear its generation registrations`,
    );
  });
}

for (
  const failed of [
    "callbacks",
    "farm",
    "utility",
    "lifecycle",
    "handshake",
  ] as const
) {
  Deno.test(`${failed} startup failure tears down all acquired runtime owners`, async () => {
    const harness = createHarness({ failFactory: failed });
    const runtime = await harness.supervisor.create();
    const error = await captureReject(
      runtime.start(),
      `${failed} startup failure resolved`,
    );

    assert(
      error instanceof Error && error.message === `${failed} failed`,
      `${failed} startup error changed`,
    );
    assert(harness.stores[0].disposed, `${failed} leaked the archive store`);
    assert(
      harness.terminals[0].disposed,
      `${failed} leaked the terminal service`,
    );
    for (
      const worker of [
        ...harness.utilityWorkers,
        ...harness.lifecycleWorkers,
      ]
    ) {
      assertEquals(worker.terminateCalls, 1, `${failed} leaked a worker`);
    }
  });
}

for (const boundary of ["error", "messageerror"] as const) {
  Deno.test(`real worker handshake reports ${boundary} as the fatal primary`, async () => {
    const harness = createHarness();
    harness.dependencies.createWorkerHandshake = createRuntimeWorkerHandshake;
    const runtime = await harness.supervisor.create();
    const startup = runtime.start();
    const event = new ErrorEvent(boundary, {
      message: `${boundary} boundary failed`,
      cancelable: true,
    });
    harness.utilityWorkers[0].dispatchEvent(event);

    const error = await captureReject(startup, `${boundary} startup resolved`);

    assert(
      error instanceof AggregateError,
      `${boundary} cleanup was not aggregated`,
    );
    assert(
      error.cause instanceof Error &&
        error.cause.message.includes(`${boundary} boundary failed`),
      `${boundary} worker primary was not preserved as cause`,
    );
    assertEquals(
      harness.utilityWorkers[0].terminateCalls,
      1,
      `${boundary} utility termination count`,
    );
    assertEquals(
      harness.lifecycleWorkers[0].terminateCalls,
      1,
      `${boundary} lifecycle termination count`,
    );
  });
}

Deno.test("dispose abort-races startup without waiting for worker readiness", async () => {
  const startup = deferred<void>();
  const harness = createHarness({ startup: startup.promise });
  const runtime = await harness.supervisor.create();
  const starting = runtime.start();

  const disposal = runtime.dispose();
  const startError = await captureReject(starting, "aborted startup resolved");
  await disposal;

  assert(
    startError instanceof DOMException &&
      startError.message.includes("runtime disposed"),
    "startup wrapper lost the disposal reason",
  );
  startup.reject(new Error("late startup rejection"));
  await tick();
});

Deno.test("ordinary cleanup failure rejects AggregateError and still releases the slot", async () => {
  const cleanup = new Error("coordinator failed");
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  runtime.adoptCoordinator({ dispose: () => Promise.reject(cleanup) });
  const first = runtime.dispose();
  const second = runtime.dispose();

  assert(first === second, "ordinary dispose Promise changed");
  const error = await captureReject(first, "cleanup failure resolved");
  assert(
    error instanceof AggregateError,
    "ordinary cleanup was not aggregated",
  );
  assertEquals(error.errors, [cleanup], "ordinary cleanup errors");
  assert(
    !("cause" in error),
    "cleanup-only AggregateError exposed an undefined primary cause",
  );
  const next = await harness.supervisor.create();
  await next.dispose();
});

Deno.test("adopted async producers abort before Animal teardown and dispose after workers", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  runtime.adoptOperationOwner({
    abort: () => harness.events.push("lsp-aborted"),
    dispose: async () => {
      harness.events.push("lsp-disposed");
    },
  });
  await runtime.start();
  harness.events.length = 0;

  await runtime.dispose();

  assert(
    harness.events.indexOf("lsp-aborted") <
      harness.events.indexOf("animal-destroy-requested"),
    "LSP producer was not aborted before Animal teardown",
  );
  assert(
    harness.events.indexOf("lsp-disposed") <
      harness.events.indexOf("animal-destroy-requested"),
    "LSP owner disposal was not initiated before Animal teardown",
  );
  assert(
    harness.events.indexOf("utility-worker-terminated") <
      harness.events.indexOf("operations-settled"),
    "LSP settlement completed before utility hard-stop",
  );
});

Deno.test("synchronous operation-owner disposal failure does not skip normal cleanup", async () => {
  const cleanup = new Error("synchronous owner cleanup failed");
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  runtime.adoptOperationOwner({
    dispose() {
      throw cleanup;
    },
  });
  await runtime.start();

  const error = await captureReject(
    runtime.dispose(),
    "synchronous owner cleanup failure resolved",
  );

  assert(
    error instanceof AggregateError,
    "synchronous cleanup was not aggregated",
  );
  assertEquals(error.errors, [cleanup], "synchronous cleanup error changed");
  assert(
    harness.farms[0].destroyed,
    "synchronous cleanup skipped farm destruction",
  );
  assert(
    harness.stores[0].disposed,
    "synchronous cleanup skipped store disposal",
  );
});

Deno.test("dropped post-disposal target rejection is internally observed", async () => {
  const destroy = deferred<void>();
  const harness = createHarness({ destroy: destroy.promise });
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const disposal = runtime.dispose();
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    runtime.loadTarget("wasm32-wasip2");
    await tick();
    assertEquals(unhandled, 0, "post-disposal rejection was unhandled");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
    destroy.resolve();
    await disposal;
  }
});

Deno.test("synchronous abort reentrancy cannot adopt an un-aborted owner", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  let reentrantError: unknown;
  runtime.adoptOperationOwner({
    abort() {
      try {
        runtime.adoptOperationOwner({ dispose: () => Promise.resolve() });
      } catch (error) {
        reentrantError = error;
      }
    },
    dispose: () => Promise.resolve(),
  });
  await runtime.start();

  await runtime.dispose();

  assert(
    reentrantError instanceof DOMException &&
      reentrantError.message.includes("runtime disposed"),
    "disposing runtime accepted a reentrant operation owner",
  );
});

Deno.test("synchronous abort dispose and fatal reentry share the memoized teardown", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const reentrantFatal = new Error("fatal from synchronous abort listener");
  let reentrantDispose: Promise<void> | undefined;
  let reentrantReport: Promise<void> | undefined;
  runtime.signal.addEventListener(
    "abort",
    () => {
      reentrantDispose = runtime.dispose();
      reentrantReport = runtime.reportFatal(reentrantFatal);
    },
    { once: true },
  );
  harness.events.length = 0;

  const disposal = runtime.dispose();

  assert(disposal === reentrantDispose, "reentrant dispose Promise changed");
  assert(disposal === reentrantReport, "reentrant fatal Promise changed");
  const error = await captureReject(
    disposal,
    "reentrant fatal disposal resolved",
  );
  assert(error === reentrantFatal, "reentrant fatal primary changed");
  assertEquals(
    harness.events.filter((event) => event === "farm-destroyed").length,
    1,
    "reentrant teardown destroyed the farm more than once",
  );
  assertEquals(
    harness.events.filter((event) => event === "store-disposed").length,
    1,
    "reentrant teardown disposed the store more than once",
  );
});

for (
  const factory of [
    "callbacks",
    "farm",
    "utility",
    "lifecycle",
    "handshake",
  ] as const
) {
  Deno.test(`reentrant disposal after ${factory} acquisition cannot leak startup resources`, async () => {
    const runtimeRef: { current?: AppRuntime } = {};
    let reentrantDisposal: Promise<void> | undefined;
    const harness = createHarness({
      onStartFactoryAcquired(acquired) {
        if (acquired === factory) {
          reentrantDisposal = runtimeRef.current?.dispose();
        }
      },
    });
    const runtime = await harness.supervisor.create();
    runtimeRef.current = runtime;

    const startError = await captureReject(
      runtime.start(),
      `${factory} reentrant start resolved`,
    );
    assert(
      startError instanceof DOMException &&
        startError.message.includes("runtime disposed"),
      `${factory} start lost the disposal reason`,
    );
    assert(
      reentrantDisposal !== undefined,
      `${factory} did not reenter disposal`,
    );
    assert(
      reentrantDisposal === runtime.dispose(),
      `${factory} reentry changed the disposal Promise`,
    );
    await reentrantDisposal;

    for (const owner of harness.hostCallbacks) {
      assert(owner.disposed, `${factory} leaked a host callback owner`);
    }
    for (const farm of harness.farms) {
      assert(farm.destroyed, `${factory} leaked a farm`);
    }
    if (factory === "farm") {
      assertEquals(
        harness.events.filter((event) => event === "data-plane-detached")
          .length,
        1,
        "reentrant farm disposal did not detach exactly once",
      );
      assert(
        harness.events.indexOf("data-plane-detached") <
          harness.events.indexOf("farm-destroyed"),
        "reentrant farm disposal detached after destruction",
      );
    }
    for (
      const worker of [
        ...harness.utilityWorkers,
        ...harness.lifecycleWorkers,
      ]
    ) {
      assertEquals(
        worker.terminateCalls,
        1,
        `${factory} leaked or repeatedly terminated a worker`,
      );
    }
    if (harness.handshakes.length > 0) {
      assert(
        harness.events.includes("animal-destroy-requested"),
        `${factory} skipped handshake disposal`,
      );
    }
    assert(harness.stores[0].disposed, `${factory} leaked the store`);
  });
}

Deno.test("reentrant callback acquisition keeps disposal pending until late cleanup settles", async () => {
  const callbackSettlement = deferred<void>();
  const runtimeRef: { current?: AppRuntime } = {};
  let disposal: Promise<void> | undefined;
  const harness = createHarness({
    callbacks: callbackSettlement.promise,
    onStartFactoryAcquired(factory) {
      if (factory === "callbacks") disposal = runtimeRef.current?.dispose();
    },
    timeoutMs: 100,
  });
  const runtime = await harness.supervisor.create();
  runtimeRef.current = runtime;
  const starting = runtime.start();
  void starting.catch(() => undefined);
  let disposalSettled = false;
  void disposal
    ?.finally(() => {
      disposalSettled = true;
    })
    .catch(() => {});

  await tick();
  assert(!disposalSettled, "disposal released a late callback acquisition");
  callbackSettlement.resolve();
  await captureReject(starting, "late callback startup resolved");
  await disposal;
  assert(
    harness.hostCallbacks[0].disposed,
    "late callback owner was not settled",
  );
});

Deno.test("reentrant callback cleanup rejection quarantines the late acquisition", async () => {
  const callbackSettlement = deferred<void>();
  const runtimeRef: { current?: AppRuntime } = {};
  const harness = createHarness({
    callbacks: callbackSettlement.promise,
    onStartFactoryAcquired(factory) {
      if (factory === "callbacks") void runtimeRef.current?.dispose();
    },
    timeoutMs: 20,
  });
  const runtime = await harness.supervisor.create();
  runtimeRef.current = runtime;
  const starting = runtime.start();
  void starting.catch(() => undefined);
  const cleanupError = new Error("late callback cleanup failed");
  callbackSettlement.reject(cleanupError);

  const error = await captureReject(
    runtime.dispose(),
    "late callback cleanup rejection resolved",
  );

  assert(
    error instanceof AggregateError,
    "late callback failure was not aggregated",
  );
  assert(
    error.errors.includes(cleanupError),
    "late callback cleanup error was not preserved",
  );
  assert(
    harness.supervisor.reloadRequired,
    "late callback failure did not quarantine",
  );
  assert(
    !harness.stores[0].disposed,
    "late callback failure released the store",
  );
  await captureReject(starting, "late callback startup resolved");
});

for (const factory of ["callbacks", "handshake"] as const) {
  Deno.test(`reentrant ${factory} hanging cleanup cannot hold start pending`, async () => {
    const neverSettles = new Promise<void>(() => {});
    const runtimeRef: { current?: AppRuntime } = {};
    let disposal: Promise<void> | undefined;
    const harness = createHarness({
      callbacks: factory === "callbacks" ? neverSettles : undefined,
      destroy: factory === "handshake" ? neverSettles : undefined,
      timeoutMs: 5,
      onStartFactoryAcquired(acquired) {
        if (acquired === factory) disposal = runtimeRef.current?.dispose();
      },
    });
    const runtime = await harness.supervisor.create();
    runtimeRef.current = runtime;
    const pending = {};
    let startError: unknown = pending;

    void runtime.start().catch((error) => {
      startError = error;
    });
    assert(disposal !== undefined, `${factory} did not reenter disposal`);
    const disposalError = await captureReject(
      disposal,
      `${factory} hanging disposal resolved`,
    );
    await tick();

    assert(
      startError === runtime.signal.reason,
      `${factory} hanging cleanup retained startup`,
    );
    assert(
      disposalError instanceof AggregateError,
      `${factory} hanging cleanup did not reach its deadline`,
    );
    assert(
      harness.supervisor.reloadRequired,
      `${factory} hanging cleanup did not quarantine`,
    );
  });
}

Deno.test("post-ready worker fatal leaves ready and disposes the runtime", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  await runtime.start();
  const primary = new Error("worker failed after ready");

  harness.workerFatalReporters[0](primary);

  assert(runtime.phase === "disposing", "post-ready fatal left runtime ready");
  const operationError = await captureReject(
    runtime.loadTarget("wasm32-wasip2"),
    "post-ready fatal accepted a new operation",
  );
  assert(operationError === primary, "future operation lost fatal primary");
  const disposalError = await captureReject(
    runtime.dispose(),
    "post-ready fatal disposal resolved",
  );
  assert(disposalError === primary, "post-ready disposal lost fatal primary");
  assertEquals(
    harness.cleared.length,
    1,
    "post-ready fatal cleaned repeatedly",
  );
});

Deno.test("ready-boundary worker fatal aborts startup before ready", async () => {
  const harness = createHarness();
  const primary = new Error("worker failed at ready boundary");
  harness.dependencies.createWorkerHandshake = ({ onFatalError }) => {
    const handshake: RuntimeWorkerHandshake = {
      initialize() {
        const initialized = Promise.resolve();
        void initialized.then(() => onFatalError(primary));
        return initialized;
      },
      dispose: () => Promise.resolve(),
    };
    return handshake;
  };
  const runtime = await harness.supervisor.create();

  const error = await captureReject(
    runtime.start(),
    "ready-boundary fatal allowed startup",
  );

  assert(error === primary, "ready-boundary fatal primary changed");
  assert(runtime.phase !== "ready", "ready-boundary fatal published ready");
});

Deno.test("runtime LSP dependencies adopt owners and register every shared channel", async () => {
  const harness = createHarness();
  const runtime = await harness.supervisor.create();
  const lsp = runtime.lspDependencies;
  let ownerDisposed = false;

  assert(lsp.ctx === runtime.ctx, "LSP dependencies changed the runtime Ctx");
  assert(lsp.signal === runtime.signal, "LSP dependencies changed the signal");
  lsp.adopter.adoptOperationOwner({
    dispose: async () => {
      ownerDisposed = true;
    },
  });
  const object = lsp.factories.createSharedObject(
    () => undefined,
    "lsp-object",
  );
  const ref = lsp.factories.createSharedObjectRef("lsp-ref");

  assertEquals(
    harness.channelOwners[0].added.slice(-2),
    [object, ref],
    "LSP channels bypassed the runtime channel owner",
  );
  await runtime.dispose();
  assert(ownerDisposed, "runtime did not dispose the adopted LSP owner");
});

Deno.test("runtime-owned LSP late cleanup timeout quarantines the generation", async () => {
  const harness = createHarness({ timeoutMs: 5 });
  const runtime = await harness.supervisor.create();
  const owner = new RustLspResourceOwner(runtime.lspDependencies.adopter);
  const neverSettles = new Promise<void>(() => {});
  let setterReason: unknown;
  owner.setTestApiDisposable({
    dispose() {
      try {
        owner.setSync({ dispose: () => neverSettles });
      } catch (error) {
        setterReason = error;
      }
    },
  });

  const error = await captureReject(
    runtime.dispose(),
    "runtime released a hanging late LSP cleanup",
  );

  assert(
    setterReason === runtime.signal.reason,
    "runtime-owned late setter lost the generation abort",
  );
  assert(
    error instanceof AggregateError,
    "late LSP deadline was not aggregated",
  );
  assert(
    harness.supervisor.reloadRequired,
    "late LSP cleanup did not quarantine",
  );
  assert(!harness.stores[0].disposed, "late LSP quarantine released the store");
  const createError = await captureReject(
    harness.supervisor.create(),
    "late LSP quarantine released the generation slot",
  );
  assert(
    createError instanceof ReloadRequiredError,
    "late LSP admission reopened",
  );
});

Deno.test("supervisor explicitly retains the complete quarantined ownership set", async () => {
  const neverSettles = new Promise<void>(() => {});
  const harness = createHarness({ callbacks: neverSettles, timeoutMs: 5 });
  const runtime = await harness.supervisor.create();
  const lspRef = runtime.lspDependencies.factories.createSharedObjectRef(
    "quarantined-lsp-ref",
  );
  await runtime.start();
  await captureReject(runtime.dispose(), "quarantine disposal resolved");

  harness.farms.length = 0;
  harness.hostCallbacks.length = 0;
  harness.channelOwners.length = 0;
  harness.terminals.length = 0;
  harness.parsers.length = 0;
  harness.commands.length = 0;
  const retained = harness.supervisor.quarantineRetention;

  assert(retained !== undefined, "supervisor exposed no quarantine retention");
  assert(
    retained.generation === runtime.generation,
    "retained generation changed",
  );
  assert(
    retained.archiveStore === runtime.archiveStore,
    "store was not retained",
  );
  assert(retained.channels === runtime.channels, "channels were not retained");
  assert(retained.terminal === runtime.terminal, "terminal was not retained");
  assert(retained.parser === runtime.parser, "parser was not retained");
  assert(retained.commands === runtime.commands, "commands were not retained");
  assert(retained.farm !== undefined, "farm was not retained");
  assert(retained.hostCallbacks !== undefined, "callbacks were not retained");
  assert(retained.workerHandshake !== undefined, "handshake was not retained");
  assert(
    retained.utilityWorker !== undefined,
    "utility worker was not retained",
  );
  assert(
    retained.lifecycleWorker !== undefined,
    "lifecycle worker was not retained",
  );
  assert(
    (
      retained.channels as (typeof harness.channelOwners)[number]
    ).added.includes(lspRef),
    "quarantine dropped a runtime-owned LSP channel",
  );
});
