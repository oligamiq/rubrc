import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";

const command = Deno.args.length === 0 ? ["rustc"] : Deno.args;
const timeoutMs = Number(Deno.env.get("VFS_DEBUG_TIMEOUT_MS") ?? "15000");
const threads = Number(Deno.env.get("VFS_DEBUG_THREADS") ?? "2");

const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) =>
    console.log(`[WASI stdout] ${message}`)
  ),
  ConsoleStdout.lineBuffered((message) =>
    console.error(`[WASI stderr] ${message}`)
  ),
  [],
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
        error: `debug worker did not respond within ${timeoutMs}ms`,
      });
    }, timeoutMs + 60000);

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
      command,
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
