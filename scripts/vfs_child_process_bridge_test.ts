import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import {
  type ChildProcessBridgeResponse,
  type ChildProcessBridgeOptions,
  type ChildProcessMessage,
  createChildProcessBridge,
  createChildProcessBridgeOwner,
  isChildProcessMessage,
} from "../lib/src/child_process_bridge.ts";
import * as childProcessBridgeModule from "../lib/src/child_process_bridge.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const workerUrl = new URL(
  "../page/src/worker_process/vfs_bindings/child_process_worker.ts",
  import.meta.url,
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "values") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function assertRejects(
  action: () => unknown | Promise<unknown>,
  includes: string,
) {
  try {
    await action();
  } catch (error) {
    const text = String(error);
    assert(
      text.includes(includes),
      `expected ${JSON.stringify(text)} to include ${includes}`,
    );
    return;
  }
  throw new Error(`expected rejection containing ${includes}`);
}

function message<Name extends ChildProcessMessage["name"]>(
  name: Name,
  args: Record<string, unknown>,
) {
  return { name, args } as ChildProcessMessage;
}

class FakeClock {
  #nextId = 1;
  #callbacks = new Map<number, () => void>();
  scheduled = 0;
  cleared = 0;

  setTimeout = (callback: () => void, _delay: number) => {
    this.scheduled++;
    const id = this.#nextId++;
    this.#callbacks.set(id, callback);
    return id;
  };

  clearTimeout = (id: number | ReturnType<typeof setTimeout>) => {
    this.cleared++;
    if (typeof id === "number") this.#callbacks.delete(id);
  };

  fireAll() {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    callbacks.forEach((callback) => callback());
  }

  get pending() {
    return this.#callbacks.size;
  }
}

interface WorkerResult {
  status: number;
  error?: string;
  graceful: boolean;
}

class FakeWorker {
  #onmessage: ((event: MessageEvent<WorkerResult>) => void) | null = null;
  #onerror: ((event: ErrorEvent) => void) | null = null;
  #onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly listenerClears = {
    message: 0,
    error: 0,
    messageError: 0,
  };
  posted: unknown;
  terminated = false;
  terminateCalls = 0;

  constructor(
    private readonly throwOnListenerSetup = false,
    readonly listenerSetupError = new Error("message listener setup failed"),
  ) {}

  get onmessage() {
    return this.#onmessage;
  }

  set onmessage(value: ((event: MessageEvent<WorkerResult>) => void) | null) {
    if (value === null && this.#onmessage !== null) {
      this.listenerClears.message++;
    }
    this.#onmessage = value;
    if (value !== null && this.throwOnListenerSetup) {
      throw this.listenerSetupError;
    }
  }

  get onerror() {
    return this.#onerror;
  }

  set onerror(value: ((event: ErrorEvent) => void) | null) {
    if (value === null && this.#onerror !== null) {
      this.listenerClears.error++;
    }
    this.#onerror = value;
  }

  get onmessageerror() {
    return this.#onmessageerror;
  }

  set onmessageerror(value: ((event: MessageEvent) => void) | null) {
    if (value === null && this.#onmessageerror !== null) {
      this.listenerClears.messageError++;
    }
    this.#onmessageerror = value;
  }

  postMessage(value: unknown) {
    this.posted = structuredClone(value);
  }

  terminate() {
    this.terminated = true;
    this.terminateCalls++;
  }

  finish(result: WorkerResult) {
    this.onmessage?.(new MessageEvent("message", { data: result }));
  }
}

type AbortBoundary =
  | "createWorker"
  | "onmessage"
  | "onerror"
  | "onmessageerror"
  | "setTimeout"
  | "getWasiRef"
  | "postMessage";

class AbortBoundaryWorker {
  #onmessage: ((event: MessageEvent<WorkerResult>) => void) | null = null;
  #onerror: ((event: ErrorEvent) => void) | null = null;
  #onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly listenerClears = {
    message: 0,
    error: 0,
    messageError: 0,
  };
  postMessageCalls = 0;
  terminateCalls = 0;

  constructor(
    private readonly boundary: AbortBoundary,
    private readonly abortGeneration: () => void,
  ) {}

  get onmessage() {
    return this.#onmessage;
  }

  set onmessage(value: ((event: MessageEvent<WorkerResult>) => void) | null) {
    if (value === null && this.#onmessage !== null) {
      this.listenerClears.message++;
    }
    this.#onmessage = value;
    if (value !== null && this.boundary === "onmessage") {
      this.abortGeneration();
    }
  }

  get onerror() {
    return this.#onerror;
  }

  set onerror(value: ((event: ErrorEvent) => void) | null) {
    if (value === null && this.#onerror !== null) {
      this.listenerClears.error++;
    }
    this.#onerror = value;
    if (value !== null && this.boundary === "onerror") {
      this.abortGeneration();
    }
  }

  get onmessageerror() {
    return this.#onmessageerror;
  }

  set onmessageerror(value: ((event: MessageEvent) => void) | null) {
    if (value === null && this.#onmessageerror !== null) {
      this.listenerClears.messageError++;
    }
    this.#onmessageerror = value;
    if (value !== null && this.boundary === "onmessageerror") {
      this.abortGeneration();
    }
  }

  postMessage() {
    this.postMessageCalls++;
    if (this.boundary === "postMessage") this.abortGeneration();
  }

  terminate() {
    this.terminateCalls++;
  }
}

class AbortBeforeStoreWorker {
  #onmessage: ((event: MessageEvent<WorkerResult>) => void) | null = null;
  #onerror: ((event: ErrorEvent) => void) | null = null;
  #onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessageCalls = 0;
  terminateCalls = 0;

  constructor(private readonly abortGeneration: () => void) {}

  get onmessage() {
    return this.#onmessage;
  }

  set onmessage(value: ((event: MessageEvent<WorkerResult>) => void) | null) {
    if (value !== null) this.abortGeneration();
    this.#onmessage = value;
  }

  get onerror() {
    return this.#onerror;
  }

  set onerror(value: ((event: ErrorEvent) => void) | null) {
    this.#onerror = value;
  }

  get onmessageerror() {
    return this.#onmessageerror;
  }

  set onmessageerror(value: ((event: MessageEvent) => void) | null) {
    this.#onmessageerror = value;
  }

  postMessage() {
    this.postMessageCalls++;
  }

  terminate() {
    this.terminateCalls++;
  }
}

type ThrowingCleanupStep =
  | "message"
  | "error"
  | "messageError"
  | "terminate";

class ThrowingCleanupWorker {
  #onmessage: ((event: MessageEvent<WorkerResult>) => void) | null = null;
  #onerror: ((event: ErrorEvent) => void) | null = null;
  #onmessageerror: ((event: MessageEvent) => void) | null = null;
  #cleanupThrown = false;
  readonly cleanupError: Error;
  postMessageCalls = 0;
  terminateAttempts = 0;
  terminated = false;

  constructor(
    private readonly throwingStep: ThrowingCleanupStep,
    private readonly setupError?: Error,
  ) {
    this.cleanupError = new Error(`${throwingStep} cleanup failed`);
  }

  get onmessage() {
    return this.#onmessage;
  }

  set onmessage(value: ((event: MessageEvent<WorkerResult>) => void) | null) {
    if (
      value === null && this.#onmessage !== null &&
      this.throwingStep === "message" && !this.#cleanupThrown
    ) {
      this.#cleanupThrown = true;
      throw this.cleanupError;
    }
    this.#onmessage = value;
    if (value !== null && this.setupError) throw this.setupError;
  }

  get onerror() {
    return this.#onerror;
  }

  set onerror(value: ((event: ErrorEvent) => void) | null) {
    if (
      value === null && this.#onerror !== null &&
      this.throwingStep === "error" && !this.#cleanupThrown
    ) {
      this.#cleanupThrown = true;
      throw this.cleanupError;
    }
    this.#onerror = value;
  }

  get onmessageerror() {
    return this.#onmessageerror;
  }

