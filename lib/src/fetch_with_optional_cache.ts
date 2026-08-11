export type FetchInput = string | URL | Request;

export interface CacheBoundary {
  match(input: FetchInput): Promise<Response | undefined>;
  delete(input: FetchInput): Promise<boolean>;
  put(input: FetchInput, response: Response): Promise<void>;
}

export interface CacheStorageBoundary {
  open(name: string): Promise<CacheBoundary>;
}

export interface FetchWithOptionalCacheDependencies {
  cacheStorage?: CacheStorageBoundary;
  fetch(input: FetchInput, init?: RequestInit): Promise<Response>;
  reportCacheError(error: unknown): void;
  acceptResponse?: (response: Response) => boolean;
}

export async function fetchWithOptionalCache(
  input: FetchInput,
  init: RequestInit | undefined,
  dependencies: FetchWithOptionalCacheDependencies,
): Promise<Response> {
  const {
    cacheStorage,
    fetch,
    reportCacheError,
    acceptResponse = () => true,
  } = dependencies;
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "GET") {
    return await fetch(input, init);
  }
  if (!cacheStorage) return await fetch(input, init);

  let cache: CacheBoundary;
  try {
    cache = await cacheStorage.open("rubrc-assets-v1");
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  let cachedResponse: Response | undefined;
  try {
    cachedResponse = await cache.match(input);
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  if (cachedResponse) {
    if (cachedResponse.ok && acceptResponse(cachedResponse)) {
      return cachedResponse;
    }
    await cachedResponse.body?.cancel().catch(() => undefined);
    try {
      await cache.delete(input);
    } catch (error) {
      reportCacheError(error);
    }
  }

  const response = await fetch(input, init);
  if (response.ok && acceptResponse(response)) {
    const cacheResponse = response.clone();
    void cache.put(input, cacheResponse).catch(async (error) => {
      await cacheResponse.body?.cancel().catch(() => undefined);
      reportCacheError(error);
    });
  }
  return response;
}
