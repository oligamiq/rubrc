import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { createRustAnalyzerProjectJson } from "../page/src/rust_lsp_config.ts";
import { takeExactSysrootChunk } from "../page/src/sysroot_protocol.ts";
import { buildPreopenDirectory } from "./build_preopen.ts";
import { prepareCachedArchive, prepareCachedSysroot } from "./sysroot_cache.ts";
import { prepareReleasedRustSrcSquashfs } from "./rust_src_archive.ts";

function assertAtLeastFourPairedHostCargoCalls(trace: string): void {
  const events = Array.from(
    trace.matchAll(
      /\[vfs-debug\] host-cargo:(request|response|reject) id=(\d+)(?: status=(-?\d+))?/g,
    ),
    (match) => ({ phase: match[1], id: Number(match[2]) }),
  );
  const requestIds = events
    .filter((event) => event.phase === "request")
    .map((event) => event.id);
  const uniqueRequestIds = new Set(requestIds);
  const outcomeIds = events
    .filter((event) => event.phase !== "request")
    .map((event) => event.id);
  if (requestIds.length < 4 || uniqueRequestIds.size !== requestIds.length) {
    throw new Error(
      `expected at least four distinct host-cargo requests, received ${
        requestIds.join(
          ",",
        )
      }`,
    );
  }
  if (
    outcomeIds.length !== requestIds.length ||
    outcomeIds.some((id) => !uniqueRequestIds.has(id))
  ) {
    throw new Error("host-cargo trace contains an orphan outcome");
  }
  for (const id of uniqueRequestIds) {
    const outcomes = events.filter(
      (event) => event.id === id && event.phase !== "request",
    );
    if (outcomes.length !== 1 || outcomes[0].phase !== "response") {
      throw new Error(`host-cargo id=${id} did not have one paired response`);
    }
  }
}

const focusedHostCargo = Deno.env.get("RUBRC_LSP_HOST_CARGO_FOCUSED") === "1";
const testDir = focusedHostCargo
  ? "/mnt/hdd/rubrc-test-workspace-lsp-diagnostics"
  : "./test_workspace_lsp_diagnostics";
