import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { computeWorkerWatchdogMs } from "./vfs_debug_config.ts";

const timeoutMs = 120000;
const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs: 1,
  perRunMultiplier: 1,
  graceMs: 60000,
});

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
        content: `[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n`,
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

if (result.output.includes("failed to set cwd `/`")) {
  console.error("spawned rustc used host cwd handling instead of virtual process cwd");
  Deno.exit(1);
}

if (result.output.includes("incremental compilation")) {
  console.error("Cargo/rustc attempted incremental compilation on the virtual filesystem");
  Deno.exit(1);
}

if (result.output.includes("No such file or directory")) {
  console.error("spawned rustc did not use Cargo-provided virtual cwd");
  Deno.exit(1);
}

if (!result.output.includes("[vfs-debug] wasi-ext-spawn:run-rustc:enter")) {
  console.error("Cargo did not reach rustc spawn path");
  Deno.exit(1);
}