  set onmessageerror(value: ((event: MessageEvent) => void) | null) {
    if (
      value === null && this.#onmessageerror !== null &&
      this.throwingStep === "messageError" && !this.#cleanupThrown
    ) {
      this.#cleanupThrown = true;
      throw this.cleanupError;
    }
    this.#onmessageerror = value;
  }

  postMessage() {
    this.postMessageCalls++;
  }

  terminate() {
    this.terminateAttempts++;
    if (this.throwingStep === "terminate" && !this.#cleanupThrown) {
      this.#cleanupThrown = true;
      throw this.cleanupError;
    }
    this.terminated = true;
  }
}

function fakeSetup(root = new Directory(new Map())) {
  const workers: FakeWorker[] = [];
  const clock = new FakeClock();
  const wasiRef = { inherited: "farm-ref" };
  let wasiRefCalls = 0;
  const options: ChildProcessBridgeOptions = {
    getWasiRef: () => {
      wasiRefCalls++;
      return wasiRef;
    },
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    timers: clock,
  };
  return {
    bridge: createChildProcessBridge(options),
    clock,
    get wasiRefCalls() {
      return wasiRefCalls;
    },
    root,
    wasiRef,
    workers,
  };
}

async function start(
  bridge: ReturnType<typeof createChildProcessBridge>,
  module: Uint8Array,
  args = ["child", "first"],
  env = ["KEY=value"],
) {
  const started = await bridge(message("childProcessStart", {
    argv: Array.from(encoder.encode(args.join("\0"))),
    env: Array.from(encoder.encode(env.join("\0"))),
    module_len: module.length,
  })) as { request_id: number };
  for (let offset = 0; offset < module.length; offset += 256 * 1024) {
    await bridge(message("childProcessWrite", {
      request_id: started.request_id,
      chunk: Array.from(module.subarray(offset, offset + 256 * 1024)),
    }));
  }
  return started.request_id;
}

async function compileWat(name: string, wat: string) {
  const watPath = `/tmp/opencode/${name}.wat`;
  const wasmPath = `/tmp/opencode/${name}.wasm`;
  await Deno.writeTextFile(watPath, wat);
  const output = await new Deno.Command("wasm-tools", {
    args: ["parse", watPath, "-o", wasmPath],
    stderr: "piped",
  }).output();
  assert(
    output.success,
    `wasm-tools parse failed: ${decoder.decode(output.stderr)}`,
  );
  return await Deno.readFile(wasmPath);
}

function realBridge(root: PreopenDirectory, farm: WASIFarm, timeout = 120_000) {
  return createChildProcessBridge({
    getWasiRef: () => farm.get_ref(),
    workerUrl,
    filesystemRoot: root.dir,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: timeout,
  });
}

Deno.test("child process message guard accepts only protocol messages", () => {
  assert(
    isChildProcessMessage(message("childProcessRecover", {})),
    "valid message rejected",
  );
  assert(
    !isChildProcessMessage({ name: "childProcessRecover" }),
    "missing args accepted",
  );
  assert(
    !isChildProcessMessage({ name: "httpRequestStart", args: {} }),
    "foreign message accepted",
  );
});

Deno.test("legacy child bridge callable exposes protocol response fields", async () => {
  const bridge = createChildProcessBridge({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: new Directory(new Map()),
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
  });
  const started = await bridge({
    name: "childProcessStart",
    args: { argv: [], env: [], module_len: 0 },
  });
  const requestId: number = started.request_id;
  const state: number = started.state;
  assertEquals(requestId, 1, "legacy request ID");
  assertEquals(state, 1, "legacy upload state");
  await bridge({
    name: "childProcessEnd",
    args: { request_id: requestId },
  });

  const permittedEmptyResponse: ChildProcessBridgeResponse = undefined;
  assertEquals(permittedEmptyResponse, undefined, "permitted empty response");
});

Deno.test("child owner disposal rejects Run and tears down once", async () => {
  const root = new Directory(new Map());
  const workers: FakeWorker[] = [];
  const clock = new FakeClock();
  const owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    timers: clock,
  });
  const started = await owner.handle(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 0,
  })) as { request_id: number };
  const pendingRun = owner.handle(message("childProcessRun", {
    request_id: started.request_id,
  }));
  void pendingRun.catch(() => undefined);

  await owner.dispose();

  assertEquals(clock.cleared, 2, "upload and execution timers");
  assertEquals(clock.pending, 0, "disposal retained a timer");
  assertEquals(workers[0].terminateCalls, 1, "Worker termination count");
  assertEquals(workers[0].onmessage, null, "message listener was retained");
  assertEquals(workers[0].onerror, null, "error listener was retained");
  assertEquals(
    workers[0].onmessageerror,
    null,
    "message-error listener was retained",
  );
  assertEquals(
    workers[0].listenerClears,
    { message: 1, error: 1, messageError: 1 },
    "listener cleanup counts",
  );
  await assertRejects(() => pendingRun, "runtime disposed");

  const cleared = clock.cleared;
  await owner.dispose();
  assertEquals(clock.cleared, cleared, "second disposal cleared timers again");
  assertEquals(
    workers[0].terminateCalls,
    1,
    "second disposal terminated the Worker again",
  );
});

for (const setupFailure of ["listener", "timer"] as const) {
  Deno.test(`child owner cleans once when ${setupFailure} setup throws`, async () => {
    const setupError = new Error(`${setupFailure} setup failed`);
    const worker = new FakeWorker(
      setupFailure === "listener",
      setupError,
    );
    const clock = new FakeClock();
    const timers = {
      setTimeout(callback: () => void, delay: number) {
        if (setupFailure === "timer" && delay === 120_000) {
          throw setupError;
        }
        return clock.setTimeout(callback, delay);
      },
      clearTimeout: clock.clearTimeout,
    };
    const owner = createChildProcessBridgeOwner({
      getWasiRef: () => ({}),
      workerUrl,
      filesystemRoot: new Directory(new Map()),
      uploadTimeoutMs: 30_000,
      executionTimeoutMs: 120_000,
      createWorker: () => worker,
      timers,
    });
    const started = await owner.handle(message("childProcessStart", {
      argv: [],
      env: [],
      module_len: 0,
    })) as { request_id: number };

    let rejectedWith: unknown;
    try {
      await owner.handle(message("childProcessRun", {
        request_id: started.request_id,
      }));
    } catch (error) {
      rejectedWith = error;
    }
    assert(
      rejectedWith === setupError,
      `${setupFailure} setup rejection identity changed`,
    );
    assertEquals(worker.terminateCalls, 1, `${setupFailure} termination count`);
    assertEquals(clock.pending, 0, `${setupFailure} retained timer`);
    assertEquals(worker.posted, undefined, `${setupFailure} posted to Worker`);
    assertEquals(worker.onmessage, null, `${setupFailure} message listener`);
    assertEquals(worker.onerror, null, `${setupFailure} error listener`);
    assertEquals(
      worker.onmessageerror,
      null,
      `${setupFailure} message-error listener`,
    );

    const listenerClears = { ...worker.listenerClears };
    await owner.dispose();
    assertEquals(
      worker.terminateCalls,
      1,
      `${setupFailure} disposal terminated Worker again`,
    );
    assertEquals(
      worker.listenerClears,
      listenerClears,
      `${setupFailure} disposal removed listeners again`,
    );
  });
}

Deno.test("child owner rolls back abort during upload timer acquisition", async () => {
  const generation = new AbortController();
  const reason = { boundary: "upload timer" };
  const clock = new FakeClock();
  const owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: new Directory(new Map()),
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => {
      throw new Error("Worker created after upload abort");
    },
    timers: {
      setTimeout(callback, delay) {
        const id = clock.setTimeout(callback, delay);
        if (delay === 30_000) generation.abort(reason);
        return id;
      },
      clearTimeout: clock.clearTimeout,
    },
    signal: generation.signal,
  });

  let rejectedWith: unknown;
  try {
    await owner.handle(message("childProcessStart", {
      argv: [],
      env: [],
      module_len: 0,
    }));
  } catch (error) {
    rejectedWith = error;
  }
  assert(rejectedWith === reason, "upload timer abort reason identity changed");
  assertEquals(clock.pending, 0, "upload abort retained its acquired timer");
  await owner.dispose();
});

