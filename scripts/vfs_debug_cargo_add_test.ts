import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import {
  createHttpBridge,
  isHttpBridgeMessage,
} from "../lib/src/http_bridge.ts";
import { buildPreopenDirectory } from "./build_preopen.ts";
import { prepareCachedSysroot } from "./sysroot_cache.ts";
import { computeWorkerWatchdogMs } from "./vfs_debug_config.ts";
import {
  createChildProcessBridge,
  isChildProcessMessage,
} from "../lib/src/child_process_bridge.ts";

const timeoutMs = 120000;
const commands = Deno.args.length === 0
  ? [
    ["cargo", "add", "hello"],
    ["cargo", "build", "-j", "1"],
  ]
  : [["cargo", ...Deno.args]];
const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs: commands.length,
  perRunMultiplier: 1,
  graceMs: 60000,
});

const fetchedUrls: string[] = [];
const countingFetch: typeof fetch = (input, init) => {
  fetchedUrls.push(input instanceof Request ? input.url : input.toString());
  return fetch(input, init);
};
const httpBridge = createHttpBridge(countingFetch);
const testDir = "./test_workspace_cargo_add";
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
      if (isHttpBridgeMessage(message)) return httpBridge(message);
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

const returnIndex = result.output.lastIndexOf("[vfs-debug] command:return");
if (returnIndex === -1) {
  console.error("final cargo command did not return");
  Deno.exit(1);
}
if (result.output.indexOf(" $ ", returnIndex) === -1) {
  console.error("shell prompt did not return after the final cargo command");
  Deno.exit(1);
}
if (
  Deno.args.length === 0 &&
  !/Adding hello v\S+ to dependencies/.test(result.output)
) {
  console.error("cargo add did not report adding hello");
  Deno.exit(1);
}
if (result.output.includes("error:")) {
  console.error("Cargo command reported an error");
  Deno.exit(1);
}
if (Deno.args.length === 0) {
  if (
    !/\[vfs-debug\] wasi-ext-spawn:virtual-cwd \/\.cargo\/registry\/src\/index\.crates\.io-[^/\s]+\/hello-1\.0\.4/
      .test(
        result.output,
      )
  ) {
    console.error("rustc did not receive the hello registry source cwd");
    Deno.exit(1);
  }
  if (!/Compiling hello v1\.0\.4/.test(result.output)) {
    console.error("Cargo did not compile hello v1.0.4");
    Deno.exit(1);
  }
  if (!result.output.includes("Finished `dev` profile")) {
    console.error("Cargo did not report a successful dev build");
    Deno.exit(1);
  }
  if (
    result.output.includes("failed to set cwd") ||
    result.output.includes("failed to set virtual cwd")
  ) {
    console.error("registry build failed to apply its virtual cwd");
    Deno.exit(1);
  }
  for (
    const marker of [
      "[vfs-debug-driver] run:1/2:return cargo add hello",
      "[vfs-debug-driver] run:2/2:return cargo build -j 1",
    ]
  ) {
    if (!result.output.includes(marker)) {
      console.error(`missing retained-session marker: ${marker}`);
      Deno.exit(1);
    }
  }
}