await Deno.remove(testDir, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await prepareCachedSysroot({ workspaceSysroot: `${testDir}/sysroot` });

const { archive: rustSrcArchive, source: rustSrcSource } =
  await prepareReleasedRustSrcSquashfs();
console.log(
  `${
    rustSrcSource === "cache" ? "reused" : "downloaded"
  } validated rust-src cache`,
);
await Deno.mkdir(`${testDir}/src`, { recursive: true });
await Deno.writeTextFile(
  `${testDir}/Cargo.toml`,
  `[package]\nname = "lsp-diagnostics"\nversion = "0.1.0"\nedition = "2021"\n`,
);
await Deno.writeTextFile(`${testDir}/src/main.rs`, "fn main() {}\n");
await Deno.writeTextFile(
  `${testDir}/rust-project.json`,
  JSON.stringify(createRustAnalyzerProjectJson()),
);
const preopen = await (async () => {
  try {
    return await buildPreopenDirectory("/", testDir);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
})();
const lspOutput = new MessageChannel();
let rustSrcSquashfsCache: Uint8Array | undefined;
let wasm32TarCache: Uint8Array | undefined;
let currentSysrootArchive: Uint8Array | null = null;
let maxSysrootChunkLength = 0;
let maxHostArchiveReadLength = 0;

const { archive: wasm32ArchiveBytes } = await prepareCachedArchive({
  triple: "wasm32-wasip1",
});

const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) => console.log(`[stdout] ${message}`)),
  ConsoleStdout.lineBuffered((message) => console.error(`[stderr] ${message}`)),
  [preopen],
  {
    allocator_size: 100 * 1024 * 1024,
    async unknown_fn(message: unknown) {
      const unknown = message as {
        name?: string;
        args?: { triple?: string; chunk_len?: number };
      };
      const name = unknown.name;
      if (name?.startsWith("childProcess")) {
        return { request_id: 0, state: 0, status: 0, error_len: 0 };
      }
      if (name === "terminalWrite") {
        const args = (
          message as { args?: { session_id?: number; data?: number[] } }
        ).args;
        lspOutput.port1.postMessage(args);
        return {};
      }
      if (name === "sysrootStartFetch") {
        const triple = unknown.args?.triple;
        if (triple !== "rust-src" && triple !== "wasm32-wasip1") {
          currentSysrootArchive = null;
          return {};
        }

        if (triple === "wasm32-wasip1") {
          if (!wasm32TarCache) {
            const archive = new ArrayBuffer(wasm32ArchiveBytes.byteLength);
            new Uint8Array(archive).set(wasm32ArchiveBytes);
            const stream = new Blob([archive])
              .stream()
              .pipeThrough(new DecompressionStream("brotli"));
            const reader = stream.getReader();
            const chunks: Uint8Array[] = [];
            let totalLength = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              totalLength += value.byteLength;
            }
            const tarBytes = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
              tarBytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            wasm32TarCache = tarBytes;
          }
          currentSysrootArchive = new Uint8Array(wasm32TarCache);
          return {};
        }

        if (!rustSrcSquashfsCache) {
          rustSrcSquashfsCache = new Uint8Array(rustSrcArchive);
        }
        currentSysrootArchive = new Uint8Array(rustSrcSquashfsCache);
        return {};
      }
      if (name === "sysrootArchiveGetMeta") {
        if (currentSysrootArchive !== null) {
          return {
            has_archive: true,
            data_len: currentSysrootArchive.length,
          };
        }
        return { has_archive: false, data_len: 0 };
      }
      if (name === "sysrootReadArchiveChunk") {
        const requested = unknown.args?.chunk_len;
        if (typeof requested === "number") {
          maxSysrootChunkLength = Math.max(maxSysrootChunkLength, requested);
        }
        if (!currentSysrootArchive) {
          throw new Error("No current sysroot archive to read data from");
        }
        const { chunk, remaining } = takeExactSysrootChunk(
          currentSysrootArchive,
          requested,
        );
        maxHostArchiveReadLength = Math.max(
          maxHostArchiveReadLength,
          chunk.byteLength,
        );
        currentSysrootArchive = remaining.length === 0 ? null : remaining;
        return { chunk: Array.from(chunk) };
      }
      throw new Error(`unexpected callback: ${name ?? "unknown"}`);
    },
  },
);
const worker = new Worker(
  new URL("./vfs_lsp_diagnostics_worker.ts", import.meta.url),
  { type: "module" },
);
const result = await new Promise<{
  ok: boolean;
  detail: string;
  trace: string;
  traceDroppedChunks: number;
  cargoCallsBeforeInit?: number;
}>((resolve) => {
  const timer = setTimeout(() => {
    worker.terminate();
    resolve({
      ok: false,
      detail: "diagnostics worker timed out after 1200 seconds",
      trace: "",
      traceDroppedChunks: 0,
      cargoCallsBeforeInit: undefined,
    });
  }, 1_200_000);
  worker.onmessage = (event) => {
    clearTimeout(timer);
    resolve(event.data);
  };
  worker.onerror = (event) => {
    clearTimeout(timer);
    resolve({
      ok: false,
      detail: event.message,
      trace: "",
      traceDroppedChunks: 0,
    });
  };
  worker.postMessage(
    {
      wasiRef: farm.get_ref(),
      lspOutputPort: lspOutput.port2,
      stopAfterHostCargoOutcome: focusedHostCargo,
    },
    [lspOutput.port2],
  );
});
worker.terminate();
lspOutput.port1.close();
console.log(result.detail);
console.log(result.trace);
console.log(`trace dropped chunks: ${result.traceDroppedChunks}`);
if (!result.ok) throw new Error(result.detail);
if (
  !/memory:target=lsp_opt action=reserve current=64 minimum=8192 requested=8192 result=[1-9]\d*/
    .test(result.trace)
) {
  throw new Error("actual VFS artifact did not reserve 8192 LSP pages");
}
if (!result.trace.includes("lsp:_main:enter")) {
  throw new Error("actual VFS artifact did not enter rust-analyzer main");
}
const lspPageSamples = Array.from(
  result.trace.matchAll(/\blsp_pages=(\d+)/g),
  (match) => Number(match[1]),
);
if (lspPageSamples.length === 0) {
  throw new Error("actual VFS artifact did not report LSP logical pages");
}
const peakLspPages = Math.max(...lspPageSamples);
console.log(`peak LSP logical pages: ${peakLspPages}`);
if (peakLspPages >= 8192) {
  throw new Error(
    `LSP logical page peak ${peakLspPages} exhausted its reserve`,
  );
}
if (!focusedHostCargo) {
  assertAtLeastFourPairedHostCargoCalls(result.trace);
}
if (focusedHostCargo) {
  if (!result.detail.startsWith("host-cargo focused host outcome id=")) {
    throw new Error(
      `focused host-cargo run returned the wrong result: ${result.detail}`,
    );
  }
}
console.log(
  `served rust-src SquashFS: ${rustSrcSquashfsCache?.length ?? 0} bytes`,
);
console.log(`maximum sysroot chunk request: ${maxSysrootChunkLength}`);
console.log(`maximum host archive read: ${maxHostArchiveReadLength}`);
if (rustSrcSquashfsCache?.length !== rustSrcArchive.byteLength) {
  throw new Error(
    `expected raw ${rustSrcArchive.byteLength}-byte rust-src SquashFS, got ${
      rustSrcSquashfsCache?.length ?? 0
    }`,
  );
}
if (new TextDecoder().decode(rustSrcSquashfsCache.subarray(0, 4)) !== "hsqs") {
  throw new Error("rust-src transport was not a raw SquashFS image");
}
if (maxSysrootChunkLength !== 8192) {
  throw new Error(
    `expected maximum sysroot chunk request 8192, got ${maxSysrootChunkLength}`,
  );
}
if (
  maxHostArchiveReadLength <= 0 ||
  maxHostArchiveReadLength > 512 * 1024
) {
  throw new Error(
    `maximum host archive read ${maxHostArchiveReadLength} is outside 1..524288`,
  );
}
const retainedSysrootArchive = currentSysrootArchive as Uint8Array | null;
if (retainedSysrootArchive !== null) {
  throw new Error(
    `sysroot archive retained ${retainedSysrootArchive.length} unread bytes`,
  );
}
if (result.cargoCallsBeforeInit !== 0) {
  throw new Error(
    `expected zero Cargo/rustc calls before project activation, got ${result.cargoCallsBeforeInit}`,
  );
}
