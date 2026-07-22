import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { parseTar } from "../lib/src/parse_tar.ts";
import {
  type SysrootArchiveEntry,
  validateSysrootArchiveEntryName,
} from "../page/src/sysroot_archive.ts";
import { buildPreopenDirectory } from "./build_preopen.ts";
import { prepareCachedSysroot } from "./sysroot_cache.ts";
import { prepareInstalledRustSrcArchive } from "./rust_src_archive.ts";

const testDir = "./test_workspace_lsp_diagnostics";
await Deno.remove(testDir, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await prepareCachedSysroot({ workspaceSysroot: `${testDir}/sysroot` });

const { archive: rustSrcArchive, source: rustSrcSource } =
  await prepareInstalledRustSrcArchive();
console.log(
  `${rustSrcSource === "cache" ? "reused" : "generated"} validated rust-src cache`,
);
await Deno.mkdir(`${testDir}/src`, { recursive: true });
await Deno.writeTextFile(
  `${testDir}/Cargo.toml`,
  `[package]\nname = "lsp-diagnostics"\nversion = "0.1.0"\nedition = "2021"\n`,
);
await Deno.writeTextFile(`${testDir}/src/main.rs`, "fn main() {}\n");
await Deno.writeTextFile(
  `${testDir}/rust-project.json`,
  JSON.stringify({
    sysroot: "/sysroot",
    sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
    crates: [{ root_module: "/src/main.rs", edition: "2021", deps: [] }],
  }),
);
const preopen = await (async () => {
  try {
    return await buildPreopenDirectory("/", testDir);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
})();
const lspOutput = new MessageChannel();
let rustSrcTemplates: readonly Readonly<SysrootArchiveEntry>[] | undefined;
type QueuedSysrootEntry = {
  entry: Readonly<SysrootArchiveEntry>;
  offset: number;
};
let sysrootQueue: QueuedSysrootEntry[] = [];
let currentSysrootFile: QueuedSysrootEntry | null = null;
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
        if (unknown.args?.triple !== "rust-src") {
          sysrootQueue = [];
          currentSysrootFile = null;
          return {};
        }
        if (!rustSrcTemplates) {
          const archive = new ArrayBuffer(rustSrcArchive.byteLength);
          new Uint8Array(archive).set(rustSrcArchive);
          const stream = new Blob([archive])
            .stream()
            .pipeThrough(new DecompressionStream("brotli"));
          const entries: Readonly<SysrootArchiveEntry>[] = [];
          await parseTar(stream, (file) => {
            const name = validateSysrootArchiveEntryName(file.name);
            if (name === null) return;
            entries.push(
              Object.freeze({
                name: new TextEncoder().encode(name),
                data: file.data?.slice() ?? new Uint8Array(),
                isDirectory: file.type === "directory",
              }),
            );
          });
          rustSrcTemplates = Object.freeze(entries);
        }
        sysrootQueue = rustSrcTemplates.map((entry) => ({ entry, offset: 0 }));
        currentSysrootFile = null;
        return {};
      }
      if (name === "sysrootGetNextFileMeta") {
        if (sysrootQueue.length > 0) {
          currentSysrootFile = sysrootQueue.shift()!;
          return {
            has_file: true,
            name_len: currentSysrootFile.entry.name.length,
            data_len: currentSysrootFile.entry.isDirectory
              ? -1
              : currentSysrootFile.entry.data.length,
          };
        }
        currentSysrootFile = null;
        return { has_file: false, name_len: 0, data_len: 0 };
      }
      if (name === "sysrootReadFileName") {
        if (currentSysrootFile?.entry.name) {
          return { name: Array.from(currentSysrootFile.entry.name) };
        }
        throw new Error("No current sysroot file to read name from");
      }
      if (name === "sysrootReadFileChunk") {
        if (currentSysrootFile) {
          const chunkLength = unknown.args?.chunk_len ?? 0;
          const start = currentSysrootFile.offset;
          const chunk = currentSysrootFile.entry.data.slice(
            start,
            start + chunkLength,
          );
          currentSysrootFile.offset += chunk.length;
          return { chunk: Array.from(chunk) };
        }
        return { chunk: [] };
      }
      throw new Error(`unexpected callback: ${name ?? "unknown"}`);
    },
  },
);
const worker = new Worker(
  new URL("./vfs_lsp_diagnostics_worker.ts", import.meta.url),
  { type: "module" },
);
const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
  const timer = setTimeout(() => {
    worker.terminate();
    resolve({
      ok: false,
      detail: "diagnostics worker timed out after 360 seconds",
    });
  }, 360_000);
  worker.onmessage = (event) => {
    clearTimeout(timer);
    resolve(event.data);
  };
  worker.onerror = (event) => {
    clearTimeout(timer);
    resolve({ ok: false, detail: event.message });
  };
  worker.postMessage(
    { wasiRef: farm.get_ref(), lspOutputPort: lspOutput.port2 },
    [lspOutput.port2],
  );
});
worker.terminate();
lspOutput.port1.close();
console.log(result.detail);
console.log(`served ${rustSrcTemplates?.length ?? 0} rust-src archive entries`);
if (!result.ok) Deno.exit(1);
