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
import { computeWorkerWatchdogMs } from "./vfs_debug_config.ts";
import {
  createChildProcessBridge,
  createChildProcessWasiSession,
  isChildProcessMessage,
} from "../lib/src/child_process_bridge.ts";

const timeoutMs = 120000;
const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs: 1,
  perRunMultiplier: 1,
  graceMs: 60000,
});

let fetchCount = 0;
const countingFetch: typeof fetch = (...args) => {
  fetchCount++;
  return fetch(...args);
};
const httpBridge = createHttpBridge(countingFetch);
const filesystemRoot = new Directory(new Map());
const preopen = new PreopenDirectory("/", filesystemRoot.contents);
let farm: WASIFarm;
const stdin = new OpenFile(new File([]));
const stdout = ConsoleStdout.lineBuffered((message) =>
  console.log(`[WASI stdout] ${message}`)
);
const stderr = ConsoleStdout.lineBuffered((message) =>
  console.error(`[WASI stderr] ${message}`)
);
const childBridge = createChildProcessBridge({
  createWasiSession: () =>
    createChildProcessWasiSession(
      stdin,
      stdout,
      stderr,
      [new PreopenDirectory("/", filesystemRoot.contents)],
    ),
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
    unknown_fn: (message: unknown) => {
      if (isHttpBridgeMessage(message)) {
        return httpBridge(message);
      }
      if (isChildProcessMessage(message)) return childBridge(message);
      const name = (message as { name?: string })?.name;
      if (name === "terminalWrite" || name === "sysrootStartFetch") {
        return {};
      }
      if (name === "sysrootGetNextFileMeta") {
        return { has_file: false, name_len: 0, data_len: 0 };
      }
      if (name === "sysrootReadFileName") {
        return { name: [] };
      }
      if (name === "sysrootReadFileChunk") {
        return { chunk: [] };
      }
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
    commands: [["cargo", "info", "dashmap"]],
    threads: 2,
    timeoutMs,
  });
});

worker.terminate();
console.log(result.output);
if (!result.ok) {
  console.error(`VFS debug failed: ${result.error ?? "command timed out"}`);
  Deno.exit(1);
}

if (fetchCount === 0) {
  console.error("cargo info completed without using the real HTTP bridge");
  Deno.exit(1);
}

const cargoErrorPatterns = [
  /error: failed to/i,
  /network failure/i,
  /could not resolve host/i,
  /timed out/i,
];
if (cargoErrorPatterns.some((pattern) => pattern.test(result.output))) {
  console.error("cargo info reported a Cargo or network error");
  Deno.exit(1);
}

if (
  !/^dashmap\b/im.test(result.output) ||
  !/^version:\s*\S+/im.test(result.output) ||
  !/^crates\.io:\s*https?:\/\//im.test(result.output)
) {
  console.error("cargo info did not report DashMap package metadata");
  Deno.exit(1);
}

const returnIndex = result.output.indexOf("[vfs-debug] command:return");
if (returnIndex === -1) {
  console.error("cargo info did not return from the command");
  Deno.exit(1);
}
if (result.output.indexOf(" $ ", returnIndex) === -1) {
  console.error("shell prompt did not return after cargo info");
  Deno.exit(1);
}

console.log(`[vfs-debug-test] real fetch count: ${fetchCount}`);
