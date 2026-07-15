import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import {
  type ChildProcessBridgeOptions,
  type ChildProcessMessage,
  createChildProcessBridge,
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

  setTimeout = (callback: () => void, _delay: number) => {
    this.scheduled++;
    const id = this.#nextId++;
    this.#callbacks.set(id, callback);
    return id;
  };

  clearTimeout = (id: number | ReturnType<typeof setTimeout>) => {
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
  onmessage: ((event: MessageEvent<WorkerResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: unknown;
  terminated = false;

  postMessage(value: unknown) {
    this.posted = structuredClone(value);
  }

  terminate() {
    this.terminated = true;
  }

  finish(result: WorkerResult) {
    this.onmessage?.(new MessageEvent("message", { data: result }));
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

Deno.test("recovery reports and aborts uploading and running orphans", async () => {
  const uploading = fakeSetup();
  const uploaded = await uploading.bridge(message("childProcessStart", {
    argv: [],
    env: [],
    module_len: 1,
  })) as { request_id: number };
  assertEquals(await uploading.bridge(message("childProcessRecover", {})), {
    request_id: uploaded.request_id,
    state: 1,
    status: 0,
    error_len: 0,
  });
  assertEquals(await uploading.bridge(message("childProcessRecover", {})), {
    request_id: 0,
    state: 0,
    status: 0,
    error_len: 0,
  });

  const running = fakeSetup();
  const requestId = await start(running.bridge, Uint8Array.of(0));
  const pendingRun = running.bridge(
    message("childProcessRun", { request_id: requestId }),
  );
  assertEquals(await running.bridge(message("childProcessRecover", {})), {
    request_id: requestId,
    state: 2,
    status: 0,
    error_len: 0,
  });
  assert(running.workers[0].terminated, "recovered Worker was not terminated");
  assertEquals(await pendingRun, { state: 3, status: 126, error_len: 0 });
  assertEquals(await running.bridge(message("childProcessRecover", {})), {
    request_id: 0,
    state: 0,
    status: 0,
    error_len: 0,
  });
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

Deno.test("Worker setup failure rolls back and returns readable terminal metadata", async () => {
  const originalFile = new File([1]);
  const root = new Directory(new Map([["stable", originalFile]]));
  const bridge = createChildProcessBridge({
    getWasiRef: () => {
      root.contents.set("stable", new File([2]));
      throw new Error("farm unavailable");
    },
    workerUrl,
    filesystemRoot: root,
    uploadTimeoutMs: 30_000,
    executionTimeoutMs: 120_000,
    createWorker: () => new FakeWorker(),
  });
  const requestId = await start(bridge, Uint8Array.of(0));
  const result = await bridge(message("childProcessRun", {
    request_id: requestId,
  })) as { state: number; status: number; error_len: number };
  assertEquals(result.state, 3);
  assertEquals(result.status, 126);
  assert(result.error_len > 0, "setup failure did not retain an error");
  assert(
    root.contents.get("stable") === originalFile,
    "setup rollback replaced inode",
  );
  const error = await bridge(message("childProcessReadError", {
    request_id: requestId,
    chunk_len: result.error_len,
  })) as { chunk: number[] };
  assert(
    decoder.decode(Uint8Array.from(error.chunk)).includes("farm unavailable"),
    "setup error lost",
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
