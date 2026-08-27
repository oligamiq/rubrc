import {
  type SysrootArchiveProgress,
  SysrootArchiveStore,
} from "./sysroot_archive_store.ts";
import type { SysrootArchiveEntry } from "./sysroot_archive.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
};

const assertThrows = (fn: () => unknown, expected: string) => {
  let message = "";
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    message.includes(expected),
    `expected error containing ${expected}, got ${message}`,
  );
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const coreEntry = (data = new Uint8Array([1])): SysrootArchiveEntry => ({
  name: new TextEncoder().encode("core/src/lib.rs"),
  data,
  isDirectory: false,
});

Deno.test("sysroot store starts keyed prefetches concurrently and reuses them", async () => {
  const rustSrc = deferred<Uint8Array<ArrayBuffer>>();
  const target = deferred<Uint8Array<ArrayBuffer>>();
  const calls: string[] = [];
  let parseCalls = 0;
  const store = new SysrootArchiveStore({
    loadBytes: (triple) => {
      calls.push(triple);
      return triple === "rust-src" ? rustSrc.promise : target.promise;
    },
    parseEntries: async () => {
      parseCalls++;
      return [coreEntry()];
    },
    maintainRustSrcCache: () => {},
  });
  const signal = new AbortController().signal;

  const first = store.prefetch(["rust-src", "wasm32-wasip1"], signal);
  const duplicate = store.prefetch(["rust-src", "wasm32-wasip1"], signal);

  assertEquals(
    calls.join(","),
    "rust-src,wasm32-wasip1",
    "prefetches were not started concurrently or were duplicated",
  );
  assertThrows(() => store.beginRead("rust-src"), "rust-src");

  rustSrc.resolve(new Uint8Array([1, 2]));
  target.resolve(new Uint8Array([3, 4]));
  await Promise.all([first, duplicate]);

  assertEquals(parseCalls, 1, "rust-src was parsed more than once");
  store.beginRead("rust-src");
  assertEquals(store.archiveLength(), 2, "wrong prefetched archive length");
  store.dispose();
});

Deno.test("sysroot store rejects rust-src without a non-empty core root", async () => {
  for (const entries of [
    [] as SysrootArchiveEntry[],
    [coreEntry(new Uint8Array())],
    [{ ...coreEntry(), isDirectory: true }],
    [{ ...coreEntry(), name: new TextEncoder().encode("./core/src/lib.rs") }],
  ]) {
    const store = new SysrootArchiveStore({
      loadBytes: async () => new Uint8Array([1]),
      parseEntries: async () => entries,
    });
    const error = await store
      .prefetch(["rust-src"], new AbortController().signal)
      .then(
        () => undefined,
        (reason) => reason,
      );
    assert(
      error instanceof Error &&
        error.message.includes("rust-src archive is missing core/src/lib.rs"),
      `unexpected missing-core rejection: ${String(error)}`,
    );
    store.dispose();
  }
});

Deno.test("rust-src cache maintenance follows parse and core validation", async () => {
  let parseAttempt = 0;
  let maintenanceCalls = 0;
  const store = new SysrootArchiveStore({
    loadBytes: async () => new Uint8Array([1]),
    parseEntries: async () => {
      parseAttempt++;
      if (parseAttempt === 1) throw new Error("malformed rust-src archive");
      if (parseAttempt === 2) return [];
      return [coreEntry()];
    },
    maintainRustSrcCache: () => maintenanceCalls++,
  });
  const signal = new AbortController().signal;

  await store.prefetch(["rust-src"], signal).catch(() => undefined);
  assertEquals(
    maintenanceCalls,
    0,
    "malformed rust-src archive started cache maintenance",
  );

  await store.prefetch(["rust-src"], signal).catch(() => undefined);
  assertEquals(
    maintenanceCalls,
    0,
    "missing-core rust-src archive started cache maintenance",
  );

  await store.prefetch(["rust-src"], signal);
  await store.prefetch(["rust-src"], signal);
  assertEquals(
    maintenanceCalls,
    1,
    "validated rust-src archive did not maintain its cache exactly once",
  );
  store.dispose();
});

