import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import {
  createHttpBridge,
  isHttpBridgeMessage,
} from "../lib/src/http_bridge.ts";
import {
  buildRepeatedCommands,
  computeWorkerWatchdogMs,
  parsePositiveInt,
} from "./vfs_debug_config.ts";

const command = Deno.args.length === 0 ? ["rustc"] : Deno.args;
const timeoutMs = parsePositiveInt(
  Deno.env.get("VFS_DEBUG_TIMEOUT_MS"),
  15000,
  "VFS_DEBUG_TIMEOUT_MS",
);
const threads = parsePositiveInt(
  Deno.env.get("VFS_DEBUG_THREADS"),
  2,
  "VFS_DEBUG_THREADS",
);
const runs = parsePositiveInt(
  Deno.env.get("VFS_DEBUG_RUNS"),
  1,
  "VFS_DEBUG_RUNS",
);
const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs,
  perRunMultiplier: 1,
  graceMs: 60000,
});
const httpBridge = createHttpBridge();

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
      if (!isHttpBridgeMessage(message)) {
        throw new Error("unexpected non-HTTP farm callback");
      }
      return httpBridge(message);
    },
  },
);

const worker = new Worker(
  new URL("./vfs_debug_shell_worker.ts", import.meta.url),
  { type: "module" },
);

const result = await new Promise<
  { ok: boolean; output: string; error?: string }
>(
  (resolve) => {
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
      commands: buildRepeatedCommands(command, runs),
      threads,
      timeoutMs,
    });
  },
);

worker.terminate();
console.log(result.output);
if (!result.ok) {
  console.error(`VFS debug failed: ${result.error ?? "command timed out"}`);
  Deno.exit(1);
}
