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
  createChildProcessWasiSession,
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
const stdout = ConsoleStdout.lineBuffered((message) =>
  console.log(`[WASI stdout] ${message}`)
);
const stderr = ConsoleStdout.lineBuffered((message) =>
  console.error(`[WASI stderr] ${message}`)
);
let childOutput = "";
const childStdout = ConsoleStdout.lineBuffered((message) => {
  childOutput += `${message}\n`;
  console.log(`[child stdout] ${message}`);
});
const childStderr = ConsoleStdout.lineBuffered((message) => {
  childOutput += `${message}\n`;
  console.error(`[child stderr] ${message}`);
});
const childBridge = createChildProcessBridge({
  createWasiSession: () =>
    createChildProcessWasiSession(
      stdin,
      childStdout,
      childStderr,
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
      ["cargo", "run", "--", "first", "second"],
      ["cat", "/created.txt"],
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
result.output += childOutput;
console.log(result.output);
if (!result.ok) {
  console.error(`VFS debug failed: ${result.error ?? "command timed out"}`);
  Deno.exit(1);
}

for (
  const expected of [
    "arguments: first,second",
    "input: input from parent",
    "created by child",
    "[vfs-debug] command:return",
  ]
) {
  if (!result.output.includes(expected)) {
    console.error(
      `cargo run output did not include ${JSON.stringify(expected)}`,
    );
    Deno.exit(1);
  }
}

const returnIndex = result.output.lastIndexOf("[vfs-debug] command:return");
if (returnIndex === -1 || result.output.indexOf(" $ ", returnIndex) === -1) {
  console.error("shell prompt did not return after cargo run test commands");
  Deno.exit(1);
}
