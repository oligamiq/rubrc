import {
  drainVfsDebugTrace,
  startVfsDebugTracePump,
  traceVfsHostCall,
  VfsDebugTraceCollector,
} from "./vfs_debug_trace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, received ${actualJson}`);
  }
}

class FakeRoot {
  readonly allocCalls: number[] = [];
  readonly freeCalls: Array<{ ptr: number; len: number }> = [];
  readonly captureCalls: boolean[] = [];
  snapshotCalls = 0;
  readCalls = 0;
  snapshotFailure: { value: unknown } | undefined;
  snapshotError: Error | undefined;
  throwOnRead = false;
  zeroReads = 0;
  chunks: string[] = [];

  constructor(readonly memory: WebAssembly.Memory) {}

  debugSetTerminalCapture(enabled: boolean): void {
    this.captureCalls.push(enabled);
  }

  debugCaptureWaitSnapshot(): void {
    this.snapshotCalls++;
    if (this.snapshotFailure) throw this.snapshotFailure.value;
    if (this.snapshotError) throw this.snapshotError;
  }

  debugTerminalOutputLen(): number {
    return this.chunks.length === 0
      ? 0
      : new TextEncoder().encode(this.chunks[0]).length;
  }

  allocBuf(len: number): number {
    this.allocCalls.push(len);
    return 64;
  }

  debugReadTerminalOutput(ptr: number, _len: number): number {
    this.readCalls++;
    if (this.throwOnRead) throw new Error("read failed");
    if (this.zeroReads > 0) {
      this.zeroReads--;
      return 0;
    }
    const chunk = this.chunks.shift();
    if (chunk === undefined) return 0;
    const encoded = new TextEncoder().encode(chunk);
    new Uint8Array(this.memory.buffer, ptr, encoded.length).set(encoded);
    return encoded.length;
  }

  freeBuf(ptr: number, len: number): void {
    this.freeCalls.push({ ptr, len });
  }
}

function errorWithThrowingName(): Error {
  const error = new Error("secret payload");
  Object.defineProperty(error, "name", {
    get() {
      throw new Error("name getter trapped");
    },
  });
  return error;
}

function proxyWithThrowingPrototype(): object {
  return new Proxy({}, {
    getPrototypeOf() {
      throw new Error("prototype lookup trapped");
    },
  });
}

function withFakeInterval(
  test: (tick: () => void, cleared: number[]) => void,
): void {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCallback: (() => void) | undefined;
  const cleared: number[] = [];
  globalThis.setInterval = ((callback: () => void) => {
    intervalCallback = callback;
    return 99;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: number) => {
    cleared.push(timer);
  }) as typeof clearInterval;

  try {
    test(() => {
      assert(
        intervalCallback !== undefined,
        "the interval callback was not set",
      );
      intervalCallback();
    }, cleared);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

Deno.test("trace collector evicts oldest complete chunks within its UTF-8 byte limit", () => {
  const collector = new VfsDebugTraceCollector(8);
  collector.push("old");
  collector.push("éé");
  collector.push("newer");

  assertEquals(collector.snapshot(), {
    trace: "newer",
    droppedChunks: 2,
    retainedBytes: 5,
  });
});

Deno.test("trace collector truncates an oversized chunk at a UTF-8 boundary", () => {
  const collector = new VfsDebugTraceCollector(5);
  collector.push("aébé");
  const snapshot = collector.snapshot();

  assertEquals(snapshot, {
    trace: "ébé",
    droppedChunks: 1,
    retainedBytes: 5,
  });
  assertEquals(new TextEncoder().encode(snapshot.trace).length, 5);
});

Deno.test("trace collector preserves the latest priority snapshot where possible", () => {
  const priority = "\r\n[vfs-debug] snapshot cargo=none\r\n";
  const priorityBytes = new TextEncoder().encode(priority).length;
  const collector = new VfsDebugTraceCollector(priorityBytes + 6);
  collector.push("old");
  collector.push(priority);
  collector.push("latest");
  collector.push("overflow");

  assertEquals(collector.snapshot(), {
    trace: priority,
    droppedChunks: 3,
    retainedBytes: priorityBytes,
  });
});

Deno.test("trace collector preserves a priority snapshot from an oversized chunk prefix", () => {
  const collector = new VfsDebugTraceCollector(64);
  collector.push(
    `[vfs-debug] snapshot cargo=none\n${"x".repeat(128)}`,
  );
  const snapshot = collector.snapshot();

  assert(
    snapshot.trace.includes("[vfs-debug] snapshot cargo=none"),
    "the priority snapshot prefix was discarded",
  );
  assert(snapshot.retainedBytes <= 64, "the collector exceeded its byte limit");
  assertEquals(snapshot.droppedChunks, 1);
});

Deno.test("drain reads from the supplied shared core memory and frees the allocation", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const root = new FakeRoot(memory);
  const text = "snapshot cargo=7 wait=cargo-main";
  const encoded = new TextEncoder().encode(text);
  root.chunks.push(text);

  assertEquals(drainVfsDebugTrace(root, memory), text);
  assertEquals(root.allocCalls, [encoded.length]);
  assertEquals(root.freeCalls, [{ ptr: 64, len: encoded.length }]);
});

Deno.test("drain treats a zero read as transient and retries on the next drain", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const root = new FakeRoot(memory);
  root.chunks.push("after-contention");
  root.zeroReads = 1;

  assertEquals(drainVfsDebugTrace(root, memory), "");
  assertEquals(drainVfsDebugTrace(root, memory), "after-contention");
  assertEquals(root.readCalls, 2);
  assertEquals(root.freeCalls.length, 2);
});

