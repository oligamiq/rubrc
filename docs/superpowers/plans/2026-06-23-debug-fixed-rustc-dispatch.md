# Debug Fixed Rustc Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a diagnostic `dispatch` event (1007) that invokes `rustc_opt` directly with fixed compile arguments, bypassing WebShell session/command parsing, and a no-shell harness to run it twice and compare with the existing shell-based hang.

**Architecture:** A new `EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007` branch in `crates/vfs/src/lib.rs` `dispatch()` sets fixed args and calls `_reset()` + `_main()` on the reused `rustc_opt` instance. A new Deno worker harness writes `/src/main.rs` via event 7, then dispatches event 1007 twice, waiting for debug markers or timeout.

**Tech Stack:** Rust (wasm32-wasip1-threads via wasi_virt_layer), Deno (TypeScript), browser_wasi_shim-threads WASIFarm.

## Global Constraints

- Do not create a fresh `rustc_opt` instance per command — reuse the existing one.
- Do not use the WebShell command path for this diagnostic.
- Do not call `dispatch(sessionId, 3, 0, 0)` (no shell session open) or send interactive character input events.
- Event number must be offset from normal user-facing dispatch events (0–7).
- Treat this as diagnosis, not a production fix.
- Do not introduce new `Atomics` or `SharedArrayBuffer` use.
- Do not rework `run_rustc()` or cargo spawn behavior.
- Do not clean unrelated temporary debug prints or untracked files.
- `bun run vfs:build` regenerates `page/src/worker_process/vfs_bindings/` — changes to `inst.ts` require a `wip` commit per GEMINI.md, but `vfs:build` runs `git restore inst.ts` so `inst.ts` won't change.

---

### Task 1: Add EVENT_TYPE_DEBUG_FIXED_RUSTC dispatch branch

**Files:**
- Modify: `crates/vfs/src/lib.rs:16` (add constant after `EVENT_TYPE_WRITE_FILE`)
- Modify: `crates/vfs/src/lib.rs:299` (add new `else if` branch before `vfs_shell_dispatch` fallback)

**Interfaces:**
- Consumes: `crate::command::set_rustc_opt_args(&[impl AsRef<str>])` from `command.rs:24`, `MEMORY_MANAGER.ensure::<T>(config)` from `memory_manager.rs`, `crate::debug_trace(&str)` from `lib.rs:86`, `RUSTC_CONFIG` and `LLVM_CONFIG` from `memory_manager.rs`, `rustc_opt::_reset()` / `rustc_opt::_main()` from `import_wasm!` macro.
- Produces: `EVENT_TYPE_DEBUG_FIXED_RUSTC: u32 = 1007` constant, dispatch branch that handles event 1007 and returns before shell fallback.

- [ ] **Step 1: Add the constant**

In `crates/vfs/src/lib.rs`, after line 16 (`const EVENT_TYPE_WRITE_FILE: u32 = 7;`), add:

```rust
const EVENT_TYPE_DEBUG_FIXED_RUSTC: u32 = 1007;
```

- [ ] **Step 2: Add the dispatch branch**

In `crates/vfs/src/lib.rs`, in the `dispatch` method, after the `EVENT_TYPE_WRITE_FILE` block closes with `return;` (line 298) and before the `unsafe { crate::shell::vfs_shell_dispatch(...)` fallback (line 300), insert:

```rust
        } else if event_type == EVENT_TYPE_DEBUG_FIXED_RUSTC {
            let run_marker = arg1;
            crate::debug_trace(&format!("debug-rustc:enter run={run_marker}"));
            MEMORY_MANAGER.ensure::<rustc_opt>(RUSTC_CONFIG);
            MEMORY_MANAGER.ensure::<llvm_opt>(LLVM_CONFIG);
            let fixed_args: &[&str] = &[
                "rustc",
                "/src/main.rs",
                "--sysroot",
                "/sysroot",
                "--target",
                "wasm32-wasip1",
                "-Clinker-flavor=wasm-ld",
                "-Clinker=wasm-ld",
            ];
            crate::command::set_rustc_opt_args(fixed_args);
            crate::debug_trace("debug-rustc:_reset:enter");
            crate::rustc_opt::_reset();
            crate::debug_trace("debug-rustc:_reset:return");
            crate::debug_trace("debug-rustc:_main:enter");
            crate::rustc_opt::_main();
            crate::debug_trace("debug-rustc:_main:return");
            crate::debug_trace(&format!("debug-rustc:return run={run_marker}"));
            return;
```

