import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { parseTar } from "../lib/src/parse_tar.ts";
import type { SysrootArchiveEntry } from "../page/src/sysroot_archive.ts";
import { buildPreopenDirectory } from "./build_preopen.ts";
import { prepareCachedArchive, prepareCachedSysroot } from "./sysroot_cache.ts";

const testDir = "./test_workspace_lsp_diagnostics";
await Deno.remove(testDir, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await prepareCachedSysroot({ workspaceSysroot: `${testDir}/sysroot` });

const rustSrcCacheArchive = ".rubrc-cache/sysroot/rust-src.tar.br";
const cachedRustSrcIsValid = await Deno.stat(rustSrcCacheArchive)
  .then((stat) => stat.size > 1024)
  .catch((error) => {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  });
if (!cachedRustSrcIsValid) {
  const rustc = await new Deno.Command("rustc", {
    args: ["--print", "sysroot"],
  }).output();
  if (!rustc.success) {
    throw new Error(new TextDecoder().decode(rustc.stderr));
  }
  const sysroot = new TextDecoder().decode(rustc.stdout).trim();
  const rustSrcLibrary = `${sysroot}/lib/rustlib/src/rust/library`;
  await Deno.mkdir(".rubrc-cache/sysroot", { recursive: true });
  const temporaryArchive = `${rustSrcCacheArchive}.tmp`;
  const tar = await new Deno.Command("tar", {
    args: [
      "--create",
      "--file",
      "-",
      "--directory",
      rustSrcLibrary,
      ".",
    ],
  }).output();
  if (!tar.success) {
    throw new Error(new TextDecoder().decode(tar.stderr));
  }
  const tarBuffer = new ArrayBuffer(tar.stdout.byteLength);
  new Uint8Array(tarBuffer).set(tar.stdout);
  const compressed = await new Response(
    new Blob([tarBuffer]).stream().pipeThrough(
      new CompressionStream("brotli"),
    ),
  ).bytes();
  await Deno.writeFile(temporaryArchive, compressed);
  await Deno.rename(temporaryArchive, rustSrcCacheArchive);
}
const { archive: rustSrcArchive } = await prepareCachedArchive({
  triple: "rust-src",
});
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
let sysrootQueue: SysrootArchiveEntry[] = [];
let currentSysrootFile: SysrootArchiveEntry | null = null;
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
        const args =
          (message as { args?: { session_id?: number; data?: number[] } }).args;
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
          const stream = new Blob([archive]).stream().pipeThrough(
            new DecompressionStream("brotli"),
          );
          const entries: Readonly<SysrootArchiveEntry>[] = [];
          await parseTar(stream, (file) => {
            if (
              file.name !== "./core" &&
              file.name !== "./core/src" &&
              file.name !== "./core/src/lib.rs"
            ) {
              return;
            }
            entries.push(Object.freeze({
              name: new TextEncoder().encode(file.name),
              data: file.data?.slice() ?? new Uint8Array(),
              isDirectory: file.type === "directory",
            }));
          });
          rustSrcTemplates = Object.freeze(entries);
        }
        sysrootQueue = rustSrcTemplates.map((entry) => ({
          name: entry.name.slice(),
          data: entry.data.slice(),
          isDirectory: entry.isDirectory,
        }));
        currentSysrootFile = null;
        return {};
      }
      if (name === "sysrootGetNextFileMeta") {
        if (sysrootQueue.length > 0) {
          currentSysrootFile = sysrootQueue.shift()!;
          return {
            has_file: true,
            name_len: currentSysrootFile.name.length,
            data_len: currentSysrootFile.isDirectory
              ? -1
              : currentSysrootFile.data.length,
          };
        }
        currentSysrootFile = null;
        return { has_file: false, name_len: 0, data_len: 0 };
      }
      if (name === "sysrootReadFileName") {
        if (currentSysrootFile?.name) {
          return { name: Array.from(currentSysrootFile.name) };
        }
        throw new Error("No current sysroot file to read name from");
      }
      if (name === "sysrootReadFileChunk") {
        if (currentSysrootFile) {
          const chunkLength = unknown.args?.chunk_len ?? 0;
          const chunk = currentSysrootFile.data.slice(0, chunkLength);
          currentSysrootFile.data = currentSysrootFile.data.slice(chunkLength);
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
      detail: "diagnostics worker timed out after 120 seconds",
    });
  }, 120_000);
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
if (!result.ok) Deno.exit(1);