Deno.test("child owner stops Run after upload timer clear aborts", async () => {
  const generation = new AbortController();
  const reason = { boundary: "clear upload timer" };
  const clock = new FakeClock();
  let abortOnClear = false;
  let workerCalls = 0;
  const owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: new Directory(new Map()),
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => {
      workerCalls++;
      return new FakeWorker();
    },
    timers: {
      setTimeout: clock.setTimeout,
      clearTimeout(id) {
        clock.clearTimeout(id);
        if (abortOnClear) generation.abort(reason);
      },
    },
    signal: generation.signal,
  });
  const started = await owner.handle(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 0,
  })) as { request_id: number };
  abortOnClear = true;

  let rejectedWith: unknown;
  try {
    await owner.handle(message("childProcessRun", {
      request_id: started.request_id,
    }));
  } catch (error) {
    rejectedWith = error;
  }
  assert(rejectedWith === reason, "timer clear abort reason identity changed");
  assertEquals(workerCalls, 0, "Run created a Worker after timer clear abort");
  assertEquals(clock.pending, 0, "timer clear abort retained a timer");
  await owner.dispose();
});

Deno.test("child owner releases a request when upload timer setup throws", async () => {
  const setupError = new Error("upload timer setup failed");
  const owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: new Directory(new Map()),
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    timers: {
      setTimeout() {
        throw setupError;
      },
      clearTimeout() {},
    },
  });

  let rejectedWith: unknown;
  try {
    await owner.handle(message("childProcessStart", {
      argv: [],
      env: [],
      module_len: 0,
    }));
  } catch (error) {
    rejectedWith = error;
  }
  assert(rejectedWith === setupError, "upload timer setup error changed");
  assertEquals(
    await owner.handle(message("childProcessRecover", {})),
    { request_id: 0, state: 0, status: 0, error_len: 0 },
    "failed upload timer retained the request slot",
  );
  await owner.dispose();
});

for (
  const boundary of [
    "createWorker",
    "onmessage",
    "onerror",
    "onmessageerror",
    "setTimeout",
    "getWasiRef",
    "postMessage",
  ] as const
) {
  Deno.test(`child owner rolls back a synchronous abort from ${boundary}`, async () => {
    const generation = new AbortController();
    const reason = { boundary };
    const clock = new FakeClock();
    let aborted = false;
    const abortGeneration = () => {
      if (aborted) return;
      aborted = true;
      generation.abort(reason);
    };
    const worker = new AbortBoundaryWorker(boundary, abortGeneration);
    const timers = {
      setTimeout(callback: () => void, delay: number) {
        const id = clock.setTimeout(callback, delay);
        if (boundary === "setTimeout" && delay === 120_000) {
          abortGeneration();
        }
        return id;
      },
      clearTimeout: clock.clearTimeout,
    };
    const owner = createChildProcessBridgeOwner({
      getWasiRef: () => {
        if (boundary === "getWasiRef") abortGeneration();
        return {};
      },
      workerUrl,
      filesystemRoot: new Directory(new Map()),
      uploadTimeoutMs: 30_000,
      executionTimeoutMs: 120_000,
      createWorker: () => {
        if (boundary === "createWorker") abortGeneration();
        return worker;
      },
      timers,
      signal: generation.signal,
    });
    const started = await owner.handle(message("childProcessStart", {
      argv: [],
      env: [],
      module_len: 0,
    })) as { request_id: number };
    const pendingRun = owner.handle(message("childProcessRun", {
      request_id: started.request_id,
    }));
    void pendingRun.catch(() => undefined);

    let rejectedWith: unknown;
    try {
      await pendingRun;
    } catch (error) {
      rejectedWith = error;
    }
    assert(rejectedWith === reason, `${boundary} abort reason identity changed`);
    assertEquals(worker.terminateCalls, 1, `${boundary} Worker termination`);
    assertEquals(worker.onmessage, null, `${boundary} message listener`);
    assertEquals(worker.onerror, null, `${boundary} error listener`);
    assertEquals(
      worker.onmessageerror,
      null,
      `${boundary} message-error listener`,
    );
    assertEquals(clock.pending, 0, `${boundary} retained a timer`);
    if (boundary === "createWorker") {
      assertEquals(clock.scheduled, 1, "created an execution timer after abort");
      assertEquals(worker.postMessageCalls, 0, "posted to Worker after abort");
    }

    const listenerClears = { ...worker.listenerClears };
    await owner.settle();
    const firstDispose = owner.dispose();
    const secondDispose = owner.dispose();
    assert(firstDispose === secondDispose, `${boundary} disposal was not stable`);
    await firstDispose;
    assertEquals(
      worker.terminateCalls,
      1,
      `${boundary} cleanup record terminated Worker again`,
    );
    assertEquals(
      JSON.stringify(worker.listenerClears),
      JSON.stringify(listenerClears),
      `${boundary} cleanup record removed listeners again`,
    );
  });
}

Deno.test("child owner clears a callback stored after synchronous abort", async () => {
  const generation = new AbortController();
  const reason = { boundary: "abort before listener store" };
  const clock = new FakeClock();
  const worker = new AbortBeforeStoreWorker(() => generation.abort(reason));
  const owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: new Directory(new Map()),
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => worker,
    timers: clock,
    signal: generation.signal,
  });
  const started = await owner.handle(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 0,
  })) as { request_id: number };
  const pendingRun = owner.handle(message("childProcessRun", {
    request_id: started.request_id,
  }));
  void pendingRun.catch(() => undefined);

  let rejectedWith: unknown;
  try {
    await pendingRun;
  } catch (error) {
    rejectedWith = error;
  }
  assert(rejectedWith === reason, "post-store abort reason identity changed");
  assertEquals(worker.onmessage, null, "post-abort callback was retained");
  assertEquals(worker.onerror, null, "post-abort error listener was retained");
  assertEquals(
    worker.onmessageerror,
    null,
    "post-abort message-error listener was retained",
  );
  assertEquals(worker.terminateCalls, 1, "post-store Worker termination count");
  assertEquals(worker.postMessageCalls, 0, "post-store abort posted to Worker");
  assertEquals(clock.pending, 0, "post-store abort retained a timer");
  await owner.dispose();
});

for (
  const throwingStep of [
    "message",
    "error",
    "messageError",
    "terminate",
  ] as const
) {
  Deno.test(`child cleanup continues when ${throwingStep} cleanup throws`, async () => {
    const generation = new AbortController();
    const reason = { boundary: `${throwingStep} cleanup` };
    const root = new Directory(new Map([[
      "stable",
      new File([1]),
    ]]));
    const worker = new ThrowingCleanupWorker(throwingStep);
    const clock = new FakeClock();
    const reported: AggregateError[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const aggregate = args.find((value) => value instanceof AggregateError);
      if (aggregate instanceof AggregateError) reported.push(aggregate);
    };
    try {
      const owner = createChildProcessBridgeOwner({
        getWasiRef: () => ({}),
        workerUrl,
        filesystemRoot: root,
        uploadTimeoutMs: 30_000,
        executionTimeoutMs: 120_000,
        createWorker: () => worker,
        timers: clock,
        signal: generation.signal,
      });
      const started = await owner.handle(message("childProcessStart", {
        argv: [],
        env: [],
        module_len: 0,
      })) as { request_id: number };
      const pendingRun = owner.handle(message("childProcessRun", {
        request_id: started.request_id,
      }));
      const runOutcome = pendingRun.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      root.contents.set("stable", new File([2]));

      generation.abort(reason);
      const outcome = await Promise.race([
        runOutcome,
        new Promise<{ timeout: true }>((resolve) =>
          setTimeout(() => resolve({ timeout: true }), 50)
        ),
      ]);
      assert(!("timeout" in outcome), `${throwingStep} Run did not settle`);
      assert(
        "error" in outcome && outcome.error === reason,
        `${throwingStep} cleanup replaced the abort reason`,
      );
      assertEquals(
        Array.from((root.contents.get("stable") as File).data),
        [1],
        `${throwingStep} cleanup skipped filesystem restoration`,
      );
      assertEquals(clock.pending, 0, `${throwingStep} cleanup retained a timer`);

      const firstDispose = owner.dispose();
      const secondDispose = owner.dispose();
      assert(
        firstDispose === secondDispose,
        `${throwingStep} second dispose returned a new Promise`,
      );
      await firstDispose;

      assertEquals(worker.onmessage, null, `${throwingStep} message listener`);
      assertEquals(worker.onerror, null, `${throwingStep} error listener`);
      assertEquals(
        worker.onmessageerror,
        null,
        `${throwingStep} message-error listener`,
      );
      assert(worker.terminated, `${throwingStep} cleanup skipped termination`);
      assertEquals(
        worker.terminateAttempts,
        throwingStep === "terminate" ? 2 : 1,
        `${throwingStep} termination attempts`,
      );
      assertEquals(reported.length, 1, `${throwingStep} cleanup report count`);
      assert(
        reported[0].errors.includes(worker.cleanupError),
        `${throwingStep} cleanup error was not aggregated`,
      );
    } finally {
      console.error = originalConsoleError;
    }
  });
}

