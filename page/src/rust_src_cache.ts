type FetchInput = string | URL | Request;

type RustSrcCache = {
  keys(): Promise<readonly Request[]>;
  delete(request: Request): Promise<boolean>;
};

export type RustSrcCacheDependencies = {
  cacheStorage?: { open(name: string): Promise<RustSrcCache> };
  fetch(input: FetchInput, init?: RequestInit): Promise<Response>;
  reportError(error: unknown): void;
};

export async function pruneRustSrcCacheVariants(
  archiveUrl: string,
  sourceRevision: string,
  dependencies: RustSrcCacheDependencies,
): Promise<void> {
  if (!dependencies.cacheStorage) return;
  try {
    const current = new URL(
      archiveUrl,
      typeof location === "undefined"
        ? "https://development.invalid/"
        : location.href,
    );
    const cache = await dependencies.cacheStorage.open("rubrc-assets-v1");
    const requests = await cache.keys();
    const metadataUrl = new URL(".rubrc-pages-build.json", current);
    const response = await dependencies.fetch(metadataUrl, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const metadata: unknown = await response.json();
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("version" in metadata) ||
      metadata.version !== 1 ||
      !("sourceSha" in metadata) ||
      metadata.sourceSha !== sourceRevision
    )
      return;

    for (const request of requests) {
      const candidate = new URL(request.url);
      if (
        candidate.origin === current.origin &&
        candidate.pathname === current.pathname &&
        candidate.href !== current.href
      ) {
        await cache.delete(request);
      }
    }
  } catch (error) {
    dependencies.reportError(error);
  }
}
