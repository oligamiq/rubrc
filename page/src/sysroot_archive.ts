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
export type ArchiveBytesOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchStream?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>;
};
type ParseArchiveOptions = {
  timeoutMs?: number;
  parse?: (
    stream: ReadableStream<Uint8Array>,
    visit: (file: ArchiveFile) => void,
  ) => Promise<void>;
};

const BASE_URL = "https://oligamiq.github.io/rust_wasm/v0.2.0";
const RUST_SRC_ASSET = "rust-src.tar.vfsbr";
declare const __RUBRC_SOURCE_REVISION__: string;
declare const __RUBRC_BUILD_EPOCH__: string;
const SOURCE_REVISION = typeof __RUBRC_SOURCE_REVISION__ === "undefined"
  ? "development"
  : __RUBRC_SOURCE_REVISION__;
const BUILD_EPOCH = typeof __RUBRC_BUILD_EPOCH__ === "undefined"
  ? "0"
  : __RUBRC_BUILD_EPOCH__;

export function sysrootArchiveUrl(
  triple: string,
  pageUrl = typeof location === "undefined" ? undefined : location.href,
  sourceRevision = SOURCE_REVISION,
  buildEpoch = BUILD_EPOCH,
): string {
  if (triple !== "rust-src") return `${BASE_URL}/${triple}.tar.br`;
  const url = pageUrl === undefined
    ? new URL(`./${RUST_SRC_ASSET}`, "https://development.invalid/")
    : new URL(RUST_SRC_ASSET, pageUrl);
  url.searchParams.set("v", sourceRevision);
  url.searchParams.set("build", buildEpoch);
  return pageUrl === undefined ? `./${RUST_SRC_ASSET}${url.search}` : url.href;
}

export function maintainRustSrcArchiveCache(): void {
  const archiveUrl = sysrootArchiveUrl("rust-src");
  void pruneRustSrcCacheVariants(archiveUrl, SOURCE_REVISION, {
    get cacheStorage() {
      return "caches" in globalThis ? globalThis.caches : undefined;
    },
    fetch: (input, init) => fetch(input, init),
    reportError: (error) =>
      console.warn("Failed to maintain rust-src cache", error),
  });
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

export async function loadSysrootArchiveBytes(
  triple: string,
  options: ArchiveBytesOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const externalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", externalAbort, { once: true });
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
    const fetchStream = options.fetchStream ??
      (await import("../../lib/src/brotli_stream.ts")).fetch_compressed_stream;
    const archiveUrl = sysrootArchiveUrl(triple);
    const stream = await fetchStream(archiveUrl, controller.signal);
    const reader = stream.getReader();
    const cancelRead = () => {
      void reader.cancel(controller.signal.reason).catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancelRead, { once: true });
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    try {
      while (true) {
        checkDeadline();
        const { done, value } = await reader.read();
        checkDeadline();
        if (done) break;
        if (value.byteLength === 0) continue;
        chunks.push(value);
        totalLength += value.byteLength;
      }
    } finally {
      controller.signal.removeEventListener("abort", cancelRead);
    }
    checkDeadline();
    const archiveBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      archiveBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return archiveBytes;
  })();
  void operation.catch(() => undefined);
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else {controller.signal.addEventListener("abort", rejectAbort, {
        once: true,
      });}
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      aborted,
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
    options.signal?.removeEventListener("abort", externalAbort);
  }
}

export async function parseSysrootArchiveEntriesFromBytes(
  archiveBytes: Uint8Array<ArrayBuffer>,
  options: ParseArchiveOptions = {},
): Promise<SysrootArchiveEntry[]> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const parse = options.parse ??
    (await import("../../lib/src/parse_tar.ts")).parseTar;
  const deadline = performance.now() + timeoutMs;
  const checkDeadline = () => {
    if (performance.now() >= deadline) {
      throw new Error(`sysroot archive parse timed out after ${timeoutMs}ms`);
    }
  };
  const entries: SysrootArchiveEntry[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(archiveBytes);
      controller.close();
    },
  });
  await parse(stream, (file) => {
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
  return entries;
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
    const fetchStream = options.fetchStream ??
      (await import("../../lib/src/brotli_stream.ts")).fetch_compressed_stream;
    const parse = options.parse ??
      (await import("../../lib/src/parse_tar.ts")).parseTar;
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
      const maintainRustSrcCache = options.maintainRustSrcCache ??
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