Deno.test("child cleanup continues when timer clearing throws", async () => {
  const generation = new AbortController();
  const reason = { boundary: "timer cleanup" };
  const cleanupError = new Error("timer cleanup failed");
  const root = new Directory(new Map([["stable", new File([1])]]));
  const worker = new FakeWorker();
  const clock = new FakeClock();
  let failClear = false;
  let clearThrown = false;
  const reported: AggregateError[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const aggregate = args.find((value) => value instanceof AggregateError);
    if (aggregate instanceof AggregateError) reported.push(aggregate);
  };
  try {
    const owner = createChildProcessBridgeOwner({
      getWasiRef: () => ({}),
      workerUrl,
      filesystemRoot: root,
      uploadTimeoutMs: 30_000,
      executionTimeoutMs: 120_000,
      createWorker: () => worker,
      timers: {
        setTimeout: clock.setTimeout,
        clearTimeout(id) {
          if (failClear && !clearThrown) {
            clearThrown = true;
            throw cleanupError;
          }
          clock.clearTimeout(id);
        },
      },
      signal: generation.signal,
    });
    const started = await owner.handle(message("childProcessStart", {
      argv: [],
      env: [],
      module_len: 0,
    })) as { request_id: number };
    const pendingRun = owner.handle(message("childProcessRun", {
      request_id: started.request_id,
    }));
    const outcome = pendingRun.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    root.contents.set("stable", new File([2]));
    failClear = true;

    generation.abort(reason);
    const settled = await outcome;
    assert(
      "error" in settled && settled.error === reason,
      "timer cleanup replaced the abort reason",
    );
    assert(worker.terminated, "timer cleanup skipped Worker termination");
    assertEquals(
      Array.from((root.contents.get("stable") as File).data),
      [1],
      "timer cleanup skipped filesystem restoration",
    );
    assertEquals(clock.pending, 1, "failed timer clear lost retry ownership");

    await owner.dispose();
    assertEquals(clock.pending, 0, "timer clear was not retried");
    assertEquals(worker.terminateCalls, 1, "timer retry terminated Worker again");
    assertEquals(reported.length, 1, "timer cleanup report count");
    assert(
      reported[0].errors.includes(cleanupError),
      "timer cleanup error was not aggregated",
    );
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("child cleanup continues when filesystem restoration throws", async () => {
  class ThrowOnceClearMap<K, V> extends Map<K, V> {
    failClear = false;
    thrown = false;
    readonly cleanupError = new Error("filesystem restoration failed");

    override clear() {
      if (this.failClear && !this.thrown) {
        this.thrown = true;
        throw this.cleanupError;
      }
      super.clear();
    }
  }

  const generation = new AbortController();
  const reason = { boundary: "filesystem cleanup" };
  const contents = new ThrowOnceClearMap<string, File>([[
    "stable",
    new File([1]),
  ]]);
  const root = new Directory(contents);
  const worker = new FakeWorker();
  const clock = new FakeClock();
  const reported: AggregateError[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const aggregate = args.find((value) => value instanceof AggregateError);
    if (aggregate instanceof AggregateError) reported.push(aggregate);
  };
  try {
    const owner = createChildProcessBridgeOwner({
      getWasiRef: () => ({}),
      workerUrl,
      filesystemRoot: root,
      uploadTimeoutMs: 30_000,
      executionTimeoutMs: 120_000,
      createWorker: () => worker,
      timers: clock,
      signal: generation.signal,
    });
    const started = await owner.handle(message("childProcessStart", {
      argv: [],
      env: [],
      module_len: 0,
    })) as { request_id: number };
    const pendingRun = owner.handle(message("childProcessRun", {
      request_id: started.request_id,
    }));
    const outcome = pendingRun.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    root.contents.set("stable", new File([2]));
    contents.failClear = true;

    generation.abort(reason);
    const settled = await outcome;
    assert(
      "error" in settled && settled.error === reason,
      "filesystem cleanup replaced the abort reason",
    );
    assert(worker.terminated, "filesystem cleanup skipped termination");
    assertEquals(clock.pending, 0, "filesystem cleanup retained a timer");

    await owner.dispose();
    assertEquals(
      Array.from((root.contents.get("stable") as File).data),
      [1],
      "filesystem restoration was not retried",
    );
    assertEquals(worker.terminateCalls, 1, "restore retry terminated Worker again");
    assertEquals(reported.length, 1, "filesystem cleanup report count");
    assert(
      reported[0].errors.includes(contents.cleanupError),
      "filesystem cleanup error was not aggregated",
    );
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("child setup error remains primary when cleanup also fails", async () => {
  const setupError = new Error("listener setup failed");
  const worker = new ThrowingCleanupWorker("message", setupError);
  const reported: AggregateError[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const aggregate = args.find((value) => value instanceof AggregateError);
    if (aggregate instanceof AggregateError) reported.push(aggregate);
  };
  try {
    const owner = createChildProcessBridgeOwner({
      getWasiRef: () => ({}),
      workerUrl,
      filesystemRoot: new Directory(new Map()),
      uploadTimeoutMs: 30_000,
      executionTimeoutMs: 120_000,
      createWorker: () => worker,
    });
    const started = await owner.handle(message("childProcessStart", {
      argv: [],
      env: [],
      module_len: 0,
    })) as { request_id: number };
    let rejectedWith: unknown;
    try {
      await owner.handle({
        name: "childProcessRun",
        args: { request_id: started.request_id },
      });
    } catch (error) {
      rejectedWith = error;
    }
    assert(rejectedWith === setupError, "cleanup error replaced setup rejection");

    await owner.dispose();
    assertEquals(worker.onmessage, null, "setup cleanup retained message listener");
    assert(worker.terminated, "setup cleanup skipped termination");
    assertEquals(reported.length, 1, "setup cleanup report count");
    assert(
      reported[0].errors.includes(worker.cleanupError),
      "setup cleanup error was not aggregated",
    );
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("child setup preserves an uncoercible thrown object", async () => {
  const coercionError = new Error("setup error coercion attempted");
  const setupError = {
    [Symbol.toPrimitive]() {
      throw coercionError;
    },
  };
  const root = new Directory(new Map([["stable", new File([1])]]));
  const worker = new FakeWorker();
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const owner = createChildProcessBridgeOwner({
      getWasiRef: () => {
        root.contents.set("stable", new File([2]));
        throw setupError;
      },
      workerUrl,
      filesystemRoot: root,
      uploadTimeoutMs: 30_000,
      executionTimeoutMs: 120_000,
      createWorker: () => worker,
    });
    const started = await owner.handle(message("childProcessStart", {
      argv: [],
      env: [],
      module_len: 0,
    })) as { request_id: number };
    let rejectedWith: unknown;
    try {
      await owner.handle({
        name: "childProcessRun",
        args: { request_id: started.request_id },
      });
    } catch (error) {
      rejectedWith = error;
    }

    await owner.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert(rejectedWith === setupError, "setup rejection identity changed");
    assertEquals(unhandled, [], "orphan Run rejection was unhandled");
    assertEquals(worker.terminateCalls, 1, "setup failure termination count");
    assertEquals(worker.onmessage, null, "setup failure retained listener");
    assertEquals(
      Array.from((root.contents.get("stable") as File).data),
      [1],
      "setup failure skipped rollback",
    );
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("child Worker error message formatting never throws", async () => {
  const workerError = {
    [Symbol.toPrimitive]() {
      throw new Error("coercion failed");
    },
  };
  const invalidResult = Object.defineProperty({}, "status", {
    get() {
      throw workerError;
    },
  });
  const worker = new FakeWorker();
  worker.onmessage = () => {};
  const owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: new Directory(new Map()),
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => ({
      ...worker,
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage() {
        this.onmessage?.(new MessageEvent<WorkerResult>("message", {
          data: invalidResult as unknown as WorkerResult,
        }));
      },
      terminate: () => worker.terminate(),
    }),
  });
  const started = await owner.handle({
    name: "childProcessStart",
    args: { argv: [], env: [], module_len: 0 },
  });
  const result = await owner.handle({
    name: "childProcessRun",
    args: { request_id: started.request_id },
  });
  assertEquals(result.status, 126, "uncoercible Worker result status");
  assert(result.error_len > 0, "uncoercible Worker result lost metadata");
  const errorResponse = await owner.handle({
    name: "childProcessReadError",
    args: { request_id: started.request_id, chunk_len: result.error_len },
  });
  assertEquals(
    decoder.decode(Uint8Array.from(errorResponse.chunk)),
    "Unknown child process error",
    "uncoercible Worker result fallback",
  );
  await owner.dispose();
});

Deno.test("bridge rejects timeout values that overflow platform timers", () => {
  const root = new Directory(new Map());
  const base = {
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
  };
  try {
    createChildProcessBridge({ ...base, executionTimeoutMs: 0x8000_0000 });
  } catch (error) {
    assert(String(error).includes("executionTimeoutMs"), "wrong timeout error");
    return;
  }
  throw new Error("overflowing execution timeout was accepted");
});

Deno.test("bridge lazily reuses the parent farm ref for sequential children", async () => {
  const setup = fakeSetup();
  const { bridge, wasiRef, workers } = setup;
  const module = new Uint8Array(256 * 1024 + 2).fill(7);
  assertEquals(setup.wasiRefCalls, 0, "farm ref was read during setup");
  const requestId = await start(bridge, module);
  assertEquals(setup.wasiRefCalls, 0, "farm ref was read during upload");
  await assertRejects(
    () =>
      bridge(
        message("childProcessStart", { argv: [], env: [], module_len: 0 }),
      ),
    "already active",
  );

  const run = bridge(message("childProcessRun", { request_id: requestId }));
  assertEquals(setup.wasiRefCalls, 1, "farm ref was not read at run time");
  assertEquals(workers[0].posted, {
    module: module.buffer,
    wasiRef,
    args: ["child", "first"],
    env: ["KEY=value"],
  }, "worker input");
  workers[0].finish({ status: 0, graceful: true });
  assertEquals(await run, { state: 3, status: 0, error_len: 0 });
  assert(workers[0].terminated, "completed Worker was not terminated");
  assertEquals(
    await bridge(message("childProcessRecover", {})),
    { request_id: requestId, state: 3, status: 0, error_len: 0 },
  );
  await assertRejects(
    () =>
      bridge(
        message("childProcessStart", { argv: [], env: [], module_len: 0 }),
      ),
    "already active",
  );
  assertEquals(
    await bridge(message("childProcessEnd", { request_id: requestId })),
    {},
  );
  const secondRequestId = await start(bridge, Uint8Array.of(1));
  const secondRun = bridge(message("childProcessRun", {
    request_id: secondRequestId,
  }));
  assertEquals(setup.wasiRefCalls, 2, "second child did not read parent ref");
  assertEquals(
    (workers[1].posted as { wasiRef: unknown }).wasiRef,
    wasiRef,
    "second child did not reuse parent ref",
  );
  workers[1].finish({ status: 0, graceful: true });
  assertEquals(await secondRun, { state: 3, status: 0, error_len: 0 });
  await bridge(message("childProcessEnd", { request_id: secondRequestId }));
  assertEquals(
    await bridge(message("childProcessEnd", { request_id: requestId })),
    {},
  );
  assertEquals(
    await bridge(message("childProcessRecover", {})),
    { request_id: 0, state: 0, status: 0, error_len: 0 },
  );
});

Deno.test("bridge exports no isolated child farm session helper", () => {
  assert(
    !Object.hasOwn(childProcessBridgeModule, "createChildProcessWasiSession"),
    "isolated child WASI session helper is still exported",
  );
});

Deno.test("bridge enforces module and chunk bounds and exact upload length", async () => {
  const root = new Directory(new Map([["stable", new File([1])]]));
  const { bridge } = fakeSetup(root);
  await assertRejects(
    () =>
      bridge(message("childProcessStart", {
        argv: [],
        env: [],
        module_len: 16 * 1024 * 1024 + 1,
      })),
    "16 MiB",
  );
  const started = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 1,
  })) as { request_id: number };
  root.contents.set("stable", new File([2]));
  await assertRejects(
    () =>
      bridge(message("childProcessWrite", {
        request_id: started.request_id,
        chunk: new Array(256 * 1024 + 1).fill(0),
      })),
    "256 KiB",
  );
  assertEquals(Array.from((root.contents.get("stable") as File).data), [1]);
  assertEquals(await bridge(message("childProcessRecover", {})), {
    request_id: 0,
    state: 0,
    status: 0,
    error_len: 0,
  });

  const short = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 1,
  })) as { request_id: number };
  await assertRejects(
    () => bridge(message("childProcessRun", { request_id: short.request_id })),
    "uploaded length",
  );
  assertEquals(
    (await bridge(message("childProcessRecover", {})) as { state: number })
      .state,
    0,
  );
});

Deno.test("zero-length writes abort without refreshing upload inactivity", async () => {
  const root = new Directory(new Map([["stable", new File([1])]]));
  const { bridge, clock } = fakeSetup(root);
  const started = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 1,
  })) as { request_id: number };
  const scheduledBefore = clock.scheduled;
  root.contents.set("stable", new File([2]));

  await assertRejects(
    () =>
      bridge(message("childProcessWrite", {
        request_id: started.request_id,
        chunk: [],
      })),
    "empty",
  );

  assertEquals(
    clock.scheduled,
    scheduledBefore,
    "empty write refreshed timeout",
  );
  assertEquals(clock.pending, 0, "empty write retained upload timeout");
  assertEquals(Array.from((root.contents.get("stable") as File).data), [1]);
  assertEquals(await bridge(message("childProcessRecover", {})), {
    request_id: 0,
    state: 0,
    status: 0,
    error_len: 0,
  });
});

