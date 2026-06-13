import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { buildPreopenDirectory } from "./build_preopen.ts";

const command = ["rustc", "/src/main.rs", "--sysroot", "/sysroot", "--target", "wasm32-wasip1", "-Clinker-flavor=wasm-ld", "-Clinker=wasm-ld"];
const timeoutMs = 60000;
const threads = 2;

// Prepare the directory structure
const testDir = "./test_workspace_rustc";
const preopen = await buildPreopenDirectory(".", testDir);

const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) => console.log(`[WASI stdout] ${message}`)),
  ConsoleStdout.lineBuffered((message) => console.error(`[WASI stderr] ${message}`)),
  [
    preopen
  ],
  {
    allocator_size: 100 * 1024 * 1024
  }
);

const worker = new Worker(
  new URL("./test_rustc_inspect_worker.ts", import.meta.url),
  { type: "module" },
);

const sourceCode = Deno.readTextFileSync("./test_debug.rs");

const result = await new Promise<{ ok: boolean; output: string; error?: string }>((resolve) => {
  const timer = setTimeout(() => {
    worker.terminate();
    resolve({ ok: false, output: "", error: `debug worker did not respond within ${timeoutMs}ms` });
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
    sourceCode,
  });
});

worker.terminate();
console.log(result.output);
if (!result.ok) {
  console.error(`VFS test failed: ${result.error ?? "command timed out"}`);
  Deno.exit(1);
} else {
  console.log("VFS test succeeded!");
}
