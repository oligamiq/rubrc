import {
  type FetchInput,
  type FetchWithOptionalCacheDependencies,
  fetchWithOptionalCache,
} from "./fetch_with_optional_cache.ts";

const ACCEPTED_COMPRESSED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/brotli",
  "application/x-brotli",
]);
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type FetchCompressedStreamDependencies = Omit<
  FetchWithOptionalCacheDependencies,
  "acceptResponse"
> & {
  getDecompressStream(): Promise<TransformStream<Uint8Array, Uint8Array>>;
};

function mediaType(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null || contentType.includes(",")) return null;

  const [rawType, ...rawParameters] = contentType.split(";");
  const typeParts = rawType.trim().split("/");
  if (
    typeParts.length !== 2 ||
    !HTTP_TOKEN.test(typeParts[0]) ||
    !HTTP_TOKEN.test(typeParts[1])
  ) {
    return null;
  }
  for (const rawParameter of rawParameters) {
    const separator = rawParameter.indexOf("=");
    if (separator < 1) return null;
    const name = rawParameter.slice(0, separator).trim();
    const value = rawParameter.slice(separator + 1).trim();
    if (!HTTP_TOKEN.test(name) || !HTTP_TOKEN.test(value)) return null;
  }

  return typeParts.join("/").toLowerCase();
}

export function isAcceptedCompressedResponse(response: Response): boolean {
  const type = mediaType(response);
  return type !== null && ACCEPTED_COMPRESSED_CONTENT_TYPES.has(type);
}

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export async function fetchCompressedStream(
  url: FetchInput,
  signal: AbortSignal | undefined,
  dependencies: FetchCompressedStreamDependencies,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetchWithOptionalCache(
    url,
    signal === undefined ? undefined : { signal },
    {
      cacheStorage: dependencies.cacheStorage,
      fetch: dependencies.fetch,
      reportCacheError: dependencies.reportCacheError,
      acceptResponse: isAcceptedCompressedResponse,
    },
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Failed to fetch wasm");
  }
  if (!isAcceptedCompressedResponse(response)) {
    const contentType = response.headers.get("content-type");
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Invalid compressed asset response for ${requestUrl(url)}: unsupported Content-Type ${JSON.stringify(contentType)}`,
    );
  }
  if (!response.body) {
    throw new Error("No body in response");
  }

  return response.body.pipeThrough(await dependencies.getDecompressStream());
}