Deno.test("tiny positive writes assemble one exact bounded module", async () => {
  const { bridge, clock, workers } = fakeSetup();
  const module = new Uint8Array(4096);
  for (let index = 0; index < module.length; index++) {
    module[index] = index % 251;
  }
  const started = await bridge(message("childProcessStart", {
    argv: Array.from(encoder.encode("child")),
    env: [],
    module_len: module.length,
  })) as { request_id: number };
  for (const byte of module) {
    await bridge(message("childProcessWrite", {
      request_id: started.request_id,
      chunk: [byte],
    }));
  }
  assertEquals(clock.pending, 1, "positive progress retained multiple timers");
  assertEquals(
    clock.scheduled,
    module.length + 1,
    "positive progress did not refresh timer",
  );
  const run = bridge(
    message("childProcessRun", { request_id: started.request_id }),
  );
  assertEquals(
    Array.from(
      new Uint8Array((workers[0].posted as { module: ArrayBuffer }).module),
    ),
    Array.from(module),
    "tiny writes changed module bytes",
  );
  workers[0].finish({ status: 0, graceful: true });
  await run;
});

Deno.test("raw argv env and module chunk caps reject before element traversal", async () => {
  const hostile = () => {
    const value: number[] = [];
    value.length = 256 * 1024 + 1;
    Object.defineProperty(value, 0, {
      get() {
        throw new Error("hostile array was traversed");
      },
    });
    return value;
  };

  await assertRejects(
    () =>
      fakeSetup().bridge(message("childProcessStart", {
        argv: hostile(),
        env: [],
        module_len: 0,
      })),
    "argv exceeds 256 KiB",
  );
  await assertRejects(
    () =>
      fakeSetup().bridge(message("childProcessStart", {
        argv: [],
        env: hostile(),
        module_len: 0,
      })),
    "env exceeds 256 KiB",
  );

  const { bridge } = fakeSetup();
  const started = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 16 * 1024 * 1024,
  })) as { request_id: number };
  await assertRejects(
    () =>
      bridge(message("childProcessWrite", {
        request_id: started.request_id,
        chunk: hostile(),
      })),
    "module chunk exceeds 256 KiB",
  );
});