Deno.test("drain frees the allocated length when reading throws", () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const root = new FakeRoot(memory);
  root.chunks.push("unread");
  root.throwOnRead = true;

  let thrown: unknown;
  try {
    drainVfsDebugTrace(root, memory);
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof Error, "the read error should be rethrown");
  assertEquals(root.freeCalls, [{ ptr: 64, len: 6 }]);
});

Deno.test("pump drains on schedule and snapshots at the requested cadence", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCallback: (() => void) | undefined;
  let configuredInterval: number | undefined;
  const cleared: number[] = [];
  globalThis.setInterval = ((callback: () => void, interval: number) => {
    intervalCallback = callback;
    configuredInterval = interval;
    return 41;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: number) => {
    cleared.push(timer);
  }) as typeof clearInterval;

  try {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    root.chunks.push("one", "two", "three", "final");
    const emitted: string[] = [];
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: (chunk) => emitted.push(chunk),
      intervalMs: 250,
      snapshotEvery: 2,
    });

    assertEquals(root.captureCalls, [true]);
    assertEquals(configuredInterval, 250);
    assert(intervalCallback !== undefined, "the interval callback was not set");
    intervalCallback();
    assertEquals(root.snapshotCalls, 0);
    intervalCallback();
    assertEquals(root.snapshotCalls, 1);
    intervalCallback();
    assertEquals(emitted, ["one", "two", "three"]);

    pump.stop();
    pump.stop();

    assertEquals(root.snapshotCalls, 2);
    assertEquals(emitted, ["one", "two", "three", "final"]);
    assertEquals(cleared, [41]);
    assertEquals(root.readCalls, 4);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

Deno.test("captureSnapshot snapshots and drains without emitting", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (() => 42) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;

  try {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    root.chunks.push("manual");
    const emitted: string[] = [];
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: (chunk) => emitted.push(chunk),
    });

    assertEquals(pump.captureSnapshot(), "manual");
    assertEquals(root.snapshotCalls, 1);
    assertEquals(emitted, []);
    pump.stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

Deno.test("stop drains and cleans up once when the final snapshot traps", () => {
  withFakeInterval((_tick, cleared) => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    const snapshotError = new TypeError("snapshot payload");
    root.snapshotError = snapshotError;
    root.chunks.push("final-after-trap");
    const emitted: string[] = [];
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: (chunk) => emitted.push(chunk),
    });

    let thrown: unknown;
    try {
      pump.stop();
    } catch (error) {
      thrown = error;
    }
    pump.stop();

    assert(thrown === snapshotError, "stop did not rethrow the snapshot error");
    assertEquals(root.snapshotCalls, 1);
    assertEquals(root.readCalls, 1);
    assertEquals(cleared, [99]);
    assertEquals(emitted, [
      "final-after-trap",
      "trace-error scope=stop operation=snapshot error=TypeError\n",
    ]);
    assert(
      !emitted.join("").includes("payload"),
      "an error payload was traced",
    );
  });
});

Deno.test("stop preserves an undefined primary failure through secondary failures", () => {
  withFakeInterval((_tick, cleared) => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    root.snapshotFailure = { value: undefined };
    root.throwOnRead = true;
    root.chunks.push("secondary-drain");
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: () => {
        throw new Error("emitter failure");
      },
    });

    let didThrow = false;
    let thrown: unknown = "not thrown";
    try {
      pump.stop();
    } catch (error) {
      didThrow = true;
      thrown = error;
    }
    pump.stop();

    assert(didThrow, "stop dropped a thrown undefined primary failure");
    assert(thrown === undefined, "a secondary failure replaced the primary");
    assertEquals(root.readCalls, 1);
    assertEquals(root.freeCalls.length, 1);
    assertEquals(cleared, [99]);
  });
});

