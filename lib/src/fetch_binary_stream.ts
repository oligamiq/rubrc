import {
  type FetchInput,
  type FetchWithOptionalCacheDependencies,
  fetchWithOptionalCache,
} from "./fetch_with_optional_cache.ts";

export type FetchBinaryStreamDependencies = Omit<
  FetchWithOptionalCacheDependencies,
  "acceptResponse"
>;

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function mediaType(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null || contentType.includes(",")) return null;
  const [rawType, ...rawParameters] = contentType.split(";");
  const typeParts = rawType.trim().split("/");
  if (
    typeParts.length !== 2 ||
    !HTTP_TOKEN.test(typeParts[0]) ||
    !HTTP_TOKEN.test(typeParts[1])
  ) return null;
  for (const rawParameter of rawParameters) {
    const separator = rawParameter.indexOf("=");
    if (separator < 1) return null;
    const name = rawParameter.slice(0, separator).trim();
    const value = rawParameter.slice(separator + 1).trim();
    if (!HTTP_TOKEN.test(name) || !HTTP_TOKEN.test(value)) return null;
  }
  return typeParts.join("/").toLowerCase();
}

export function isAcceptedBinaryResponse(response: Response): boolean {
  return mediaType(response) === "application/octet-stream";
}

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export async function fetchBinaryStream(
  url: FetchInput,
  signal: AbortSignal | undefined,
  dependencies: FetchBinaryStreamDependencies,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetchWithOptionalCache(
    url,
    signal === undefined ? undefined : { signal },
    {
      ...dependencies,
      acceptResponse: isAcceptedBinaryResponse,
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to fetch binary asset: ${response.status}`);
  }
  if (!isAcceptedBinaryResponse(response)) {
    const contentType = response.headers.get("content-type");
    await response.body?.cancel().catch(() => undefined);
    const reason = contentType === null
      ? "missing Content-Type"
      : `unsupported Content-Type ${JSON.stringify(contentType)}`;
    throw new Error(
      `Invalid binary asset response for ${requestUrl(url)}: ${reason}`,
    );
  }
  if (!response.body) throw new Error("No body in binary asset response");
  return response.body;
}

export const fetch_binary_stream = async (
  url: FetchInput,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> =>
  await fetchBinaryStream(url, signal, {
    cacheStorage: "caches" in globalThis ? globalThis.caches : undefined,
    fetch,
    reportCacheError(error) {
      console.warn("Failed to cache binary asset", error);
    },
  });