Deno.test("byte conversion ignores caller-controlled array iterators", async () => {
  const chunk = [91];
  chunk[Symbol.iterator] = () => {
    throw new Error("caller iterator was traversed");
  };
  const { bridge } = fakeSetup();
  const started = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 1,
  })) as { request_id: number };

  await bridge(message("childProcessWrite", {
    request_id: started.request_id,
    chunk,
  }));
});

Deno.test("byte conversion rejects non-numeric proxy array lengths", async () => {
  const fakeLength = {
    valueOf: () => 1,
    [Symbol.iterator]: () => {
      throw new Error("proxy length iterator was traversed");
    },
  };
  const chunk = new Proxy([91], {
    get(target, property, receiver) {
      if (property === "length") return fakeLength;
      return Reflect.get(target, property, receiver);
    },
  });
  const { bridge } = fakeSetup();
  const started = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 1,
  })) as { request_id: number };

  await assertRejects(
    () =>
      bridge(message("childProcessWrite", {
        request_id: started.request_id,
        chunk,
      })),
    "module chunk length must be a number",
  );
});

Deno.test("null-delimited metadata rejects empty argv and env entries", async () => {
  await assertRejects(
    () =>
      fakeSetup().bridge(message("childProcessStart", {
        argv: Array.from(encoder.encode("child\0")),
        env: [],
        module_len: 0,
      })),
    "argv contains an empty entry",
  );
  await assertRejects(
    () =>
      fakeSetup().bridge(message("childProcessStart", {
        argv: [],
        env: Array.from(encoder.encode("A=B\0")),
        module_len: 0,
      })),
    "env contains an empty entry",
  );

  const { bridge } = fakeSetup();
  const started = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 0,
  })) as { request_id: number };
  await bridge(message("childProcessEnd", { request_id: started.request_id }));
});

Deno.test("inactive upload restores its deep filesystem baseline", async () => {
  const originalFile = new File(encoder.encode("before"));
  const nested = new Directory(
    new Map([
      ["before.txt", originalFile],
    ]),
  );
  const root = new Directory(new Map([["nested", nested]]));
  const { bridge, clock } = fakeSetup(root);
  await bridge(
    message("childProcessStart", { argv: [], env: [], module_len: 2 }),
  );
  nested.contents.set("before.txt", new File(encoder.encode("changed")));
  nested.contents.set("new.txt", new File(encoder.encode("new")));
  clock.fireAll();

  const restored = (root.contents.get("nested") as Directory).contents;
  assertEquals([...restored.keys()], ["before.txt"]);
  assertEquals(
    decoder.decode((restored.get("before.txt") as File).data),
    "before",
  );
  assert(
    restored.get("before.txt") === originalFile,
    "rollback replaced file inode",
  );
  assert(
    root.contents.get("nested") === nested,
    "rollback replaced directory inode",
  );
  assertEquals(
    await bridge(message("childProcessRecover", {})),
    { request_id: 0, state: 0, status: 0, error_len: 0 },
  );
});

Deno.test("trap rolls back files while capping retained runner error at 64 KiB", async () => {
  const root = new Directory(
    new Map([
      ["data.txt", new File(encoder.encode("before"))],
    ]),
  );
  const { bridge, workers } = fakeSetup(root);
  const requestId = await start(bridge, Uint8Array.of(0));
  const run = bridge(message("childProcessRun", { request_id: requestId }));
  root.contents.set("data.txt", new File(encoder.encode("partial")));
  root.contents.set("orphan.txt", new File([]));
  const runnerError = "x".repeat(64 * 1024 + 1);
  workers[0].finish({
    status: 126,
    error: runnerError,
    graceful: false,
  });
  const result = await run as { status: number; error_len: number };
  assertEquals(result, {
    state: 3,
    status: 126,
    error_len: 64 * 1024,
  });
  assertEquals([...root.contents.keys()], ["data.txt"]);
  assertEquals(
    decoder.decode((root.contents.get("data.txt") as File).data),
    "before",
  );
  const error = await bridge(message("childProcessReadError", {
    request_id: requestId,
    chunk_len: result.error_len,
  })) as { chunk: number[] };
  assertEquals(
    decoder.decode(Uint8Array.from(error.chunk)),
    runnerError.slice(0, 64 * 1024),
  );
  await assertRejects(
    () =>
      bridge(
        message("childProcessReadError", {
          request_id: requestId,
          chunk_len: 1,
        }),
      ),
    "remaining",
  );
});

Deno.test("execution timeout terminates and rolls back the running child", async () => {
  const root = new Directory(new Map([["stable", new File([1])]]));
  const { bridge, clock, workers } = fakeSetup(root);
  const requestId = await start(bridge, Uint8Array.of(0));
  const run = bridge(message("childProcessRun", { request_id: requestId }));
  root.contents.set("stable", new File([2]));
  clock.fireAll();
  const result = await run as { status: number; error_len: number };
  assert(workers[0].terminated, "timed out Worker was not terminated");
  assertEquals(result.status, 124);
  assert(result.error_len > 0, "timeout had no runner error");
  assertEquals(Array.from((root.contents.get("stable") as File).data), [1]);
  assertEquals(
    (await bridge(message("childProcessRecover", {})) as { state: number })
      .state,
    3,
  );
});

Deno.test("uploading recovery rolls back once and retains the slot until end", async () => {
  const root = new Directory(new Map([["stable", new File([1])]]));
  const { bridge, clock } = fakeSetup(root);
  const uploaded = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 1,
  })) as { request_id: number };
  root.contents.set("stable", new File([2]));

  const recovered = {
    request_id: uploaded.request_id,
    state: 1,
    status: 0,
    error_len: 0,
  };
  assertEquals(await bridge(message("childProcessRecover", {})), recovered);
  assertEquals(Array.from((root.contents.get("stable") as File).data), [1]);
  assertEquals(clock.pending, 0, "upload recovery retained its timer");
  const clearedAfterFirstRecovery = clock.cleared;

  root.contents.set("stable", new File([3]));
  assertEquals(await bridge(message("childProcessRecover", {})), recovered);
  assertEquals(
    Array.from((root.contents.get("stable") as File).data),
    [3],
    "repeated upload recovery restored the baseline again",
  );
  assertEquals(clock.cleared, clearedAfterFirstRecovery);
  await assertRejects(
    () =>
      bridge(
        message("childProcessStart", { argv: [], env: [], module_len: 0 }),
      ),
    "already active",
  );

  await bridge(message("childProcessEnd", { request_id: uploaded.request_id }));
  await bridge(message("childProcessEnd", { request_id: uploaded.request_id }));
  const next = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 0,
  })) as { request_id: number };
  await bridge(message("childProcessEnd", { request_id: next.request_id }));
});

