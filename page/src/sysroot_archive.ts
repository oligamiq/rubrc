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
};

const BASE_URL = "https://oligamiq.github.io/rust_wasm/v0.2.0";

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
    const fetchStream = options.fetchStream ??
      (await import("../../lib/src/brotli_stream.ts")).fetch_compressed_stream;
    const parse = options.parse ??
      (await import("../../lib/src/parse_tar.ts")).parseTar;
    const stream = await fetchStream(
      `${BASE_URL}/${triple}.tar.br`,
      controller.signal,
    );
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
