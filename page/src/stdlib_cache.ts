import { STDLIB_CACHE_SESSION_ID } from "./lsp_protocol.ts";

export const STDLIB_CACHE_PATH = "/.cache/rust-analyzer/std.salsa";

export async function installStdlibCache(
  input: (args: { sessionId: number; data: Uint8Array }) => Promise<void>,
  bytes: Uint8Array,
): Promise<void> {
  await input({ sessionId: STDLIB_CACHE_SESSION_ID, data: bytes });
}

export async function fetchStdlibCache(
  baseUrl: string,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  try {
    signal.throwIfAborted();
    const base = baseUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/std-cache.json`, {
      signal,
      cache: "no-cache",
    });
    if (!response.ok) return undefined;
    const manifest = await response.json();
    if (
      manifest?.version !== 1 || typeof manifest.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.hash) ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 1 ||
      manifest.size > 256 * 1024 * 1024 ||
      !Array.isArray(manifest.parts) || manifest.parts.length < 1 ||
      manifest.parts.length > 128
    ) return undefined;
    let total = 0;
    for (const [i, part] of manifest.parts.entries()) {
      if (
        part?.file !==
          `std-${manifest.hash}.salsa.part-${String(i).padStart(3, "0")}` ||
        !Number.isSafeInteger(part.size) || part.size < 1 ||
        part.size > 24 * 1024 * 1024
      ) return undefined;
      total += part.size;
    }
    if (total !== manifest.size) return undefined;
    const bytes = new Uint8Array(manifest.size);
    let offset = 0;
    for (let i = 0; i < manifest.parts.length; i += 2) {
      const batch = manifest.parts.slice(i, i + 2) as Array<
        { file: string; size: number }
      >;
      const chunks = await Promise.all(batch.map(async (part) => {
        const blob = await fetch(`${base}/${part.file}`, {
          signal,
          cache: "force-cache",
        });
        if (!blob.ok) throw new Error("cache part unavailable");
        const chunk = await blob.arrayBuffer();
        if (chunk.byteLength !== part.size) {
          throw new Error("cache part size mismatch");
        }
        return new Uint8Array(chunk);
      }));
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
      .join("");
    signal.throwIfAborted();
    return hash === manifest.hash ? bytes : undefined;
  } catch (error) {
    signal.throwIfAborted();
    // Cache download/format failures never prevent ordinary cold startup.
    return undefined;
  }
}
