import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import {
  createHttpBridge,
  isHttpBridgeMessage,
} from "../lib/src/http_bridge.ts";
import { computeWorkerWatchdogMs } from "./vfs_debug_config.ts";

const timeoutMs = 120000;
const cargoArgs = Deno.args.length === 0 ? ["add", "hello"] : Deno.args;
const commands = Deno.args.length === 0
  ? [
    ["cargo", ...cargoArgs],
    ["cargo", "metadata", "--no-deps", "--format-version", "1"],
  ]
  : [["cargo", ...cargoArgs]];
const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs: 1,
  perRunMultiplier: 1,
  graceMs: 60000,
});

const fetchedUrls: string[] = [];
const countingFetch: typeof fetch = (input, init) => {
  fetchedUrls.push(input instanceof Request ? input.url : input.toString());
  return fetch(input, init);
};
const httpBridge = createHttpBridge(countingFetch);

const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) =>
    console.log(`[WASI stdout] ${message}`)
  ),
  ConsoleStdout.lineBuffered((message) =>
    console.error(`[WASI stderr] ${message}`)
  ),
  [],
  {
    unknown_fn: (message: unknown) => {
      if (isHttpBridgeMessage(message)) return httpBridge(message);
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
    commands,
    threads: 2,
    timeoutMs,
    preloads: [
      {
        path: "Cargo.toml",
        content:
          `[package]\nname = "cargo-add-test"\nversion = "0.1.0"\nedition = "2021"\n`,
      },
      { path: "src/lib.rs", content: "pub fn test() {}\n" },
    ],
  });
});

worker.terminate();
console.log(result.output);
console.log(`[vfs-debug-test] fetched URLs: ${JSON.stringify(fetchedUrls)}`);
if (!result.ok) {
  console.error(`VFS debug failed: ${result.error ?? "command timed out"}`);
  Deno.exit(1);
}

if (!result.output.includes("[vfs-debug] command:return")) {
  console.error("cargo add did not return from the command");
  Deno.exit(1);
}
if (!/Adding hello v\S+ to dependencies/.test(result.output)) {
  console.error("cargo add did not report adding hello");
  Deno.exit(1);
}
if (result.output.includes("error:")) {
  console.error("cargo add reported an error");
  Deno.exit(1);
}
if (
  Deno.args.length === 0 &&
  !/"dependencies":\[\{"name":"hello",/.test(result.output)
) {
  console.error("Cargo.toml does not contain the hello dependency");
  Deno.exit(1);
}