The full `dispatch` if-else chain should read: `event_type == 1` → `EVENT_TYPE_LSP` → `EVENT_TYPE_WRITE_FILE` → `EVENT_TYPE_DEBUG_FIXED_RUSTC` → fallback.

- [ ] **Step 3: Build the wasm**

Run: `bun run vfs:build`
Expected: Build succeeds. `page/src/worker_process/vfs_bindings/vfs.js` and `vfs.core.wasm` are regenerated. `inst.ts` is restored unchanged. A warning about `rustc_opt` not exporting `__main_void` is expected and benign.

- [ ] **Step 4: Verify the build output contains the new event**

Run: `rg -c "debug-rustc" page/src/worker_process/vfs_bindings/vfs.js`
Expected: At least 1 match (the string literals from the debug_trace calls are embedded in the wasm).

- [ ] **Step 5: Commit**

```bash
git add crates/vfs/src/lib.rs page/src/worker_process/vfs_bindings/
git commit -m "feat(vfs): add EVENT_TYPE_DEBUG_FIXED_RUSTC diagnostic dispatch branch"
```

---

### Task 2: Create no-shell diagnostic harness worker

**Files:**
- Create: `scripts/test_rustc_fixed_worker.ts`

**Interfaces:**
- Consumes: `WASIFarmAnimal` from `@oligami/browser_wasi_shim-threads`, `set_fake_worker` and `custom_instantiate` from `page/src/worker_process/vfs_bindings/`, `parsePositiveInt` / `computeWorkerWatchdogMs` from `scripts/vfs_debug_config.ts`.
- Produces: A Deno worker that accepts `{ wasiRef, threads, timeoutMs, sourceCode }`, writes `/src/main.rs` via event 7, dispatches event 1007 twice, and posts `{ ok, output, error? }` back.

- [ ] **Step 1: Create the worker file**

Create `scripts/test_rustc_fixed_worker.ts` with this content:

```typescript
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "../page/src/worker_process/vfs_bindings/common.ts";
import { custom_instantiate } from "../page/src/worker_process/vfs_bindings/inst.ts";

await set_fake_worker();

const decoder = new TextDecoder();
const bindingsDir = new URL(
  "../page/src/worker_process/vfs_bindings/",
  import.meta.url,
);

async function compile(filename: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(
    await Deno.readFile(new URL(filename, bindingsDir)),
  );
}

const EVENT_TYPE_WRITE_FILE = 7;
const EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007;
const RUNS = 2;

globalThis.onmessage = async (event) => {
  const { wasiRef, threads, timeoutMs, sourceCode } = event.data;
  let output = "";

  try {
    const wasm = await compile("vfs.core.wasm");
    const animal = new WASIFarmAnimal(
      wasiRef,
      ["vfs-debug"],
      [`VFS_THREADS=${threads}`],
      {
        can_thread_spawn: true,
        thread_spawn_worker_url: new URL("thread_spawn.ts", bindingsDir).href,
        thread_spawn_wasm: wasm,
        worker_background_worker_url: new URL(
          "worker_background_worker.ts",
          bindingsDir,
        ).href,
        share_memory: {
          memory: new WebAssembly.Memory({
            initial: 1032,
            maximum: 32775,
            shared: true,
          }),
        },
      },
    );

    await animal.wait_worker_background_worker();
    const root = await custom_instantiate(
      wasm,
      animal.wasiImport,
      animal.wasiThreadImport,
      animal.get_share_memory(),
      (_index, unknown: { name?: string; args?: any }) => {
        if (unknown.name === "sysrootStartFetch") {
          return {};
        } else if (unknown.name === "sysrootGetNextFileMeta") {
          return { has_file: false, name_len: 0, data_len: 0 };
        } else if (unknown.name === "sysrootReadFileName") {
          return { name: [] };
        } else if (unknown.name === "sysrootReadFileChunk") {
          return { chunk: [] };
        } else if (unknown.name === "terminalWrite") {
          return {};
        } else {
          return {};
        }
      },
    );

    animal.start(root);
    root.debugSetTerminalCapture(true);

    const memory = animal.get_share_memory().memory;
    const drainOutput = () => {
      const len = root.debugTerminalOutputLen();
      if (len === 0) {
        return "";
      }
      const ptr = root.allocBuf(len);
      try {
        const read = root.debugReadTerminalOutput(ptr, len);
        return decoder.decode(
          new Uint8Array(memory.buffer, ptr, read).slice(),
          { stream: true },
        );
      } finally {
        root.freeBuf(ptr, len);
      }
    };

    const readyDeadline = performance.now() + timeoutMs;
    while (performance.now() < readyDeadline) {
      output += drainOutput();
      if (output.includes(" $ ")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!output.includes(" $ ")) {
      throw new Error(`system not ready after ${timeoutMs}ms (no shell prompt)`);
    }

    const writeReq = JSON.stringify({
      path: "/src/main.rs",
      content: sourceCode,
    });
    const writeBytes = new TextEncoder().encode(writeReq);
    const writePtr = root.allocBuf(writeBytes.length);
    new Uint8Array(memory.buffer).set(writeBytes, writePtr);
    root.dispatch(0xeeeeeeee, EVENT_TYPE_WRITE_FILE, writePtr, writeBytes.length);
    root.freeBuf(writePtr, writeBytes.length);

    for (let run = 0; run < RUNS; run++) {
      output += `\n[vfs-debug-driver] fixed-run:${run + 1}/${RUNS}:enter\n`;
      root.dispatch(0, EVENT_TYPE_DEBUG_FIXED_RUSTC, run + 1, 0);

      const deadline = performance.now() + timeoutMs * 2;
      let runDone = false;
      let runOutput = "";
      while (performance.now() < deadline) {
        const chunk = drainOutput();
        output += chunk;
        runOutput += chunk;
        if (runOutput.includes(`debug-rustc:return run=${run + 1}`)) {
          runDone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!runDone) {
        output += drainOutput();
        throw new Error(
          `fixed rustc run ${run + 1}/${RUNS} timed out after ${timeoutMs * 2}ms`,
        );
      }
      output += `[vfs-debug-driver] fixed-run:${run + 1}/${RUNS}:return\n`;
    }

    root.debugSetTerminalCapture(false);
    globalThis.postMessage({ ok: true, output });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      output,
      error: error instanceof Error
        ? (error.stack ?? error.message)
        : String(error),
    });
  }
};
```