Deno.test("stop reporting cannot mask an Error with a throwing name", () => {
  withFakeInterval((_tick, _cleared) => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    const primary = errorWithThrowingName();
    root.snapshotError = primary;
    root.chunks.push("final-after-hostile-error");
    const emitted: string[] = [];
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: (chunk) => emitted.push(chunk),
    });

    let thrown: unknown;
    try {
      pump.stop();
    } catch (error) {
      thrown = error;
    }

    assert(thrown === primary, "trace reporting masked the primary stop error");
    assertEquals(emitted, [
      "final-after-hostile-error",
      "trace-error scope=stop operation=snapshot error=Unknown\n",
    ]);
  });
});

Deno.test("interval snapshot failures are contained and do not skip draining", () => {
  withFakeInterval((tick, cleared) => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    root.snapshotError = new TypeError("snapshot payload");
    root.chunks.push("after-snapshot-error");
    const emitted: string[] = [];
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: (chunk) => emitted.push(chunk),
      snapshotEvery: 1,
    });

    tick();
    root.snapshotError = undefined;
    pump.stop();

    assertEquals(emitted, [
      "after-snapshot-error",
      "trace-error scope=interval operation=snapshot error=TypeError\n",
    ]);
    assertEquals(cleared, [99]);
  });
});

Deno.test("interval drain failures are contained and cleanup remains possible", () => {
  withFakeInterval((tick, cleared) => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    root.throwOnRead = true;
    root.chunks.push("recovered-at-stop");
    const emitted: string[] = [];
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: (chunk) => emitted.push(chunk),
    });

    tick();
    root.throwOnRead = false;
    pump.stop();

    assertEquals(emitted, [
      "trace-error scope=interval operation=drain error=Error\n",
      "recovered-at-stop",
    ]);
    assertEquals(cleared, [99]);
    assertEquals(root.freeCalls.length, 2);
  });
});

Deno.test("interval emitter failures are contained and reported best effort", () => {
  withFakeInterval((tick, cleared) => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    root.chunks.push("unemittable", "final");
    const emitted: string[] = [];
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: (chunk) => {
        if (chunk === "unemittable") throw new RangeError("emitter payload");
        emitted.push(chunk);
      },
    });

    tick();
    pump.stop();

    assertEquals(emitted, [
      "trace-error scope=interval operation=emit error=RangeError\n",
      "final",
    ]);
    assertEquals(cleared, [99]);
    assert(
      !emitted.join("").includes("payload"),
      "an emitter payload was traced",
    );
  });
});

Deno.test("interval reporting contains hostile proxy errors", () => {
  withFakeInterval((tick, cleared) => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root = new FakeRoot(memory);
    root.snapshotFailure = { value: proxyWithThrowingPrototype() };
    root.chunks.push("after-hostile-snapshot");
    const emitted: string[] = [];
    const pump = startVfsDebugTracePump({
      root,
      memory,
      emit: (chunk) => emitted.push(chunk),
      snapshotEvery: 1,
    });

    tick();
    root.snapshotFailure = undefined;
    pump.stop();

    assertEquals(emitted, [
      "after-hostile-snapshot",
      "trace-error scope=interval operation=snapshot error=Unknown\n",
    ]);
    assertEquals(cleared, [99]);
  });
});

Deno.test("host tracing preserves a synchronous return and omits payloads", () => {
  const lines: string[] = [];
  const value = { status: 0 };

  const result = traceVfsHostCall(
    7,
    "hostRunCargo",
    (line) => lines.push(line),
    () => value,
  );

  assert(result === value, "the synchronous return identity changed");
  assertEquals(lines, [
    "host-call id=7 name=hostRunCargo phase=request\n",
    "host-call id=7 name=hostRunCargo phase=response\n",
  ]);
  assert(!lines.join("").includes("status"), "a payload was traced");
});