Deno.test("running recovery rolls back once and retains the slot until end", async () => {
  const root = new Directory(new Map([["stable", new File([1])]]));
  const { bridge, clock, workers } = fakeSetup(root);
  const requestId = await start(bridge, Uint8Array.of(0));
  const pendingRun = bridge(
    message("childProcessRun", { request_id: requestId }),
  );
  root.contents.set("stable", new File([2]));

  const recovered = {
    request_id: requestId,
    state: 2,
    status: 0,
    error_len: 0,
  };
  assertEquals(await bridge(message("childProcessRecover", {})), recovered);
  assert(workers[0].terminated, "recovered Worker was not terminated");
  assertEquals(workers[0].terminateCalls, 1);
  assertEquals(Array.from((root.contents.get("stable") as File).data), [1]);
  assertEquals(clock.pending, 0, "running recovery retained its timer");
  assertEquals(await pendingRun, { state: 3, status: 126, error_len: 0 });
  const clearedAfterFirstRecovery = clock.cleared;

  root.contents.set("stable", new File([3]));
  assertEquals(await bridge(message("childProcessRecover", {})), recovered);
  assertEquals(
    Array.from((root.contents.get("stable") as File).data),
    [3],
    "repeated running recovery restored the baseline again",
  );
  assertEquals(workers[0].terminateCalls, 1);
  assertEquals(clock.cleared, clearedAfterFirstRecovery);
  await assertRejects(
    () =>
      bridge(
        message("childProcessStart", { argv: [], env: [], module_len: 0 }),
      ),
    "already active",
  );

  await bridge(message("childProcessEnd", { request_id: requestId }));
  await bridge(message("childProcessEnd", { request_id: requestId }));
  const next = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 0,
  })) as { request_id: number };
  await bridge(message("childProcessEnd", { request_id: next.request_id }));
});

Deno.test("synchronous Worker completion resolves run without a race", async () => {
  const root = new Directory(new Map());
  const worker = new FakeWorker();
  worker.postMessage = (value: unknown) => {
    worker.posted = structuredClone(value);
    worker.finish({ status: 7, graceful: true });
  };
  const bridge = createChildProcessBridge({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => worker,
  });
  const requestId = await start(bridge, Uint8Array.of(0));
  const result = await Promise.race([
    bridge(message("childProcessRun", { request_id: requestId })),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("synchronous Worker result was lost")),
        50,
      )
    ),
  ]);
  assertEquals(result, { state: 3, status: 7, error_len: 0 });
});

Deno.test("synchronous Worker completion releases active cleanup before dispose", async () => {
  const root = new Directory(new Map([["stable", new File([1])]]));
  const worker = new FakeWorker();
  const clock = new FakeClock();
  worker.postMessage = (value: unknown) => {
    worker.posted = structuredClone(value);
    root.contents.set("stable", new File([2]));
    worker.finish({ status: 0, graceful: true });
  };
  const owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => worker,
    timers: clock,
  });
  const started = await owner.handle({
    name: "childProcessStart",
    args: { argv: [], env: [], module_len: 0 },
  });
  assertEquals(
    await owner.handle({
      name: "childProcessRun",
      args: { request_id: started.request_id },
    }),
    { state: 3, status: 0, error_len: 0 },
    "synchronous completion result",
  );
  const cleanupCounts = {
    cleared: clock.cleared,
    listenerClears: { ...worker.listenerClears },
    terminateCalls: worker.terminateCalls,
  };

  const firstDispose = owner.dispose();
  const secondDispose = owner.dispose();
  assert(firstDispose === secondDispose, "synchronous disposal Promise changed");
  await firstDispose;

  assertEquals(
    Array.from((root.contents.get("stable") as File).data),
    [2],
    "dispose rolled back a gracefully completed request",
  );
  assertEquals(clock.cleared, cleanupCounts.cleared, "dispose cleared another timer");
  assertEquals(
    worker.listenerClears,
    cleanupCounts.listenerClears,
    "dispose cleared listeners again",
  );
  assertEquals(
    worker.terminateCalls,
    cleanupCounts.terminateCalls,
    "dispose terminated Worker again",
  );
});

Deno.test("synchronous graceful completion wins before postMessage throws", async () => {
  const root = new Directory(new Map([["stable", new File([1])]]));
  const worker = new FakeWorker();
  const clock = new FakeClock();
  const postError = new Error("postMessage failed after completion");
  worker.postMessage = (value: unknown) => {
    worker.posted = structuredClone(value);
    root.contents.set("stable", new File([2]));
    worker.finish({ status: 0, graceful: true });
    throw postError;
  };
  const owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => worker,
    timers: clock,
  });
  const started = await owner.handle({
    name: "childProcessStart",
    args: { argv: [], env: [], module_len: 0 },
  });

  assertEquals(
    await owner.handle({
      name: "childProcessRun",
      args: { request_id: started.request_id },
    }),
    { state: 3, status: 0, error_len: 0 },
    "post-throw completion result",
  );
  const cleanupCounts = {
    cleared: clock.cleared,
    listenerClears: { ...worker.listenerClears },
    terminateCalls: worker.terminateCalls,
  };
  await owner.dispose();

  assertEquals(
    Array.from((root.contents.get("stable") as File).data),
    [2],
    "post-throw completion was rolled back",
  );
  assertEquals(clock.cleared, cleanupCounts.cleared, "post-throw timer cleanup repeated");
  assertEquals(
    worker.listenerClears,
    cleanupCounts.listenerClears,
    "post-throw listener cleanup repeated",
  );
  assertEquals(
    worker.terminateCalls,
    cleanupCounts.terminateCalls,
    "post-throw termination repeated",
  );
});

Deno.test("synchronous graceful completion wins before reentrant disposal", async () => {
  const root = new Directory(new Map([["stable", new File([1])]]));
  const worker = new FakeWorker();
  const clock = new FakeClock();
  let owner!: ReturnType<typeof createChildProcessBridgeOwner>;
  let reentrantDispose: Promise<void> | undefined;
  worker.postMessage = (value: unknown) => {
    worker.posted = structuredClone(value);
    root.contents.set("stable", new File([2]));
    worker.finish({ status: 0, graceful: true });
    reentrantDispose = owner.dispose();
  };
  owner = createChildProcessBridgeOwner({
    getWasiRef: () => ({}),
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => worker,
    timers: clock,
  });
  const started = await owner.handle({
    name: "childProcessStart",
    args: { argv: [], env: [], module_len: 0 },
  });

  assertEquals(
    await owner.handle({
      name: "childProcessRun",
      args: { request_id: started.request_id },
    }),
    { state: 3, status: 0, error_len: 0 },
    "reentrant disposal completion result",
  );
  assert(reentrantDispose instanceof Promise, "reentrant disposal did not start");
  const cleanupCounts = {
    cleared: clock.cleared,
    listenerClears: { ...worker.listenerClears },
    terminateCalls: worker.terminateCalls,
  };
  const laterDispose = owner.dispose();
  assert(
    laterDispose === reentrantDispose,
    "later disposal did not reuse the reentrant Promise",
  );
  await laterDispose;

  assertEquals(
    Array.from((root.contents.get("stable") as File).data),
    [2],
    "reentrant disposal rolled back graceful output",
  );
  assertEquals(clock.cleared, cleanupCounts.cleared, "reentrant timer cleanup repeated");
  assertEquals(
    worker.listenerClears,
    cleanupCounts.listenerClears,
    "reentrant listener cleanup repeated",
  );
  assertEquals(
    worker.terminateCalls,
    cleanupCounts.terminateCalls,
    "reentrant termination repeated",
  );
});

Deno.test("Worker setup failure rolls back and rejects the original error", async () => {
  const originalFile = new File([1]);
  const root = new Directory(new Map([["stable", originalFile]]));
  const setupError = new Error("farm unavailable");
  const bridge = createChildProcessBridge({
    getWasiRef: () => {
      root.contents.set("stable", new File([2]));
      throw setupError;
    },
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => new FakeWorker(),
  });
  const requestId = await start(bridge, Uint8Array.of(0));
  let rejectedWith: unknown;
  try {
    await bridge(message("childProcessRun", { request_id: requestId }));
  } catch (error) {
    rejectedWith = error;
  }
  assert(rejectedWith === setupError, "setup failure rejection identity changed");
  assert(
    root.contents.get("stable") === originalFile,
    "setup rollback replaced inode",
  );
});

