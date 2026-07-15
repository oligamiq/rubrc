import {
  ConsoleStdout,
  File,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { buildPreopenDirectory } from "./build_preopen.ts";
import { prepareCachedSysroot } from "./sysroot_cache.ts";
import { computeWorkerWatchdogMs } from "./vfs_debug_config.ts";
import {
  createChildProcessBridge,
  isChildProcessMessage,
} from "../lib/src/child_process_bridge.ts";

const timeoutMs = 120000;
const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs: 1,
  perRunMultiplier: 1,
  graceMs: 60000,
});

const testDir = "./test_workspace_cargo_pipe";
await Deno.remove(testDir, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) {
    throw error;
  }
});
const sysroot = await prepareCachedSysroot({
  workspaceSysroot: `${testDir}/sysroot`,
});
console.log(
  `Prepared ${sysroot.expandedSysroot} from ${sysroot.source}: ${sysroot.cacheArchive}`,
);

const preopen = await (async () => {
  try {
    return await buildPreopenDirectory("/", testDir);
  } finally {
    await Deno.remove(testDir, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    });
  }
})();

const filesystemRoot = preopen.dir;
let farm: WASIFarm;
const stdin = new OpenFile(new File([]));
const stdout = ConsoleStdout.lineBuffered((message) =>
  console.log(`[WASI stdout] ${message}`)
);
const stderr = ConsoleStdout.lineBuffered((message) =>
  console.error(`[WASI stderr] ${message}`)
);
const childBridge = createChildProcessBridge({
  getWasiRef: () => farm.get_ref(),
  workerUrl: new URL(
    "../page/src/worker_process/vfs_bindings/child_process_worker.ts",
    import.meta.url,
  ),
  filesystemRoot,
  uploadTimeoutMs: 30000,
  executionTimeoutMs: timeoutMs,
});

farm = new WASIFarm(
  stdin,
  stdout,
  stderr,
  [preopen],
  {
    allocator_size: 100 * 1024 * 1024,
    unknown_fn: (message: unknown) => {
      if (isChildProcessMessage(message)) return childBridge(message);
      const name = (message as { name?: string })?.name;
      if (name === "terminalWrite" || name === "sysrootStartFetch") return {};
      if (name === "sysrootGetNextFileMeta") {
        return { has_file: false, name_len: 0, data_len: 0 };
      }
      if (name === "sysrootReadFileName") return { name: [] };
      if (name === "sysrootReadFileChunk") return { chunk: [] };
      throw new Error(`unexpected farm callback: ${name ?? "unknown"}`);
    },
  },
);

const worker = new Worker(
  new URL("./vfs_debug_shell_worker.ts", import.meta.url),
  { type: "module" },
);

const result = await new Promise<
  { ok: boolean; output: string; error?: string }
>((resolve) => {
  const timer = setTimeout(() => {
    worker.terminate();
    resolve({
      ok: false,
      output: "",
      error: `debug worker did not respond within ${workerWatchdogMs}ms`,
    });
  }, workerWatchdogMs);

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
    commands: [["cargo", "b", "-j", "1", "-p", "app"]],
    threads: 2,
    timeoutMs,
    preloads: [
      {
        path: "Cargo.toml",
        content: `[workspace]\nmembers = ["app"]\nresolver = "2"\n`,
      },
      {
        path: "app/Cargo.toml",
        content:
          `[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n`,
      },
      { path: "app/src/main.rs", content: "fn main() {}\n" },
      { path: ".cargo/config.toml", content: "" },
    ],
    // Invalid UTF-8 should never be visible to Cargo-spawned rustc stdin.
    lspInputBytes: [0xff, 0xfe, 0xfd, 0x0a],
  });
});

worker.terminate();
console.log(result.output);
if (!result.ok) {
  console.error(`VFS debug failed: ${result.error ?? "command timed out"}`);
  Deno.exit(1);
}

if (result.output.includes("couldn't read from stdin")) {
  console.error("spawned rustc read poisoned global/LSP stdin");
  Deno.exit(1);
}

if (result.output.includes("malformed output when learning about crate-type")) {
  console.error("Cargo failed to parse rustc probe output");
  Deno.exit(1);
}

if (result.output.includes("error[E0463]")) {
  console.error(
    "Cargo-spawned rustc could not find the wasm32-wasip1 standard library",
  );
  Deno.exit(1);
}

if (result.output.includes("failed to set cwd `/`")) {
  console.error(
    "spawned rustc used host cwd handling instead of virtual process cwd",
  );
  Deno.exit(1);
}

if (result.output.includes("incremental compilation")) {
  console.error(
    "Cargo/rustc attempted incremental compilation on the virtual filesystem",
  );
  Deno.exit(1);
}

if (result.output.includes("No such file or directory")) {
  console.error("spawned rustc did not use Cargo-provided virtual cwd");
  Deno.exit(1);
}

const rustcRuns = result.output.match(
  /\[vfs-debug\] wasi-ext-spawn:run-rustc:enter/g,
)?.length ?? 0;
if (rustcRuns < 3) {
  console.error(
    `Cargo reached ${rustcRuns} rustc runs; compile spawn was not reached`,
  );
  Deno.exit(1);
}

if (!result.output.includes("Finished `dev` profile")) {
  console.error("Cargo did not report a successful dev build");
  Deno.exit(1);
}

const returnIndex = result.output.lastIndexOf("[vfs-debug] command:return");
if (returnIndex === -1 || result.output.indexOf(" $ ", returnIndex) === -1) {
  console.error("shell prompt did not return after cargo build");
  Deno.exit(1);
}
