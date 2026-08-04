type FetchInput = string | URL | Request;

interface CacheBoundary {
  match(input: FetchInput): Promise<Response | undefined>;
  put(input: FetchInput, response: Response): Promise<void>;
}

interface CacheStorageBoundary {
  open(name: string): Promise<CacheBoundary>;
}

interface FetchWithOptionalCacheDependencies {
  cacheStorage?: CacheStorageBoundary;
  fetch(input: FetchInput, init?: RequestInit): Promise<Response>;
  reportCacheError(error: unknown): void;
}

export async function fetchWithOptionalCache(
  input: FetchInput,
  init: RequestInit | undefined,
  dependencies: FetchWithOptionalCacheDependencies,
): Promise<Response> {
  const { cacheStorage, fetch, reportCacheError } = dependencies;
  if (!cacheStorage) return await fetch(input, init);

  let cache: CacheBoundary;
  try {
    cache = await cacheStorage.open("rubrc-assets-v1");
    const cachedResponse = await cache.match(input);
    if (cachedResponse) return cachedResponse;
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  const response = await fetch(input, init);
  if (response.ok) {
    void cache.put(input, response.clone()).catch(reportCacheError);
  }
  return response;
}
