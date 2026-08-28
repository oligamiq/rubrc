export interface WasmPartDescriptor {
  file: string;
  size: number;
}

interface PartState {
  part: WasmPartDescriptor;
  index: number;
  url: string;
  chunks: Uint8Array[];
  loaded: number;
  done: boolean;
  waiter: (() => void) | null;
}

type FetchPart = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface PartCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

const PART_CACHE_NAME = "rubrc-vfs-parts-v1";

export interface ParallelPartStream {
  stream: ReadableStream<Uint8Array>;
  cacheReady: Promise<void>;
}

export function createParallelPartStream(options: {
  parts: readonly WasmPartDescriptor[];
  manifestUrl: string;
  signal: AbortSignal;
  fetchPart?: FetchPart;
  partCache?: PartCache | null;
  onChunk?: (bytes: number, partIndex: number) => void;
}): ParallelPartStream {
  const fetchPart = options.fetchPart ?? fetch;
  const abortController = new AbortController();
  // Every state is pumped immediately. Later parts queue only until all earlier
  // Brotli bytes have been emitted, so part 0 can feed decompression at once.
  const states: PartState[] = options.parts.map((part, index) => ({
    part,
    index,
    url: new URL(part.file, options.manifestUrl).href,
    chunks: [],
    loaded: 0,
    done: false,
    waiter: null,
  }));
  let currentPart = 0;
  let firstError: unknown | undefined;

  const wake = (state: PartState): void => {
    const waiter = state.waiter;
    state.waiter = null;
    waiter?.();
  };
  const wakeAll = (): void => {
    for (const state of states) wake(state);
  };
  const fail = (error: unknown): void => {
    if (firstError === undefined) firstError = error;
    if (!abortController.signal.aborted) abortController.abort(error);
    wakeAll();
  };

  const onExternalAbort = (): void => {
    fail(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  if (options.signal.aborted) {
    onExternalAbort();
  } else {
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const partCachePromise = options.partCache !== undefined
    ? Promise.resolve(options.partCache)
    : openDefaultPartCache();

  const waitForPart = async (state: PartState): Promise<void> => {
    if (state.chunks.length > 0 || state.done || firstError !== undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      state.waiter = resolve;
    });
  };

  const getResponse = async (state: PartState): Promise<{
    response: Response;
    cache: PartCache | null;
    fromCache: boolean;
  }> => {
    const cache = await partCachePromise;
    let cached: Response | undefined;
    try {
      cached = await cache?.match(state.url);
    } catch {
      cached = undefined;
    }
    if (cached?.ok) {
      const contentLength = cached.headers.get("content-length");
      if (contentLength === null || Number(contentLength) === state.part.size) {
        return { response: cached, cache, fromCache: true };
      }
      await cache?.delete(state.url).catch(() => false);
    }

    const response = await fetchPart(state.url, {
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch part ${state.index} (${state.url}): ` +
          `${response.status} ${response.statusText}`,
      );
    }
    return { response, cache, fromCache: false };
  };

  const pumpPart = async (state: PartState): Promise<void> => {
    let cacheWrite: Promise<void> | null = null;
    let cache: PartCache | null = null;
    try {
      const result = await getResponse(state);
      cache = result.cache;
      const response = result.response;
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) !== state.part.size) {
        if (result.fromCache) await cache?.delete(state.url).catch(() => false);
        throw new Error(
          `Part size mismatch for ${state.part.file}: ` +
            `Content-Length ${contentLength}, expected ${state.part.size}`,
        );
      }

      if (!result.fromCache && cache) {
        cacheWrite = cache.put(state.url, response.clone()).catch(() =>
          undefined
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`No body on part response ${state.index}`);
      const cancelReader = (): void => {
        void reader.cancel(abortController.signal.reason).catch(() =>
          undefined
        );
      };
      if (abortController.signal.aborted) cancelReader();
      else {
        abortController.signal.addEventListener("abort", cancelReader, {
          once: true,
        });
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          state.loaded += value.byteLength;
          if (state.loaded > state.part.size) {
            await reader.cancel("part exceeds declared size");
            throw new Error(
              `Part size mismatch for ${state.part.file}: loaded more than ${state.part.size}`,
            );
          }
          state.chunks.push(value);
          options.onChunk?.(value.byteLength, state.index);
          wake(state);
        }
      } finally {
        abortController.signal.removeEventListener("abort", cancelReader);
      }

      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }
      if (state.loaded !== state.part.size) {
        throw new Error(
          `Part size mismatch for ${state.part.file}: loaded ${state.loaded}, ` +
            `expected ${state.part.size}`,
        );
      }
      state.done = true;
      wake(state);
      if (cacheWrite) await cacheWrite;
    } catch (error) {
      fail(error);
      if (cacheWrite) await cacheWrite;
      await cache?.delete(state.url).catch(() => false);
    }
  };

  const pumps = states.map((state) => pumpPart(state));
  const cacheReady = Promise.all(pumps).then(() => undefined);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (firstError !== undefined) {
          controller.error(firstError);
          return;
        }
        if (currentPart >= states.length) {
          options.signal.removeEventListener("abort", onExternalAbort);
          controller.close();
          return;
        }

        const state = states[currentPart];
        const chunk = state.chunks.shift();
        if (chunk) {
          controller.enqueue(chunk);
          return;
        }
        if (state.done) {
          currentPart++;
          continue;
        }
        await waitForPart(state);
      }
    },
    cancel(reason) {
      options.signal.removeEventListener("abort", onExternalAbort);
      if (!abortController.signal.aborted) abortController.abort(reason);
      wakeAll();
    },
  });

  return { stream, cacheReady };
}

async function openDefaultPartCache(): Promise<PartCache | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(PART_CACHE_NAME);
    return {
      async match(url) {
        return (await cache.match(url)) ?? undefined;
      },
      put(url, response) {
        return cache.put(url, response);
      },
      delete(url) {
        return cache.delete(url);
      },
    };
  } catch {
    return null;
  }
}
