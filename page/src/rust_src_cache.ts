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

function cacheBuildEpoch(url: URL): number | undefined {
  const values = url.searchParams.getAll("build");
  if (values.length === 0) return 0;
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0])) {
    return undefined;
  }
  const value = Number(values[0]);
  return Number.isSafeInteger(value) ? value : undefined;
}

export async function pruneRustSrcCacheVariants(
  archiveUrl: string,
  sourceRevision: string,
  dependencies: RustSrcCacheDependencies,
): Promise<void> {
  try {
    const cacheStorage = dependencies.cacheStorage;
    if (!cacheStorage) return;
    const current = new URL(
      archiveUrl,
      typeof location === "undefined"
        ? "https://development.invalid/"
        : location.href,
    );
    const currentBuildEpoch = cacheBuildEpoch(current);
    const cache = await cacheStorage.open("rubrc-assets-v1");
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
      metadata.sourceSha !== sourceRevision ||
      !("buildEpoch" in metadata) ||
      typeof metadata.buildEpoch !== "number" ||
      !Number.isSafeInteger(metadata.buildEpoch) ||
      metadata.buildEpoch <= 0 ||
      metadata.buildEpoch !== currentBuildEpoch
    )
      return;

    for (const request of requests) {
      const candidate = new URL(request.url);
      if (
        candidate.origin === current.origin &&
        candidate.pathname === current.pathname &&
        candidate.href !== current.href
      ) {
        const candidateBuildEpoch = cacheBuildEpoch(candidate);
        if (
          candidateBuildEpoch !== undefined &&
          candidateBuildEpoch < metadata.buildEpoch
        ) {
          await cache.delete(request);
        }
      }
    }
  } catch (error) {
    dependencies.reportError(error);
  }
}
