import {
  ConsoleStdout,
  Directory,
  File,
  type Inode,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import {
  createChildProcessBridge,
  isChildProcessMessage,
} from "../lib/src/child_process_bridge.ts";
import { computeWorkerWatchdogMs } from "./vfs_debug_config.ts";
import { prepareCachedSysroot } from "./sysroot_cache.ts";

const timeoutMs = 120000;
const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs: 2,
  perRunMultiplier: 1,
  graceMs: 60000,
});
const testDir = "./test_workspace_cargo_run";
await Deno.remove(testDir, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await prepareCachedSysroot({ workspaceSysroot: `${testDir}/sysroot` });

const loadDirectory = async (path: string): Promise<Map<string, Inode>> => {
  const contents = new Map<string, Inode>();
  for await (const entry of Deno.readDir(path)) {
    const entryPath = `${path}/${entry.name}`;
    if (entry.isDirectory) {
      contents.set(entry.name, new Directory(await loadDirectory(entryPath)));
    } else if (entry.isFile) {
      contents.set(entry.name, new File(await Deno.readFile(entryPath)));
    }
  }
  return contents;
};
const filesystemRoot = new Directory(await loadDirectory(testDir));
const preopen = new PreopenDirectory("/", filesystemRoot.contents);
await Deno.remove(testDir, { recursive: true });
let farm: WASIFarm;
const stdin = new OpenFile(new File([]));
let farmOutput = "";
const stdout = ConsoleStdout.lineBuffered((message) => {
  farmOutput += `${message}\n`;
  console.log(`[WASI stdout] ${message}`);
});
const stderr = ConsoleStdout.lineBuffered((message) => {
  farmOutput += `${message}\n`;
  console.error(`[WASI stderr] ${message}`);
});
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
    commands: [
      ["cargo", "run", "--", "first", "$", "second"],
      ["cargo", "run", "--", "exit7"],
    ],
    threads: 2,
    timeoutMs,
    preloads: [
      {
        path: "Cargo.toml",
        content:
          `[package]\nname = "cargo-run-test"\nversion = "0.1.0"\nedition = "2021"\n`,
      },
      {
        path: "src/main.rs",
        content: `use std::{env, fs};

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args == ["exit7"] {
        std::process::exit(7);
    }
    let input = fs::read_to_string("/input.txt").unwrap();
    println!("arguments: {}", args.join(","));
    println!("input: {input}");
    fs::write("/created.txt", "created by child").unwrap();
}
`,
      },
      { path: "input.txt", content: "input from parent" },
      { path: ".cargo/config.toml", content: `[env]\nCARGO = "cargo"\n` },
    ],
  });
});

worker.terminate();
result.output += farmOutput;
console.log(result.output);
if (!result.ok) {
  console.error(`VFS debug failed: ${result.error ?? "command timed out"}`);
  Deno.exit(1);
}

for (
  const expected of [
    "arguments: first,$,second",
    "input: input from parent",
    "[vfs-debug] command:return",
    "[vfs-debug] wasi-ext-spawn:return status=7",
  ]
) {
  if (!result.output.includes(expected)) {
    console.error(
      `cargo run output did not include ${JSON.stringify(expected)}`,
    );
    Deno.exit(1);
  }
}

const created = filesystemRoot.contents.get("created.txt");
if (
  !(created instanceof File) ||
  new TextDecoder().decode(created.data) !== "created by child"
) {
  console.error("cargo run child filesystem change was not preserved");
  Deno.exit(1);
}

const commandReturn = "[vfs-debug] command:return";
for (let run = 1; run <= 2; run++) {
  const runStart = result.output.indexOf(
    `[vfs-debug-driver] run:${run}/2:enter`,
  );
  const runEnd = result.output.indexOf(
    `[vfs-debug-driver] run:${run}/2:return`,
    runStart,
  );
  const returnIndex = result.output.indexOf(commandReturn, runStart);
  const promptIndex = result.output.indexOf(
    " $ ",
    returnIndex + commandReturn.length,
  );
  if (
    runStart === -1 || runEnd === -1 || returnIndex === -1 ||
    promptIndex === -1 || returnIndex > runEnd || promptIndex > runEnd
  ) {
    console.error(`run ${run} did not return to a later shell prompt`);
    Deno.exit(1);
  }
}