Deno.test("filesystem snapshot rejects entry and byte budgets before allocation", async () => {
  const tooMany = new Map<string, File>();
  for (let index = 0; index < 10_001; index++) {
    tooMany.set(String(index), new File([]));
  }
  await assertRejects(
    () =>
      fakeSetup(new Directory(tooMany)).bridge(
        message("childProcessStart", { argv: [], env: [], module_len: 0 }),
      ),
    "10,000",
  );
  await assertRejects(
    () =>
      fakeSetup(
        new Directory(
          new Map([
            ["large", new File(new Uint8Array(64 * 1024 * 1024 + 1))],
          ]),
        ),
      ).bridge(
        message("childProcessStart", { argv: [], env: [], module_len: 0 }),
      ),
    "64 MiB",
  );
});

Deno.test("filesystem snapshot handles a 9000-directory chain iteratively", async () => {
  const root = new Directory(new Map());
  let current = root;
  for (let index = 0; index < 9000; index++) {
    const child = new Directory(new Map());
    current.contents.set("next", child);
    current = child;
  }
  const { bridge } = fakeSetup(root);
  const started = await bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 0,
  })) as { request_id: number };
  await bridge(message("childProcessEnd", { request_id: started.request_id }));
  assert(
    root.contents.get("next") instanceof Directory,
    "deep rollback lost root",
  );
});

Deno.test("filesystem snapshot rejects cyclic and shared inode graphs recoverably", async () => {
  const cyclicRoot = new Directory(new Map());
  cyclicRoot.contents.set("loop", cyclicRoot);
  const cyclic = fakeSetup(cyclicRoot);
  await assertRejects(
    () =>
      cyclic.bridge(message("childProcessStart", {
        argv: [],
        env: [],
        module_len: 0,
      })),
    "cyclic or shared",
  );
  cyclicRoot.contents.clear();
  const recovered = await cyclic.bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 0,
  })) as { request_id: number };
  await cyclic.bridge(
    message("childProcessEnd", { request_id: recovered.request_id }),
  );

  const shared = new Directory(new Map());
  const sharedRoot = new Directory(new Map([["a", shared], ["b", shared]]));
  await assertRejects(
    () =>
      fakeSetup(sharedRoot).bridge(message("childProcessStart", {
        argv: [],
        env: [],
        module_len: 0,
      })),
    "cyclic or shared",
  );
});

Deno.test("dedicated Worker inherits stdout/root and preserves exact exit status", async () => {
  let stdout = "";
  const root = new PreopenDirectory("/", new Map());
  const farm = new WASIFarm(
    new OpenFile(new File([])),
    new ConsoleStdout((bytes) => stdout += decoder.decode(bytes)),
    new ConsoleStdout(() => {}),
    [root],
  );
  const bridge = realBridge(root, farm);
  const module = await Deno.readFile("/tmp/opencode/wasi_child_args.wasm");
  const requestId = await start(bridge, module, ["child", "unused"], ["A=B"]);
  const result = await bridge(
    message("childProcessRun", { request_id: requestId }),
  );
  assertEquals(result, { state: 3, status: 0, error_len: 0 });
  assertEquals(stdout, "child-ok\n", "inherited stdout");
  await bridge(message("childProcessEnd", { request_id: requestId }));
});

Deno.test("real Worker propagates argv and exact nonzero proc_exit status", async () => {
  const module = await compileWat(
    "wasi_child_argc",
    `(module
    (import "wasi_snapshot_preview1" "args_sizes_get"
      (func $args_sizes_get (param i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
    (memory (export "memory") 1)
    (func (export "_start")
      (drop (call $args_sizes_get (i32.const 0) (i32.const 4)))
      (call $proc_exit (i32.load (i32.const 0)))))`,
  );
  const root = new PreopenDirectory("/", new Map());
  const farm = new WASIFarm(
    new OpenFile(new File([])),
    new ConsoleStdout(() => {}),
    new ConsoleStdout(() => {}),
    [root],
  );
  const bridge = realBridge(root, farm);
  const requestId = await start(bridge, module, ["child", "first", "second"]);
  assertEquals(
    await bridge(message("childProcessRun", { request_id: requestId })),
    { state: 3, status: 3, error_len: 0 },
  );
  await bridge(message("childProcessEnd", { request_id: requestId }));
});

Deno.test("real Worker keeps graceful filesystem mutation until acknowledgement", async () => {
  const module = await compileWat(
    "wasi_child_create",
    `(module
    (import "wasi_snapshot_preview1" "path_open"
      (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_write"
      (func $fd_write (param i32 i32 i32 i32) (result i32)))
    (memory (export "memory") 1)
    (data (i32.const 0) "made.txt")
    (data (i32.const 16) "made\\n")
    (func (export "_start")
      (drop (call $path_open
        (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 8)
        (i32.const 1) (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 64)))
      (i32.store (i32.const 72) (i32.const 16))
      (i32.store (i32.const 76) (i32.const 5))
      (drop (call $fd_write
        (i32.load (i32.const 64)) (i32.const 72) (i32.const 1) (i32.const 80)))))`,
  );
  const root = new PreopenDirectory("/", new Map());
  const farm = new WASIFarm(
    new OpenFile(new File([])),
    new ConsoleStdout(() => {}),
    new ConsoleStdout(() => {}),
    [root],
  );
  const bridge = realBridge(root, farm);
  const requestId = await start(bridge, module);
  assertEquals(
    await bridge(message("childProcessRun", { request_id: requestId })),
    { state: 3, status: 0, error_len: 0 },
  );
  assertEquals(
    decoder.decode((root.dir.contents.get("made.txt") as File).data),
    "made\n",
  );
  await bridge(message("childProcessEnd", { request_id: requestId }));
});

Deno.test("real Worker trap restores the baseline filesystem", async () => {
  const module = await compileWat(
    "wasi_child_trap",
    `(module
    (import "wasi_snapshot_preview1" "path_open"
      (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_write"
      (func $fd_write (param i32 i32 i32 i32) (result i32)))
    (memory (export "memory") 1)
    (data (i32.const 0) "stable")
    (data (i32.const 16) "partial")
    (func (export "_start")
      (drop (call $path_open
        (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 6)
        (i32.const 8) (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 64)))
      (i32.store (i32.const 72) (i32.const 16))
      (i32.store (i32.const 76) (i32.const 7))
      (drop (call $fd_write
        (i32.load (i32.const 64)) (i32.const 72) (i32.const 1) (i32.const 80)))
      unreachable))`,
  );
  const root = new PreopenDirectory(
    "/",
    new Map([
      ["stable", new File(encoder.encode("before"))],
    ]),
  );
  const farm = new WASIFarm(
    new OpenFile(new File([])),
    new ConsoleStdout(() => {}),
    new ConsoleStdout(() => {}),
    [root],
  );
  const bridge = realBridge(root, farm);
  const requestId = await start(bridge, module);
  const result = await bridge(
    message("childProcessRun", { request_id: requestId }),
  ) as {
    status: number;
    error_len: number;
  };
  assertEquals(result.status, 126);
  assert(result.error_len > 0, "trap did not provide an error");
  assertEquals(
    decoder.decode((root.dir.contents.get("stable") as File).data),
    "before",
  );
  await bridge(message("childProcessEnd", { request_id: requestId }));
});

Deno.test("parent execution timeout terminates a blocked real Worker", async () => {
  const module = await compileWat(
    "wasi_child_loop",
    `(module
    (memory (export "memory") 1)
    (func (export "_start") (loop $forever (br $forever))))`,
  );
  const root = new PreopenDirectory("/", new Map());
  const farm = new WASIFarm(
    new OpenFile(new File([])),
    new ConsoleStdout(() => {}),
    new ConsoleStdout(() => {}),
    [root],
  );
  const bridge = realBridge(root, farm, 50);
  const requestId = await start(bridge, module);
  const result = await bridge(
    message("childProcessRun", { request_id: requestId }),
  ) as {
    status: number;
  };
  assertEquals(result.status, 124);
  await bridge(message("childProcessEnd", { request_id: requestId }));
});