Deno.test("host tracing preserves synchronous throws", () => {
  const lines: string[] = [];
  const failure = new TypeError("secret request payload");
  let thrown: unknown;

  try {
    traceVfsHostCall(
      8,
      "hostRunCargo",
      (line) => lines.push(line),
      () => {
        throw failure;
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert(thrown === failure, "the synchronous error identity changed");
  assertEquals(lines, [
    "host-call id=8 name=hostRunCargo phase=request\n",
    "host-call id=8 name=hostRunCargo phase=reject error=TypeError\n",
  ]);
  assert(!lines.join("").includes("secret"), "an error payload was traced");
});

Deno.test("host tracing preserves sync errors with throwing names", () => {
  const lines: string[] = [];
  const failure = errorWithThrowingName();
  let thrown: unknown;

  try {
    traceVfsHostCall(
      15,
      "hostRunCargo",
      (line) => lines.push(line),
      () => {
        throw failure;
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert(thrown === failure, "classification masked the sync error");
  assertEquals(lines, [
    "host-call id=15 name=hostRunCargo phase=request\n",
    "host-call id=15 name=hostRunCargo phase=reject error=Unknown\n",
  ]);
});

Deno.test("host tracing keeps promise results asynchronous", async () => {
  const lines: string[] = [];
  const value = { status: 1 };
  const promise = Promise.resolve(value);

  const result = traceVfsHostCall(
    9,
    "hostRunCargo",
    (line) => lines.push(line),
    () => promise,
  );

  assert(result instanceof Promise, "a native Promise became synchronous");
  assertEquals(lines, [
    "host-call id=9 name=hostRunCargo phase=request\n",
  ]);
  assert(await result === value, "the resolved value identity changed");
  assertEquals(lines, [
    "host-call id=9 name=hostRunCargo phase=request\n",
    "host-call id=9 name=hostRunCargo phase=response\n",
  ]);
});

Deno.test("host tracing ignores emitter failures for synchronous returns", () => {
  const value = { status: 2 };
  let called = false;

  const result = traceVfsHostCall(
    10,
    "hostRunCargo",
    () => {
      throw new Error("emitter failed");
    },
    () => {
      called = true;
      return value;
    },
  );

  assert(called, "the host call was skipped after an emitter failure");
  assert(result === value, "an emitter failure changed the sync return");
});

Deno.test("host tracing preserves synchronous throws when emitters fail", () => {
  const failure = new TypeError("host payload");
  let thrown: unknown;

  try {
    traceVfsHostCall(
      11,
      "hostRunCargo",
      () => {
        throw new Error("emitter failed");
      },
      () => {
        throw failure;
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert(thrown === failure, "an emitter failure replaced the sync error");
});

Deno.test("host tracing preserves fulfilled native Promises when emitters fail", async () => {
  const value = { status: 3 };
  const promise = Promise.resolve(value);

  const result = traceVfsHostCall(
    12,
    "hostRunCargo",
    (line) => {
      if (line.includes("phase=response")) throw new Error("emitter failed");
    },
    () => promise,
  );

  assert(result instanceof Promise, "a fulfilled Promise became synchronous");
  assert(await result === value, "an emitter failure changed fulfillment");
});

Deno.test("host tracing preserves rejected native Promises when emitters fail", async () => {
  const failure = new RangeError("host payload");
  const promise = Promise.reject(failure);

  const result = traceVfsHostCall(
    13,
    "hostRunCargo",
    (line) => {
      if (line.includes("phase=reject")) throw new Error("emitter failed");
    },
    () => promise,
  );

  assert(
    result !== promise,
    "the rejection observer can suppress unhandled rejection",
  );
  let rejected: unknown;
  try {
    await result;
  } catch (error) {
    rejected = error;
  }
  assert(rejected === failure, "an emitter failure replaced the rejection");
});

Deno.test("host tracing preserves proxy rejections during classification", async () => {
  const lines: string[] = [];
  const failure = proxyWithThrowingPrototype();
  const result = traceVfsHostCall(
    16,
    "hostRunCargo",
    (line) => lines.push(line),
    () => Promise.reject(failure),
  );

  let rejected: unknown;
  try {
    await result;
  } catch (error) {
    rejected = error;
  }

  assert(rejected === failure, "classification masked the Promise rejection");
  assertEquals(lines, [
    "host-call id=16 name=hostRunCargo phase=request\n",
    "host-call id=16 name=hostRunCargo phase=reject error=Unknown\n",
  ]);
});

Deno.test("ignored traced Promise rejection remains globally observable", async () => {
  const failure = new RangeError("host payload");
  let resolveObserved: (reason: unknown) => void = () => {};
  const observed = new Promise<unknown>((resolve) => {
    resolveObserved = resolve;
  });
  const listener = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    resolveObserved(event.reason);
  };
  globalThis.addEventListener("unhandledrejection", listener);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    traceVfsHostCall(
      17,
      "hostRunCargo",
      () => {},
      () => Promise.reject(failure),
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("unhandled rejection was not observed")),
        100,
      );
    });
    const reason = await Promise.race([observed, timeout]);
    assert(
      reason === failure,
      "the globally observed rejection identity changed",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    globalThis.removeEventListener("unhandledrejection", listener);
  }
});

Deno.test("host tracing returns custom thenables without inspecting them", () => {
  const lines: string[] = [];
  let thenCalls = 0;
  const thenable = {
    then() {
      thenCalls++;
    },
  };

  const result = traceVfsHostCall(
    14,
    "hostRunCargo",
    (line) => lines.push(line),
    () => thenable,
  );

  assert(result === thenable, "a custom thenable was assimilated");
  assertEquals(thenCalls, 0);
  assertEquals(lines, [
    "host-call id=14 name=hostRunCargo phase=request\n",
    "host-call id=14 name=hostRunCargo phase=response\n",
  ]);
});