Key differences from `test_rustc_inspect_worker.ts`:
- No `dispatch(sessionId, 3, 0, 0)` (no shell session open).
- No character-by-character command input.
- Dispatches `EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007` with `arg1 = run + 1` as run marker.
- Waits for `debug-rustc:return run=N` marker instead of `[vfs-debug] command:return` + ` $ `.
- No `dispatch(sessionId, 5, 0, 0)` (no session close).

- [ ] **Step 2: Commit**

```bash
git add scripts/test_rustc_fixed_worker.ts
git commit -m "feat(scripts): add no-shell fixed rustc diagnostic worker"
```

---

### Task 3: Create no-shell diagnostic harness driver and package.json script

**Files:**
- Create: `scripts/test_rustc_fixed.ts`
- Modify: `package.json:17` (add `vfs:debug-rustc-fixed` script)

**Interfaces:**
- Consumes: `ConsoleStdout`, `File`, `OpenFile` from `@bjorn3/browser_wasi_shim`, `WASIFarm` from `@oligami/browser_wasi_shim-threads`, `buildPreopenDirectory` from `scripts/build_preopen.ts`, `prepareCachedSysroot` from `scripts/sysroot_cache.ts`, `parsePositiveInt` / `computeWorkerWatchdogMs` from `scripts/vfs_debug_config.ts`.
- Produces: A Deno script that prepares the sysroot, spawns the worker from Task 2, and reports results.

- [ ] **Step 1: Create the driver file**

Create `scripts/test_rustc_fixed.ts` with this content:

```typescript
import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { buildPreopenDirectory } from "./build_preopen.ts";
import { prepareCachedSysroot } from "./sysroot_cache.ts";
import {
  computeWorkerWatchdogMs,
  parsePositiveInt,
} from "./vfs_debug_config.ts";

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

const workerWatchdogMs = computeWorkerWatchdogMs({
  commandTimeoutMs: timeoutMs,
  runs: 2,
  perRunMultiplier: 2,
  graceMs: 60000,
});

const testDir = "./test_workspace_rustc";
const sysroot = await prepareCachedSysroot();
console.log(
  `Prepared ${sysroot.expandedSysroot} from ${sysroot.source}: ${sysroot.cacheArchive}`,
);

const preopen = await buildPreopenDirectory(".", testDir);

const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) =>
    console.log(`[WASI stdout] ${message}`),
  ),
  ConsoleStdout.lineBuffered((message) =>
    console.error(`[WASI stderr] ${message}`),
  ),
  [preopen],
  {
    allocator_size: 100 * 1024 * 1024,
  },
);

const worker = new Worker(
  new URL("./test_rustc_fixed_worker.ts", import.meta.url),
  { type: "module" },
);

const sourceCode = Deno.readTextFileSync("./test_debug.rs");

const result = await new Promise<{
  ok: boolean;
  output: string;
  error?: string;
}>((resolve) => {
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
```

