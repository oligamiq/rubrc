import { loadSysrootArchiveBytes } from "./sysroot_archive.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function withClock(run: (advance: (ms: number) => void) => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  let now = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  try { await run(ms => { now += ms; }); }
  finally {
    if (descriptor) Object.defineProperty(performance, "now", descriptor);
    else delete (performance as unknown as { now?: unknown }).now;
  }
}

Deno.test("a progressing sysroot download can take more than sixty seconds", () => withClock(async advance => {
  let chunks = 0;
  const bytes = await loadSysrootArchiveBytes("rust-src", {
    fetchStream: async () => new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks === 6) { controller.close(); return; }
        advance(20_000);
        controller.enqueue(new Uint8Array([++chunks]));
      },
    }),
  });
  assert(bytes.join(",") === "1,2,3,4,5,6", "progressing download was truncated");
}));

Deno.test("an idle sysroot stream is aborted before the overall cap", async () => {
  let cancelReason: unknown;
  let signal: AbortSignal | undefined;
  const options = {
    timeoutMs: 100,
    idleTimeoutMs: 5,
    fetchStream: async (_url: string, current: AbortSignal) => {
      signal = current;
      return new ReadableStream<Uint8Array>({ cancel(reason) { cancelReason = reason; } });
    },
  };
  let failure: unknown;
  try { await loadSysrootArchiveBytes("rust-src", options); } catch (error) { failure = error; }
  assert(failure instanceof Error && failure.message.includes("stalled"), `wrong failure: ${failure}`);
  assert(signal?.aborted && cancelReason === failure, "idle stream was not cancelled with its failure");
});

Deno.test("continuous progress cannot bypass an explicit total transfer cap", () => withClock(async advance => {
  let signal: AbortSignal | undefined;
  let failure: unknown;
  try {
    await loadSysrootArchiveBytes("rust-src", {
      timeoutMs: 50,
      fetchStream: async (_url, current) => {
        signal = current;
        return new ReadableStream<Uint8Array>({
          pull(controller) { advance(20); controller.enqueue(new Uint8Array([1])); },
        });
      },
    });
  } catch (error) { failure = error; }
  assert(failure instanceof Error && failure.message.includes("timed out"), "total deadline was lost");
  assert(signal?.aborted, "total deadline did not cancel the fetch");
}));

Deno.test("empty chunks cannot keep an idle sysroot transfer alive", () => withClock(async advance => {
  let failure: unknown;
  try {
    await loadSysrootArchiveBytes("rust-src", {
      fetchStream: async () => new ReadableStream<Uint8Array>({
        pull(controller) { advance(20_000); controller.enqueue(new Uint8Array()); },
      }),
    });
  } catch (error) { failure = error; }
  assert(failure instanceof Error && failure.message.includes("stalled"), "empty chunks extended idle deadline");
}));

Deno.test("compressed input progress prevents a false stall before decoded output", () => withClock(async advance => {
  let chunks = 0;
  const options = {
    fetchStream: async (_url: string, _signal: AbortSignal, onProgress?: (bytes: number) => void) => new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ === 6) { controller.enqueue(new Uint8Array([9])); controller.close(); return; }
        advance(20_000);
        onProgress?.(100);
        controller.enqueue(new Uint8Array());
      },
    }),
  };
  const bytes = await loadSysrootArchiveBytes("wasm32-wasip1", options);
  assert(bytes.join(",") === "9", "buffered decode output was lost");
}));

Deno.test("real asynchronous activity renews the idle timer", async () => {
  let sent = 0;
  let cancelled = false;
  const options = {
    timeoutMs: 1000,
    idleTimeoutMs: 100,
    fetchStream: async () => new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 30));
        if (cancelled) return;
        controller.enqueue(new Uint8Array([++sent]));
        if (sent === 6) controller.close();
      },
      cancel() { cancelled = true; },
    }),
  };
  const bytes = await loadSysrootArchiveBytes("rust-src", options);
  assert(bytes.length === 6 && !cancelled, "timer expired despite continuing activity");
});
