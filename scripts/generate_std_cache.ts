// Execute the distributed analyzer inside the existing WASM/VFS runner. Native
// analyzer snapshots are deliberately not substituted for this artifact.
import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import {
  createHttpBridge,
  isHttpBridgeMessage,
} from "../lib/src/http_bridge.ts";
import {
  createChildProcessBridge,
  isChildProcessMessage,
} from "../lib/src/child_process_bridge.ts";
import { takeExactSysrootChunk } from "../page/src/sysroot_protocol.ts";
import { prepareReleasedRustSrcSquashfs } from "./rust_src_archive.ts";
import { prepareCachedArchive } from "./sysroot_cache.ts";
import { dirname } from "node:path";
import { createCacheTerminalCapture } from "./ci/cache_terminal_capture.mjs";

const outputPath = Deno.args[0] ?? "target/std.salsa";
const diagnosticCommand = Deno.env.get("STD_CACHE_DIAGNOSTIC_COMMAND");
if (diagnosticCommand !== undefined && diagnosticCommand !== "version") {
  throw new Error("unsupported STD_CACHE_DIAGNOSTIC_COMMAND");
}
const timeoutMs = Number(Deno.env.get("STD_CACHE_TIMEOUT_MS") ?? 15 * 60_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error("invalid STD_CACHE_TIMEOUT_MS");
}
const [rustSrc, target] = await Promise.all([
  prepareReleasedRustSrcSquashfs(),
  prepareCachedArchive({ triple: "wasm32-wasip1" }),
]);
const decompressed = await new Response(
  new Blob([Uint8Array.from(target.archive)]).stream().pipeThrough(
    new DecompressionStream("brotli"),
  ),
).arrayBuffer();
const http = createHttpBridge();
const terminalCapture = createCacheTerminalCapture();
let archive: Uint8Array | undefined;
let download: Uint8Array[] | undefined;
let resultBytes: Uint8Array | undefined;
const filesystemRoot = new Directory(new Map());
let farm: WASIFarm;
const childBridge = createChildProcessBridge({
  getWasiRef: () => farm.get_ref(),
  workerUrl: new URL(
    "../page/src/worker_process/vfs_bindings/child_process_worker.ts",
    import.meta.url,
  ),
  filesystemRoot,
  uploadTimeoutMs: 30_000,
  executionTimeoutMs: timeoutMs,
});
farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered(console.log),
  ConsoleStdout.lineBuffered(console.error),
  [new PreopenDirectory("/", filesystemRoot.contents)],
  {
    allocator_size: 100 * 1024 * 1024,
    unknown_fn(raw: unknown) {
      if (isHttpBridgeMessage(raw)) return http(raw);
      if (isChildProcessMessage(raw)) return childBridge(raw);
      const message = raw as {
        name?: string;
        args?: {
          triple?: string;
          chunk_len?: number;
          name?: string;
          data?: number[];
          session_id?: number;
        };
      };
      switch (message.name) {
        case "sysrootStartFetch":
          archive = message.args?.triple === "rust-src"
            ? Uint8Array.from(rustSrc.archive)
            : message.args?.triple === "wasm32-wasip1"
            ? new Uint8Array(decompressed)
            : undefined;
          return {};
        case "sysrootArchiveGetMeta":
          return {
            has_archive: archive !== undefined,
            data_len: archive?.length ?? 0,
          };
        case "sysrootReadArchiveChunk": {
          if (!archive || typeof message.args?.chunk_len !== "number") {
            throw new Error("invalid sysroot read");
          }
          const { chunk, remaining } = takeExactSysrootChunk(
            archive,
            message.args.chunk_len,
          );
          archive = remaining.length ? remaining : undefined;
          return { chunk: Array.from(chunk) };
        }
        case "downloadFileStart":
          if (download || resultBytes) {
            throw new Error("unexpected second cache download");
          }
          download = [];
          return {};
        case "downloadFileChunk":
          if (!download || !Array.isArray(message.args?.data)) {
            throw new Error("invalid cache chunk");
          }
          download.push(Uint8Array.from(message.args.data));
          return {};
        case "downloadFileEnd": {
          if (!download) throw new Error("cache download was not started");
          resultBytes = new Uint8Array(
            download.reduce((size, chunk) => size + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of download) {
            resultBytes.set(chunk, offset);
            offset += chunk.length;
          }
          download = undefined;
          return {};
        }
        case "terminalWrite":
          terminalCapture.push(message.args);
          return {};
        default:
          throw new Error(
            `unexpected cache-generation host call: ${message.name}`,
          );
      }
    },
  },
);
const worker = new Worker(
  new URL("./vfs_debug_shell_worker.ts", import.meta.url),
  { type: "module" },
);
try {
  const result = await new Promise<
    { ok: boolean; output: string; error?: string }
  >((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WASM cache generation timed out")),
      timeoutMs + 60_000,
    );
    worker.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message));
    };
    worker.postMessage({
      wasiRef: farm.get_ref(),
      threads: 8,
      timeoutMs,
      installStartupSysroots: true,
      preloads: [{
        path: "/rust-project.json",
        content: JSON.stringify({
          sysroot: "/sysroot",
          sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
          crates: [],
        }),
      }],
      commands: diagnosticCommand === "version" ? [["rust-analyzer", "--version"]] : [
        [
          "rust-analyzer",
          "generate-std-cache",
          "/rust-project.json",
          "/rust-analyzer-std.salsa",
          ...(Deno.env.get("STD_CACHE_BENCH") === "1"
            ? ["--benchmark-codecs"]
            : []),
        ],
        ["download", "/rust-analyzer-std.salsa"],
      ],
    });
  });
  console.log(result.output);
  if (diagnosticCommand === "version") {
    if (!result.ok) throw new Error(result.error ?? "WASM analyzer version probe failed");
    console.log("[std-cache-diagnostic] version command returned; no cache was generated");
  } else {
    if (!result.ok || !resultBytes?.length) {
      throw new Error(result.error ?? "WASM analyzer did not produce a cache");
    }
    await Deno.mkdir(dirname(outputPath), { recursive: true });
    await Deno.writeFile(outputPath, resultBytes);
    console.log(
      `Generated ${outputPath} (${resultBytes.length} bytes) using the bundled WASM analyzer`,
    );
  }
} finally {
  // Spawned guest workers send terminalWrite directly to the farm, bypassing
  // the driver's terminal callback. Preserve their bounded output on failures
  // as well as success, instead of silently discarding analyzer diagnostics.
  console.log("[std-cache-host-terminal]", JSON.stringify(terminalCapture.snapshot()));
  worker.terminate();
}
