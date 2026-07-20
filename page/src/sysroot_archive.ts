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

export async function loadSysrootArchive(
  triple: string,
  options: ArchiveOptions = {},
): Promise<SysrootArchiveEntry[]> {
  const controller = new AbortController();
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
    await parse(stream, (file) => {
      entries.push({
        name: new TextEncoder().encode(file.name),
        data: file.data ?? new Uint8Array(),
        isDirectory: file.type === "directory",
      });
    });
    return entries;
  })();
  void operation.catch(() => undefined);
  const timeoutMs = options.timeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `sysroot archive ${triple} timed out after ${timeoutMs}ms`,
          );
          reject(error);
          controller.abort(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
