import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { buildPreopenDirectory } from "./build_preopen.ts";
import {
  buildRepeatedCommands,
  computeWorkerWatchdogMs,
  parsePositiveInt,
} from "./vfs_debug_config.ts";

const command = [
  "rustc",
  "/src/main.rs",
  "--sysroot",
  "/sysroot",
  "--target",
  "wasm32-wasip1",
  "-Clinker-flavor=wasm-ld",
  "-Clinker=wasm-ld",
];
const timeoutMs = parsePositiveInt(
  Deno.env.get("VFS_DEBUG_TIMEOUT_MS"),
  60000,
  "VFS_DEBUG_TIMEOUT_MS",
);
const threads = parsePositiveInt(
  Deno.env.get("VFS_DEBUG_THREADS"),
  2,
  "VFS_DEBUG_THREADS",
);
const runs = parsePositiveInt(
  Deno.env.get("VFS_DEBUG_RUNS"),
  2,
  "VFS_DEBUG_RUNS",
);
const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs,
  perRunMultiplier: 2,
  graceMs: 60000,
});

// Prepare the directory structure
const testDir = "./test_workspace_rustc";

try {
  Deno.statSync(`${testDir}/sysroot/lib/rustlib/wasm32-wasip1/lib`);
} catch (e) {
  if (e instanceof Deno.errors.NotFound) {
    console.log(
      "wasm32-wasip1 sysroot not found in test_workspace_rustc. Copying from local rustc installation...",
    );
    const sysrootOutput = new Deno.Command("rustc", {
      args: ["--print", "sysroot"],
    }).outputSync();
    if (!sysrootOutput.success) {
      console.error(
        "Failed to run rustc --print sysroot. Make sure rustc is in PATH.",
      );
      Deno.exit(1);
    }
    const localSysroot = new TextDecoder().decode(sysrootOutput.stdout).trim();
    const sourceLibPath = `${localSysroot}/lib/rustlib/wasm32-wasip1/lib`;
    const destLibPath = `${testDir}/sysroot/lib/rustlib/wasm32-wasip1`;

    Deno.mkdirSync(destLibPath, { recursive: true });
    const cpCommand = new Deno.Command("cp", {
      args: ["-R", sourceLibPath, destLibPath],
    });
    const cpResult = cpCommand.outputSync();
    if (!cpResult.success) {
      console.error(
        "Failed to copy sysroot. Make sure the wasm32-wasip1 target is installed (rustup target add wasm32-wasip1).",
      );
      Deno.exit(1);
    }
    console.log("Sysroot copied successfully.");
  } else {
    throw e;
  }
}

const preopen = await buildPreopenDirectory(".", testDir);

const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) =>
    console.log(`[WASI stdout] ${message}`)
  ),
  ConsoleStdout.lineBuffered((message) =>
    console.error(`[WASI stderr] ${message}`)
  ),
  [
    preopen,
  ],
  {
    allocator_size: 100 * 1024 * 1024,
  },
);

const worker = new Worker(
  new URL("./test_rustc_inspect_worker.ts", import.meta.url),
  { type: "module" },
);

const sourceCode = Deno.readTextFileSync("./test_debug.rs");

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
    commands: buildRepeatedCommands(command, runs),
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
