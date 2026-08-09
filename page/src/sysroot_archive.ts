import { pruneRustSrcCacheVariants } from "./rust_src_cache.ts";

export type SysrootArchiveEntry = {
  name: Uint8Array;
  data: Uint8Array;
  isDirectory: boolean;
};

type ArchiveFile = { name: string; data?: Uint8Array; type?: string };
type ArchiveOptions = {
  timeoutMs?: number;
  fetchStream?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>;
  parse?: (
    stream: ReadableStream<Uint8Array>,
    visit: (file: ArchiveFile) => void,
  ) => Promise<void>;
  maintainRustSrcCache?: (archiveUrl: string) => void;
};

const BASE_URL = "https://oligamiq.github.io/rust_wasm/v0.2.0";
const RUST_SRC_ASSET = "rust-src.tar.vfsbr";
declare const __RUBRC_SOURCE_REVISION__: string;
declare const __RUBRC_BUILD_EPOCH__: string;
const SOURCE_REVISION =
  typeof __RUBRC_SOURCE_REVISION__ === "undefined"
    ? "development"
    : __RUBRC_SOURCE_REVISION__;
const BUILD_EPOCH =
  typeof __RUBRC_BUILD_EPOCH__ === "undefined" ? "0" : __RUBRC_BUILD_EPOCH__;

export function sysrootArchiveUrl(
  triple: string,
  pageUrl = typeof location === "undefined" ? undefined : location.href,
  sourceRevision = SOURCE_REVISION,
  buildEpoch = BUILD_EPOCH,
): string {
  if (triple !== "rust-src") return `${BASE_URL}/${triple}.tar.br`;
  const url =
    pageUrl === undefined
      ? new URL(`./${RUST_SRC_ASSET}`, "https://development.invalid/")
      : new URL(RUST_SRC_ASSET, pageUrl);
  url.searchParams.set("v", sourceRevision);
  url.searchParams.set("build", buildEpoch);
  return pageUrl === undefined ? `./${RUST_SRC_ASSET}${url.search}` : url.href;
}

export function validateSysrootArchiveEntryName(name: string): string | null {
  if (name.startsWith("/")) {
    throw new Error(`unsafe sysroot archive entry: ${name}`);
  }
  const parts: string[] = [];
  for (const part of name.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new Error(`unsafe sysroot archive entry: ${name}`);
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("/");
}

export async function loadSysrootArchive(
  triple: string,
  options: ArchiveOptions = {},
): Promise<SysrootArchiveEntry[]> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = performance.now() + timeoutMs;
  const timeoutError = () =>
    new Error(`sysroot archive ${triple} timed out after ${timeoutMs}ms`);
  const checkDeadline = () => {
    controller.signal.throwIfAborted();
    if (performance.now() >= deadline) {
      const error = timeoutError();
      controller.abort(error);
      throw error;
    }
  };
  const operation = (async () => {
    const fetchStream =
      options.fetchStream ??
      (await import("../../lib/src/brotli_stream.ts")).fetch_compressed_stream;
    const parse =
      options.parse ?? (await import("../../lib/src/parse_tar.ts")).parseTar;
    const archiveUrl = sysrootArchiveUrl(triple);
    const stream = await fetchStream(archiveUrl, controller.signal);
    const entries: SysrootArchiveEntry[] = [];
    const abortableStream = stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, streamController) {
          checkDeadline();
          streamController.enqueue(chunk);
        },
      }),
      { signal: controller.signal },
    );
    await parse(abortableStream, (file) => {
      checkDeadline();
      const name = validateSysrootArchiveEntryName(file.name);
      if (name === null) return;
      entries.push({
        name: new TextEncoder().encode(name),
        data: file.data ?? new Uint8Array(),
        isDirectory: file.type === "directory",
      });
    });
    checkDeadline();
    if (triple === "rust-src") {
      const maintainRustSrcCache =
        options.maintainRustSrcCache ??
        ((url) => {
          void pruneRustSrcCacheVariants(url, SOURCE_REVISION, {
            get cacheStorage() {
              return "caches" in globalThis ? globalThis.caches : undefined;
            },
            fetch: (input, init) => fetch(input, init),
            reportError: (error) =>
              console.warn("Failed to maintain rust-src cache", error),
          });
        });
      maintainRustSrcCache(archiveUrl);
    }
    return entries;
  })();
  void operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError();
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
