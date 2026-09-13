import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { takeExactSysrootChunk } from "../page/src/sysroot_protocol.ts";
import { prepareReleasedRustSrcSquashfs } from "./rust_src_archive.ts";
import { prepareCachedArchive } from "./sysroot_cache.ts";

const timeoutMs = 120_000;
const rustSrc = await prepareReleasedRustSrcSquashfs();
const wasm32 = await prepareCachedArchive({ triple: "wasm32-wasip1" });

async function decompressBrotli(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const reader = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream("brotli"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const wasm32Tar = await decompressBrotli(wasm32.archive);
let currentArchive: Uint8Array | null = null;
let maxChunk = 0;
let farmTerminalOutput = "";
const farmTerminalDecoder = new TextDecoder();
const filesystemRoot = new Directory(new Map());
filesystemRoot.contents.set(
  "Cargo.toml",
  new File(
    new TextEncoder().encode(
      '[package]\nname = "metadata-capture"\nversion = "0.1.0"\nedition = "2021"\n',
    ),
  ),
);
const src = new Map<string, File>();
src.set("main.rs", new File(new TextEncoder().encode("fn main() {}\n")));
filesystemRoot.contents.set("src", new Directory(src));
const preopen = new PreopenDirectory("/", filesystemRoot.contents);

const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) => console.log(`[stdout] ${message}`)),
  ConsoleStdout.lineBuffered((message) => console.error(`[stderr] ${message}`)),
  [preopen],
  {
    allocator_size: 100 * 1024 * 1024,
    unknown_fn(message: unknown) {
      const value = message as {
        name?: string;
        args?: {
          triple?: string;
          chunk_len?: number;
          data?: unknown;
        };
      };
      if (value.name?.startsWith("childProcess")) {
        return { request_id: 0, state: 0, status: 0, error_len: 0 };
      }
      if (value.name === "terminalWrite") {
        const data = Array.isArray(value.args?.data)
          ? Uint8Array.from(value.args.data as number[])
          : new Uint8Array();
        farmTerminalOutput += farmTerminalDecoder.decode(data, { stream: true });
        return {};
      }
      if (value.name === "sysrootStartFetch") {
        if (value.args?.triple === "rust-src") {
          currentArchive = new Uint8Array(rustSrc.archive);
        } else if (value.args?.triple === "wasm32-wasip1") {
          currentArchive = new Uint8Array(wasm32Tar);
        } else {
          currentArchive = null;
        }
        return {};
      }
      if (value.name === "sysrootArchiveGetMeta") {
        return currentArchive === null
          ? { has_archive: false, data_len: 0 }
          : { has_archive: true, data_len: currentArchive.length };
      }
      if (value.name === "sysrootReadArchiveChunk") {
        const requested = value.args?.chunk_len;
        if (typeof requested !== "number" || currentArchive === null) {
          throw new Error("invalid sysroot chunk request");
        }
        maxChunk = Math.max(maxChunk, requested);
        const { chunk, remaining } = takeExactSysrootChunk(
          currentArchive,
          requested,
        );
        currentArchive = remaining.length === 0 ? null : remaining;
        return { chunk: Array.from(chunk) };
      }
      throw new Error(`unexpected farm callback: ${value.name ?? "unknown"}`);
    },
  },
);

const worker = new Worker(
  new URL("./vfs_debug_shell_worker.ts", import.meta.url),
  { type: "module" },
);
const command = [
  "cargo",
  "metadata",
  "--format-version",
  "1",
  "--manifest-path",
  "/Cargo.toml",
  "--offline",
];

const result = await new Promise<{ ok: boolean; output: string; error?: string }>(
  (resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, output: "", error: "metadata worker timed out" });
    }, timeoutMs + 60_000);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: event.message });
    };
    worker.postMessage({
      wasiRef: farm.get_ref(),
      commands: [command],
      threads: 2,
      timeoutMs,
      installStartupSysroots: true,
      env: [
        "RUSTUP_AUTO_INSTALL=0",
        "RUSTUP_TOOLCHAIN=/sysroot",
        "__CARGO_TEST_CHANNEL_OVERRIDE_DO_NOT_USE_THIS=nightly",
      ],
    });
  },
);
worker.terminate();
const combinedOutput = result.output + farmTerminalOutput + farmTerminalDecoder.decode();

console.log(combinedOutput);
if (!result.ok) {
  throw new Error(result.error ?? "metadata debug worker failed");
}
if (maxChunk !== 8192) {
  throw new Error(`startup sysroots were not streamed in 8192-byte chunks: ${maxChunk}`);
}
if (/\berror:/i.test(combinedOutput) || /failed to/i.test(combinedOutput)) {
  throw new Error(`embedded cargo metadata failed:\n${combinedOutput}`);
}
if (!combinedOutput.includes('"packages"')) {
  throw new Error(`cargo metadata did not emit metadata JSON:\n${combinedOutput}`);
}
