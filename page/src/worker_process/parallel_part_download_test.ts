import { createParallelPartStream } from "./parallel_part_download.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const result: number[] = [];
  for await (const chunk of stream) result.push(...chunk);
  return result;
}

Deno.test("all part bodies download concurrently while part 0 streams immediately", async () => {
  const startedFetches: number[] = [];
  const startedReads = new Set<number>();
  const finishedReads = new Set<number>();
  const gates = [deferred(), deferred(), deferred()];

  const { stream } = createParallelPartStream({
    parts: [0, 1, 2].map((index) => ({
      file: `vfs.wasm.br.part-${index}`,
      size: 2,
    })),
    manifestUrl: "https://example.test/vfs.wasm.br.json",
    signal: new AbortController().signal,
    partCache: null,
    fetchPart: (url) => {
      const index = Number(url.slice(-1));
      startedFetches.push(index);
      let step = 0;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            async pull(controller) {
              startedReads.add(index);
              if (step++ === 0) {
                controller.enqueue(new Uint8Array([index]));
                return;
              }
              await gates[index].promise;
              controller.enqueue(new Uint8Array([index + 10]));
              controller.close();
              finishedReads.add(index);
            },
          }),
        ),
      );
    },
  });

  await waitFor(() => startedFetches.length === 3);
  assert(
    startedFetches.join(",") === "0,1,2",
    `fetches did not start together: ${startedFetches}`,
  );
  await waitFor(() => startedReads.size === 3);

  const reader = stream.getReader();
  const first = await reader.read();
  assert(
    !first.done && first.value[0] === 0,
    "part 0 did not stream immediately",
  );
  assert(
    !finishedReads.has(0),
    "part 0 finished before its first chunk was consumed",
  );

  gates[2].resolve();
  gates[1].resolve();
  await waitFor(() => finishedReads.has(1) && finishedReads.has(2));
  assert(!finishedReads.has(0), "part 0 unexpectedly finished");

  gates[0].resolve();
  const bytes = [...first.value];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.push(...value);
  }
  assert(
    bytes.join(",") === "0,10,1,11,2,12",
    `compressed stream order changed: ${bytes}`,
  );
});

Deno.test("parallel part stream validates each declared size", async () => {
  const { stream } = createParallelPartStream({
    parts: [{ file: "vfs.wasm.br.part-000", size: 2 }],
    manifestUrl: "https://example.test/vfs.wasm.br.json",
    signal: new AbortController().signal,
    partCache: null,
    fetchPart: () => Promise.resolve(new Response(new Uint8Array([1]))),
  });

  let message = "";
  try {
    await readAll(stream);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    message.includes("Part size mismatch"),
    `unexpected failure: ${message}`,
  );
});

Deno.test("downloaded parts are reused from the part cache", async () => {
  const stored = new Map<string, Response>();
  const partCache = {
    match(url: string) {
      return Promise.resolve(stored.get(url)?.clone());
    },
    put(url: string, response: Response) {
      stored.set(url, response.clone());
      return Promise.resolve();
    },
    delete(url: string) {
      return Promise.resolve(stored.delete(url));
    },
  };
  let fetchCount = 0;
  const parts = [
    { file: "vfs.wasm.br.part-000", size: 2 },
    { file: "vfs.wasm.br.part-001", size: 2 },
  ];

  const first = createParallelPartStream({
    parts,
    manifestUrl: "https://example.test/vfs.wasm.br.json",
    signal: new AbortController().signal,
    partCache,
    fetchPart: (url) => {
      fetchCount++;
      const index = Number(url.slice(-1));
      return Promise.resolve(new Response(new Uint8Array([index, index + 10])));
    },
  });

  assert(
    (await readAll(first.stream)).join(",") === "0,10,1,11",
    "first network stream was corrupted",
  );
  await first.cacheReady;
  assert(fetchCount === 2, `unexpected initial fetch count: ${fetchCount}`);

  const second = createParallelPartStream({
    parts,
    manifestUrl: "https://example.test/vfs.wasm.br.json",
    signal: new AbortController().signal,
    partCache,
    fetchPart: () => {
      throw new Error("network should not be used for cached parts");
    },
  });
  assert(
    (await readAll(second.stream)).join(",") === "0,10,1,11",
    "cached part stream was corrupted",
  );
  await second.cacheReady;
});

Deno.test("production loader decompresses while streaming into compileStreaming", async () => {
  const source = await Deno.readTextFile(
    new URL("./util_cmd.ts", import.meta.url),
  );
  const stream = source.indexOf(
    "const partStream = createParallelPartStream({",
  );
  const decompress = source.indexOf(".pipeThrough(decompressStream)", stream);
  const compile = source.indexOf("WebAssembly.compileStreaming(", decompress);
  assert(
    stream >= 0,
    "production loader does not create the parallel part stream",
  );
  assert(decompress > stream, "compressed stream is not piped through Brotli");
  assert(
    compile > decompress,
    "decompressed stream is not compileStreaming input",
  );
  assert(
    !source.includes("downloadedPart.chunks"),
    "production loader still waits for fully downloaded parts",
  );
});

Deno.test("part cache commit does not block the compressed stream", async () => {
  const commitGate = deferred();
  let cacheReadyResolved = false;
  const result = createParallelPartStream({
    parts: [{ file: "vfs.wasm.br.part-000", size: 2 }],
    manifestUrl: "https://example.test/vfs.wasm.br.json",
    signal: new AbortController().signal,
    partCache: {
      match: () => Promise.resolve(undefined),
      async put(_url, response) {
        await response.arrayBuffer();
        await commitGate.promise;
      },
      delete: () => Promise.resolve(false),
    },
    fetchPart: () => Promise.resolve(new Response(new Uint8Array([4, 5]))),
  });

  void result.cacheReady.then(() => {
    cacheReadyResolved = true;
  });
  assert((await readAll(result.stream)).join(",") === "4,5", "stream stalled");
  await Promise.resolve();
  assert(!cacheReadyResolved, "stream waited for cache commit");
  commitGate.resolve();
  await result.cacheReady;
});