- [ ] **Step 2: Add package.json script**

In `package.json`, after line 17 (`"vfs:debug-rustc-twice": "deno run --no-lock -A scripts/test_rustc_inspect.ts",`), add:

```json
    "vfs:debug-rustc-fixed": "deno run --no-lock -A scripts/test_rustc_fixed.ts",
```

- [ ] **Step 3: Commit**

```bash
git add scripts/test_rustc_fixed.ts package.json
git commit -m "feat(scripts): add no-shell fixed rustc diagnostic driver"
```

---

### Task 4: Run diagnostic and compare with shell-based results

**Files:**
- No file changes — this is a verification task.

- [ ] **Step 1: Run the no-shell diagnostic with 2 runs**

Run: `VFS_DEBUG_TIMEOUT_MS=60000 deno run --no-lock -A scripts/test_rustc_fixed.ts`
Expected: Either:
  - **Success** — both runs return, output contains `debug-rustc:return run=1` and `debug-rustc:return run=2`. This would mean the hang is in the shell path, not the rustc_opt/WVL path.
  - **Timeout** — run 2 hangs after `debug-rustc:_main:enter run=2` but before `debug-rustc:_main:return run=2`. This would confirm the hang is in the reused `rustc_opt`/WVL/thread/reset path, below the shell layer.

- [ ] **Step 2: Compare with the existing shell-based harness**

Run: `VFS_DEBUG_RUNS=2 VFS_DEBUG_TIMEOUT_MS=60000 deno run --no-lock -A scripts/test_rustc_inspect.ts`
Expected: Run 2 times out after `rustc:_main:enter` (the known behavior).

- [ ] **Step 3: Document findings**

Append results to `docs/webshell-rustc-hang-debug.md`:
- Did the no-shell diagnostic reproduce the 2nd-run hang?
- Which debug marker was the last one before timeout?
- What this tells us about the root cause location.

```bash
git add docs/webshell-rustc-hang-debug.md
git commit -m "docs: record fixed rustc dispatch diagnostic results"
```

---

## Self-Review

**Spec coverage:**
- "Add EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007" → Task 1, Steps 1–2. ✓
- "The new branch runs before the fallback to vfs_shell_dispatch" → Task 1, Step 2 (inserted before line 300). ✓
- "It ignores session_id, arg1, and arg2 for behavior. If a run marker is useful for logs, arg1 may be printed" → Task 1, Step 2 (`run_marker = arg1`, printed in debug_trace). ✓
- "Ensure rustc_opt with RUSTC_CONFIG and llvm_opt with LLVM_CONFIG" → Task 1, Step 2. ✓
- "Set fixed arguments through command::set_rustc_opt_args" → Task 1, Step 2 (exact args listed). ✓
- "Call _reset() then _main()" → Task 1, Step 2. ✓
- "Print explicit diagnostic markers" → Task 1, Step 2 (enter/reset/main/return markers). ✓
- "Harness: instantiate vfs.core.wasm" → Task 2, Step 1. ✓
- "Write /src/main.rs through EVENT_TYPE_WRITE_FILE = 7" → Task 2, Step 1. ✓
- "Dispatch 1007 twice" → Task 2, Step 1 (RUNS = 2 loop). ✓
- "Wait for return markers or timeout" → Task 2, Step 1 (deadline loop checking for `debug-rustc:return run=N`). ✓
- "Must not call dispatch(sessionId, 3, 0, 0)" → Task 2, Step 1 (no session open call). ✓
- "Must not send interactive character input events" → Task 2, Step 1 (no char dispatch). ✓
- "Report which run entered, returned, or timed out" → Task 2, Step 1 + Task 4. ✓

**Placeholder scan:** No TBD, TODO, or vague steps. All code is complete. ✓

**Type consistency:** `EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007` in Rust matches `1007` in TypeScript worker. `debug-rustc:return run=N` marker string is consistent between Rust (`format!("debug-rustc:return run={run_marker}")`) and TypeScript (`runOutput.includes(`debug-rustc:return run=${run + 1}`)`). ✓