Deno.test("sysroot store evicts failed and aborted prefetches for retry", async () => {
  let attempts = 0;
  const firstFailure = new Error("network failed");
  const store = new SysrootArchiveStore({
    loadBytes: (_triple, options) => {
      attempts++;
      if (attempts === 1) return Promise.reject(firstFailure);
      if (attempts === 2) {
        return new Promise((resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Uint8Array([7]));
    },
    parseEntries: async () => [],
  });

  const failed = await store
    .prefetch(["wasm32-wasip1"], new AbortController().signal)
    .then(
      () => undefined,
      (error) => error,
    );
  assert(failed === firstFailure, "fetch failure identity was replaced");

  const controller = new AbortController();
  const abortedPrefetch = store.prefetch(["wasm32-wasip1"], controller.signal);
  const abortReason = new Error("generation replaced");
  controller.abort(abortReason);
  const aborted = await abortedPrefetch.then(
    () => undefined,
    (error) => error,
  );
  assert(aborted === abortReason, "abort reason identity was replaced");

  await store.prefetch(["wasm32-wasip1"], new AbortController().signal);
  assertEquals(attempts, 3, "rejected keyed prefetch was not evicted");
  store.dispose();
});

Deno.test("sysroot store emits exact read progress and releases final buffer", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const progress: SysrootArchiveProgress[] = [];
  const store = new SysrootArchiveStore({
    loadBytes: async () => bytes,
    parseEntries: async () => [],
  });
  store.subscribe((event) => progress.push(event));

  await store.prefetch(["wasm32-wasip1"], new AbortController().signal);
  assertEquals(
    store.archiveLength(),
    null,
    "archive was active before beginRead",
  );
  store.beginRead("wasm32-wasip1");
  const first = store.readChunk(2);
  assertEquals(
    store.archiveLength(),
    3,
    "archive metadata length changed after a partial read",
  );
  const final = store.readChunk(1);

  assert(first.buffer === bytes.buffer, "first chunk copied the archive");
  assert(final.buffer === bytes.buffer, "final chunk copied the archive");
  assertEquals(Array.from(first).join(","), "1,2", "wrong first chunk");
  assertEquals(Array.from(final).join(","), "3", "wrong final chunk");
  assertEquals(
    store.archiveLength(),
    null,
    "final backing buffer was retained",
  );
  assertThrows(() => store.readChunk(1), "No current sysroot archive");
  assertEquals(
    progress.map((event) => event.state).join(","),
    "fetching,ready,reading,reading,complete",
    "wrong progress state sequence",
  );
  assertEquals(progress[2].loaded, 0, "read did not start at zero bytes");
  assertEquals(progress[3].loaded, 2, "partial read progress was not exact");
  assertEquals(progress[4].loaded, 3, "complete read progress was not exact");
  assertEquals(progress[4].total, 3, "complete read total was not exact");
  store.dispose();
});

Deno.test("beginRead resets a triple and switching triples cannot inherit an offset", async () => {
  const archives = new Map<string, Uint8Array<ArrayBuffer>>([
    ["rust-src", new Uint8Array([1, 2, 3])],
    ["wasm32-wasip2", new Uint8Array([7, 8, 9])],
  ]);
  const store = new SysrootArchiveStore({
    loadBytes: async (triple) => archives.get(triple)!,
    parseEntries: async () => [coreEntry()],
    maintainRustSrcCache: () => {},
  });
  await store.prefetch(
    ["rust-src", "wasm32-wasip2"],
    new AbortController().signal,
  );

  store.beginRead("rust-src");
  assertEquals(store.readChunk(2)[0], 1, "rust-src did not start at byte zero");
  store.beginRead("rust-src");
  assertEquals(store.readChunk(1)[0], 1, "restarted rust-src inherited its cursor");
  store.beginRead("rust-src");
  store.readChunk(2);
  store.beginRead("wasm32-wasip2");
  assertEquals(
    store.readChunk(1)[0],
    7,
    "target archive inherited the rust-src cursor",
  );
  store.beginRead("rust-src");
  assertEquals(
    store.readChunk(1)[0],
    1,
    "rust-src inherited the target archive cursor",
  );
  store.dispose();
});

Deno.test("sysroot store read completion waits for extraction and preserves abort", async () => {
  const store = new SysrootArchiveStore({
    loadBytes: async () => new Uint8Array([1, 2]),
    parseEntries: async () => [],
  });
  const controller = new AbortController();
  await store.prefetch(["wasm32-wasip2"], controller.signal);

  const completed = store.waitForReadCompletion(
    "wasm32-wasip2",
    controller.signal,
  );
  let settled = false;
  void completed.then(() => {
    settled = true;
  });
  store.beginRead("wasm32-wasip2");
  store.readChunk(1);
  await Promise.resolve();
  assert(!settled, "read completion resolved before final extraction chunk");
  store.readChunk(1);
  await completed;
  assert(settled, "read completion did not observe final extraction chunk");

  const abortController = new AbortController();
  const aborted = store.waitForReadCompletion(
    "other-target",
    abortController.signal,
  );
  const abortReason = new Error("generation disposed");
  abortController.abort(abortReason);
  const caught = await aborted.then(
    () => undefined,
    (error) => error,
  );
  assert(caught === abortReason, "read completion replaced abort reason");
  store.dispose();
});

Deno.test("disposing a sysroot store aborts loads and clears archives", async () => {
  let loadSignal: AbortSignal | undefined;
  const store = new SysrootArchiveStore({
    loadBytes: (_triple, options) => {
      loadSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        loadSignal?.addEventListener(
          "abort",
          () => reject(loadSignal?.reason),
          { once: true },
        );
      });
    },
    parseEntries: async () => [],
  });
  const prefetch = store.prefetch(
    ["wasm32-wasip1"],
    new AbortController().signal,
  );

  store.dispose();
  await prefetch.catch(() => undefined);

  assert(loadSignal?.aborted, "dispose did not abort the in-flight loader");
  assertEquals(
    store.archiveLength(),
    null,
    "dispose retained an active archive",
  );
  assertThrows(() => store.beginRead("wasm32-wasip1"), "disposed");
});
