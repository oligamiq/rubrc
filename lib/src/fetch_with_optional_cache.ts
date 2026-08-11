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
  const cacheInput = new Request(input, init);
  const responseIsAccepted = async (response: Response): Promise<boolean> => {
    try {
      return acceptResponse(response);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  };

  let cache: CacheBoundary;
  try {
    cache = await cacheStorage.open("rubrc-assets-v1");
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  let cachedResponse: Response | undefined;
  try {
    cachedResponse = await cache.match(cacheInput);
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  if (cachedResponse) {
    if (cachedResponse.ok && (await responseIsAccepted(cachedResponse))) {
      return cachedResponse;
    }
    await cachedResponse.body?.cancel().catch(() => undefined);
    try {
      await cache.delete(cacheInput);
    } catch (error) {
      reportCacheError(error);
    }
  }

  const response = await fetch(input, init);
  if (response.ok && (await responseIsAccepted(response))) {
    const cacheResponse = response.clone();
    void cache.put(cacheInput, cacheResponse).catch(async (error) => {
      await cacheResponse.body?.cancel().catch(() => undefined);
      reportCacheError(error);
    });
  }
  return response;
}
