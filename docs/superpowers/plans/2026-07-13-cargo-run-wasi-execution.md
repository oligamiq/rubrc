# Cargo Run WASI Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute `cargo run` targets in WebShell with `WASIFarmAnimal`, inherited terminal descriptors, and VFS filesystem changes synchronized before and after execution.

**Architecture:** Cargo marks only its WASI `exec_replace()` child as a streaming target. VFS mirrors the bounded project tree into the TypeScript-backed WASIFarm filesystem, uploads the target module through a scalar request-ID bridge, and waits while a dedicated Worker runs a non-threaded `WASIFarmAnimal`. Graceful child changes are imported into VFS with conflict detection; traps and timeouts restore a TypeScript baseline.

**Tech Stack:** Rust, Cargo WASI bridge, WIT scalar resources, wasi_virt_layer dynamic LFS, TypeScript, Deno, Web Workers, `@oligami/browser_wasi_shim-threads`, `@bjorn3/browser_wasi_shim` filesystem inodes.

## Global Constraints

- Dynamic execution is only for `wasm32-wasip1` command modules reached through WASI `exec_replace()`.
- Existing `ProcessBuilder::output()` and `status()` behavior remains unchanged.
- Existing `rustc` child execution remains unchanged.
- Use `WASIFarmAnimal` with the existing WASIFarm reference and no thread-spawn option.
- Synchronize stdin, stdout, stderr, and the farm's preopened root descriptors; do not add a parallel stdio transport.
- Exclude `/sysroot`, `/target`, `/.cargo/registry`, `/.cargo/git`, `/.git`, `/node_modules`, and `/.cache` from filesystem synchronization.
- Reject synchronization above 10,000 entries or 64 MiB of file content.
- Reject target modules above 16 MiB.
- Upload module chunks at no more than 256 KiB and runner-error reads at no more than 64 KiB.
- Permit one dynamic child, expire inactive uploads after 30 seconds, and terminate execution after 120 seconds.
- Use scalar WIT parameters only. JavaScript adapters copy pointer/length ranges from VFS-owned memory before host calls.
- Do not call a Rust export from a JavaScript import callback.
- Keep the protected untracked files in Cargo and rubrc untouched.

---

### Task 1: Add Cargo Streaming Spawn Mode

**Files:**
- Modify: `/home/oligami/projects/cargo/crates/cargo-util/src/process_builder.rs:245-399`
- Test: `/home/oligami/projects/cargo/crates/cargo-util/src/process_builder.rs` test module

**Interfaces:**
- Produces: `WasiSpawnMode::{Capture, Replace}` values encoded as `0` and `1` and passed to `wasi_ext_spawn`.
- Produces: `ProcessBuilder::wasi_output(spawn_mode: i32) -> Result<Output>` under `target_os = "wasi"`.
- Consumes later: VFS `wasi_ext_spawn(..., spawn_mode: i32, ...)` in Task 4.

- [ ] **Step 1: Add a failing unit test for mode separation**

Add a target-neutral helper and test its desired API before implementing its body:

```rust
#[test]
fn wasi_exec_replace_uses_streaming_spawn_without_changing_output_mode() {
    assert_eq!(WasiSpawnMode::Capture.as_i32(), 0);
    assert_eq!(WasiSpawnMode::Replace.as_i32(), 1);
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test -p cargo-util wasi_exec_replace_uses_streaming_spawn_without_changing_output_mode`

Expected: FAIL because `WasiSpawnMode` does not exist.

- [ ] **Step 3: Extract the existing WASI output bridge and add the mode parameter**

Move the current WASI body of `output()` into a private method without changing its nonzero-status handling:

```rust
#[cfg(any(target_os = "wasi", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WasiSpawnMode { Capture, Replace }

#[cfg(any(target_os = "wasi", test))]
impl WasiSpawnMode {
    fn as_i32(self) -> i32 {
        match self { Self::Capture => 0, Self::Replace => 1 }
    }
}

#[cfg(target_os = "wasi")]
fn wasi_output(&self, spawn_mode: WasiSpawnMode) -> Result<(Output, i32)> {
    // Keep the existing serialization, allocation ownership, and ProcessError
    // construction. Return the raw bridge exit code alongside Output.
}
```

The import must add `spawn_mode: i32` immediately after program pointer/length. `output()` calls `wasi_output(WasiSpawnMode::Capture)` and preserves its existing nonzero `ProcessError`. WASI `exec_replace()` calls `wasi_output(WasiSpawnMode::Replace)` and invokes `std::process::exit(raw_exit_code)` when the child returns nonzero, so embedded Cargo's existing `CustomProcess` records the exact child status instead of converting it to Cargo exit 101. Native `exec_replace()` remains unchanged.

- [ ] **Step 4: Run Cargo tests and formatting checks**

Run: `cargo test -p cargo-util wasi_exec_replace_uses_streaming_spawn_without_changing_output_mode write_atomic`

Expected: 4 tests PASS.

Run: `rustfmt --edition 2024 --check crates/cargo-util/src/process_builder.rs`

Expected: PASS.

- [ ] **Step 5: Commit the Cargo change**

```bash
git add crates/cargo-util/src/process_builder.rs
git commit -m "Add WASI streaming process mode"
```

---

### Task 2: Implement Bounded Filesystem Reconciliation

**Files:**
- Create: `crates/vfs/src/filesystem_sync.rs`
- Modify: `crates/vfs/src/lib.rs:295-360`
- Test: `crates/vfs/src/filesystem_sync.rs`

**Interfaces:**
- Produces: `SyncBaseline`, `SyncLimits`, and `SyncError`.
- Produces: `sync_vfs_to_host(lfs: &LFS, root: usize, host_root: &Path, limits: SyncLimits, runtime_exclusions: &[PathBuf]) -> Result<SyncBaseline, SyncError>`.
- Produces: `sync_host_to_vfs(lfs: &LFS, root: usize, host_root: &Path, baseline: &SyncBaseline, limits: SyncLimits) -> Result<Vec<PathBuf>, SyncError>` where returned paths are conflicts preserved in VFS.
- Produces: `import_host_authoritative(...)` for replacement-VFS recovery.
- Consumes: dynamic LFS `read_dir`, `read_file`, `write_file`, `add_file`, `add_dir`, `remove_file`, and `remove_dir`.

- [ ] **Step 1: Write failing unit tests for scope, limits, and diffs**

Create pure snapshot tests around a small in-memory tree adapter. Cover these exact cases:

```rust
#[test]
fn excludes_runtime_and_dependency_trees() {
    for path in ["sysroot", "target", ".cargo/registry", ".cargo/git", ".git", "node_modules", ".cache"] {
        assert!(is_excluded(Path::new(path)), "{path}");
    }
    assert!(!is_excluded(Path::new("src/main.rs")));
}

#[test]
fn rejects_entry_and_byte_budgets_before_execution() {
    assert_eq!(check_limits(10_001, 1), Err(SyncError::TooManyEntries));
    assert_eq!(check_limits(1, 64 * 1024 * 1024 + 1), Err(SyncError::TooManyBytes));
}

#[test]
fn child_diff_preserves_concurrent_vfs_edit() {
    let baseline = file_map([("shared.txt", b"before")]);
    let child = file_map([("shared.txt", b"child")]);
    let current_vfs = file_map([("shared.txt", b"editor")]);
    let result = reconcile_diff(&baseline, &child, &current_vfs).unwrap();
    assert_eq!(result.conflicts, vec![PathBuf::from("shared.txt")]);
    assert_eq!(result.tree["shared.txt"].bytes(), b"editor");
}
```

Also test create, update, delete, file-to-directory replacement, directory-to-file replacement, and authoritative recovery import.

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p vfs filesystem_sync`

Expected: FAIL because `filesystem_sync` and its APIs do not exist.

- [ ] **Step 3: Implement snapshot and reconciliation logic**

Use these exact limits and exclusions:

```rust
pub const DEFAULT_SYNC_LIMITS: SyncLimits = SyncLimits {
    max_entries: 10_000,
    max_bytes: 64 * 1024 * 1024,
};

const EXCLUDED_ROOTS: &[&str] = &[
    "sysroot", "target", ".cargo/registry", ".cargo/git",
    ".git", "node_modules", ".cache",
];
```

Represent each baseline entry as directory or file bytes plus a stable content digest. Count every entry and file byte before mutating the destination. Apply directory removals deepest-first and creations shallowest-first. For reverse sync, mutate only host entries whose digest differs from baseline; before each VFS mutation, compare the current VFS digest to baseline and record a conflict instead of overwriting a concurrent edit.

Add the normalized `CARGO_TARGET_DIR` from the child environment to `runtime_exclusions`. When that variable is absent, infer a custom target root from the executable path by removing the `wasm32-wasip1/<profile>/<binary>.wasm` suffix. This keeps custom build artifact trees out of synchronization.

- [ ] **Step 4: Replace add-only flush methods with the new APIs**

In `crates/vfs/src/lib.rs`, add `mod filesystem_sync;`, remove the old recursive `flush_to_vfs` and `flush_from_vfs` bodies, and keep startup behavior by calling `import_host_authoritative` once during initialization. Do not yet invoke pre/post child sync; Task 4 owns that lifecycle.

- [ ] **Step 5: Run focused and existing VFS tests**

Run: `cargo test -p vfs filesystem_sync`

Expected: all new reconciliation tests PASS.

Run: `cargo test -p vfs --lib`

Expected: all VFS library tests PASS.

- [ ] **Step 6: Commit reconciliation**

```bash
git add crates/vfs/src/filesystem_sync.rs crates/vfs/src/lib.rs
git commit -m "feat(vfs): reconcile child filesystem changes"
```

---

### Task 3: Add Scalar Child-Process WIT And JavaScript Adapter

**Files:**
- Modify: `crates/vfs/wit/vfs-host.wit`
- Modify: `crates/vfs-rustc-twice/wit/vfs-host.wit`
- Create: `page/src/worker_process/vfs_bindings/child_process_import.ts`
- Modify: `page/src/worker_process/vfs_bindings/inst.ts:58-202`
- Create: `scripts/vfs_child_process_import_test.ts`

**Interfaces:**
- Produces WIT resource: `child-process` with `request-start`, `request-write`, `request-run`, `request-read-error`, `request-recover`, and `request-end`.
- Produces: `createChildProcessImports(memory, callUnknownFn)` matching generated camelCase import names.
- Consumes later: host message names `childProcessStart`, `childProcessWrite`, `childProcessRun`, `childProcessReadError`, `childProcessRecover`, and `childProcessEnd` from Task 4.

- [ ] **Step 1: Add failing adapter tests**

Model tests after `scripts/vfs_http_import_test.ts`. Assert:

```ts
Deno.test("child process imports copy only bounded VFS-owned ranges", async () => {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const calls: unknown[] = [];
  const imports = createChildProcessImports(
    { memory },
    (_index, message) => {
      calls.push(message);
      return { request_id: 7, state: 1, status: 0, error_len: 0 };
    },
  );
  // Write argv/env/module bytes into memory, call requestStart/requestWrite,
  // and assert copied arrays, scalar metadata, and no retained memory views.
});
```

Add rejection tests for a module chunk above `256 * 1024`, error read above `64 * 1024`, sparse arrays, invalid request IDs, short returned chunks, and cleanup after metadata-write failure.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `deno test --no-lock -A scripts/vfs_child_process_import_test.ts`

Expected: FAIL because the adapter and WIT resource do not exist.

- [ ] **Step 3: Add identical scalar WIT resources**

Add the same resource to both WIT files. Use only `s32` scalar pointer/length and output-pointer parameters, following the existing `http` resource. Define lifecycle states `0 = none`, `1 = uploading`, `2 = running`, `3 = completed` in the TypeScript/Rust code rather than a WIT variant.

- [ ] **Step 4: Implement and install `createChildProcessImports`**

Follow `http_import.ts`: copy input ranges immediately from `memory.memory.buffer`, pass plain arrays through `callUnknownFn`, validate all returned values as u32, and write only scalar metadata through `DataView`. Install the returned object as `ChildProcess` under `'vfs:host/bridge'` in `inst.ts`.

- [ ] **Step 5: Run adapter, HTTP, and WIT parity tests**

Run: `deno test --no-lock -A scripts/vfs_child_process_import_test.ts scripts/vfs_http_import_test.ts`

Expected: all tests PASS, including exact parity of both WIT resources.

- [ ] **Step 6: Commit WIT and adapter changes**

```bash
git add crates/vfs/wit/vfs-host.wit crates/vfs-rustc-twice/wit/vfs-host.wit \
  page/src/worker_process/vfs_bindings/child_process_import.ts \
  page/src/worker_process/vfs_bindings/inst.ts scripts/vfs_child_process_import_test.ts
git commit -m "feat(vfs): add child process host protocol"
```

---

### Task 4: Implement WASIFarmAnimal Host Runner

**Files:**
- Create: `lib/src/child_process_bridge.ts`
- Create: `page/src/worker_process/vfs_bindings/child_process_worker.ts`
- Create: `scripts/vfs_child_process_bridge_test.ts`
- Create: `scripts/fixtures/wasi_child_args.wat`

**Interfaces:**
- Produces: `createChildProcessBridge(options: ChildProcessBridgeOptions): (message: ChildProcessMessage) => Promise<unknown>`.
- `ChildProcessBridgeOptions` contains `getWasiRef`, `workerUrl`, `filesystemRoot`, `uploadTimeoutMs`, and `executionTimeoutMs`.
- Produces: `isChildProcessMessage(value: unknown): value is ChildProcessMessage`.
- Worker input: `{ module: ArrayBuffer; wasiRef; args: string[]; env: string[] }`.
- Worker output: `{ status: number; error?: string; graceful: boolean }`.

- [ ] **Step 1: Write failing bridge lifecycle tests**

Use a fake Worker and real `Directory`/`File` inodes. Test start/write/run/read/end, one-child rejection, 30-second upload expiry with injected timers, 120-second execution termination, pending uploading/running recovery abort, completed recovery, and baseline rollback after trap.

The core success assertion must be:

```ts
const result = await bridge({
  name: "childProcessRun",
  args: { request_id: requestId },
});
assertEquals(result, { state: 3, status: 0, error_len: 0 });
```

- [ ] **Step 2: Run bridge tests and verify RED**

Run: `deno test --no-lock -A scripts/vfs_child_process_bridge_test.ts`

Expected: FAIL because the bridge does not exist.

- [ ] **Step 3: Implement request storage and filesystem baseline management**

Keep one request in a closure-owned slot. Store upload buffers, decoded argv/env, lifecycle state, Worker handle, result, and a deep baseline snapshot of included TypeScript filesystem entries. Enforce 16 MiB module size, exact uploaded lengths, 10,000-entry/64 MiB filesystem budget, upload inactivity, and idempotent end/abort.

Do not release a completed request until `childProcessEnd`. `childProcessRecover` returns uploading/running/completed state. Recovering an active request terminates its Worker, restores the baseline, and clears the slot.

- [ ] **Step 4: Implement the dedicated non-threaded Worker**

The worker must instantiate with the existing farm reference:

```ts
const animal = new WASIFarmAnimal(wasiRef, args, env);
const { instance } = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: animal.wasiImport,
});
const status = animal.start(instance as WebAssembly.Instance & {
  exports: { memory: WebAssembly.Memory; _start(): unknown };
});
postMessage({ status, graceful: true });
```

Catch setup/compile/trap failures and post `{ status: 126, error: String(error), graceful: false }`. Do not enable `can_thread_spawn` and do not create a second filesystem or stdio implementation.

- [ ] **Step 5: Build the deterministic WAT fixture and run real-worker tests**

Create this exact fixture, which writes through the inherited stdout and exits through WASI:

```wat
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "child-ok\n")
  (func (export "_start")
    (i32.store (i32.const 32) (i32.const 0))
    (i32.store (i32.const 36) (i32.const 9))
    (drop
      (call $fd_write
        (i32.const 1)
        (i32.const 32)
        (i32.const 1)
        (i32.const 40)))
    (call $proc_exit (i32.const 0))))
```

Convert it before tests:

Run: `wasm-tools parse scripts/fixtures/wasi_child_args.wat -o /tmp/opencode/wasi_child_args.wasm`

`/tmp/opencode` is the environment's existing pre-approved temporary directory. Expected: `/tmp/opencode/wasi_child_args.wasm` is created and validates with `wasm-tools validate`.

Run: `deno test --no-lock -A scripts/vfs_child_process_bridge_test.ts`

Expected: normal return, explicit `proc_exit`, argument propagation, filesystem mutation, trap rollback, and timeout tests PASS.

- [ ] **Step 6: Commit the host runner**

```bash
git add lib/src/child_process_bridge.ts \
  page/src/worker_process/vfs_bindings/child_process_worker.ts \
  scripts/vfs_child_process_bridge_test.ts scripts/fixtures/wasi_child_args.wat
git commit -m "feat: run WASI children with WASIFarmAnimal"
```

---

### Task 5: Connect VFS Spawn To The Host Runner

**Files:**
- Modify: `crates/vfs/src/lib.rs:1042-1218`
- Modify: `page/src/xterm.tsx:321-423`
- Modify: `scripts/vfs_debug_shell_worker.ts:25-91`
- Modify: `scripts/vfs_debug_cargo_info_test.ts`
- Modify: `scripts/vfs_debug_cargo_add_test.ts`
- Modify: `scripts/vfs_debug_cargo_pipe_test.ts`
- Create: `scripts/vfs_debug_cargo_run_test.ts`

**Interfaces:**
- Consumes: Cargo `spawn_mode` from Task 1.
- Consumes: `filesystem_sync` from Task 2.
- Consumes: WIT `ChildProcess` resource from Task 3.
- Consumes: `createChildProcessBridge` and child Worker from Task 4.

- [ ] **Step 1: Write the failing WebShell `cargo run` E2E**

Create a minimal preloaded project whose `main.rs` prints its arguments, reads `/input.txt`, writes `/created.txt`, and exits zero. Run commands:

```ts
commands: [
  ["cargo", "run", "--", "first", "second"],
  ["cat", "/created.txt"],
]
```

Assert the output includes both arguments, the input contents, created contents, `[vfs-debug] command:return`, and a following shell prompt. The initial run must fail with `unsupported child process` and exit code 127.

- [ ] **Step 2: Run the E2E and verify RED**

Run: `deno run --no-lock -A scripts/vfs_debug_cargo_run_test.ts`

Expected: FAIL with the current `unsupported child process: ...main.wasm` message.

- [ ] **Step 3: Implement dynamic `.wasm` handling in `wasi_ext_spawn`**

Add `spawn_mode` to the export signature. Preserve the current `rustc` branch exactly. For non-rustc:

```rust
if spawn_mode != WASI_SPAWN_REPLACE || Path::new(&program).extension() != Some(OsStr::new("wasm")) {
    return unsupported_child(...);
}
```

Resolve the program against the child cwd, read and size-check bytes, call `sync_vfs_to_host`, start/upload/run the WIT request, and use an RAII request guard. On graceful completion, call `sync_host_to_vfs`; on recovery startup call `import_host_authoritative`. Return status and a bounded error through `write_cargo_owned_spawn_result`. Keep all Cargo-owned allocation layouts exact.

Before accepting the first shell command after VFS initialization, call `ChildProcess::request_recover`. If it reports uploading or running, call `request_end` to abort and release it after host rollback. If it reports completed, run `import_host_authoritative` and then call `request_end` to acknowledge and release the retained slot. A zero request ID means no recovery work.

- [ ] **Step 4: Route the host bridge in browser and Deno harnesses**

In `xterm.tsx`, create one child bridge with lazy `getWasiRef: () => farm.get_ref()`, the existing `root_dir`, and the Vite Worker URL. Route `isChildProcessMessage` before the generic unknown-function fallback.

In each Deno harness, add one `PreopenDirectory("/", new Map())` to the existing farm, retain that same root object for the child bridge, and construct the bridge from `farm.get_ref()`. Route child messages alongside HTTP messages. Do not duplicate child protocol logic in individual harnesses. The inherited stdout/stderr descriptors already route directly through the farm and never call back into suspended VFS Rust.

- [ ] **Step 5: Run focused E2E and regression tests**

Run: `deno run --no-lock -A scripts/vfs_debug_cargo_run_test.ts`

Expected: PASS with target output, argument propagation, file read/write, command return, and prompt return.

Run: `deno run --no-lock -A scripts/vfs_debug_cargo_add_test.ts`

Expected: PASS and metadata contains `hello`.

Run: `deno run --no-lock -A scripts/vfs_debug_cargo_info_test.ts`

Expected: PASS with real fetch count greater than zero.

Run: `deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts`

Expected: PASS with four rustc invocations and `Finished dev profile`.

- [ ] **Step 6: Commit integration source and tests**

```bash
git add crates/vfs/src/lib.rs page/src/xterm.tsx scripts/vfs_debug_shell_worker.ts \
  scripts/vfs_debug_cargo_info_test.ts scripts/vfs_debug_cargo_add_test.ts \
  scripts/vfs_debug_cargo_pipe_test.ts scripts/vfs_debug_cargo_run_test.ts
git commit -m "feat(vfs): execute Cargo run targets"
```

---

### Task 6: Rebuild Artifacts And Final Verification

**Files:**
- Modify: `crates/vfs/cargo_opt.wasm`
- Modify generated files under: `dist/`
- Modify generated files under: `page/src/worker_process/vfs_bindings/`
- Update if needed: `.git/sdd/` verification reports, which remain uncommitted

**Interfaces:**
- Consumes all previous tasks.
- Produces deployable Cargo and VFS artifacts with matching generated bindings.

- [ ] **Step 1: Rebuild the Cargo guest with the repository WASI SDK environment**

Run the established `cargo +nightly build -r --bin cargo --target wasm32-wasip1-threads -Zbuild-std` command with `/opt/wasi-sdk`, then run `wasm-opt -Oz` into `crates/vfs/cargo_opt.wasm`.

Expected: release build and optimization succeed with only existing baseline warnings.

- [ ] **Step 2: Rebuild VFS and generated bindings**

Run: `bun run vfs:build`

Expected: VFS component generation, Deno dependency setup, and binding copy complete successfully.

Record the SHA-256 of `crates/vfs/cargo_opt.wasm` before `bun run vfs:build`, then verify the generated `dist/vfs.core.wasm` and `page/src/worker_process/vfs_bindings/vfs.core.wasm` both change and remain byte-identical. The VFS build embeds `cargo_opt.wasm`; no standalone browser copy of Cargo is served.

- [ ] **Step 3: Run all focused TypeScript and Rust tests**

Run:

```bash
deno test --no-lock -A \
  scripts/vfs_child_process_import_test.ts \
  scripts/vfs_child_process_bridge_test.ts \
  scripts/vfs_http_bridge_test.ts \
  scripts/vfs_http_import_test.ts \
  scripts/vfs_build_script_test.ts
cargo test -p vfs --lib
```

Expected: zero failed tests.

- [ ] **Step 4: Run final WebShell E2E tests**

Run each command separately:

```bash
deno run --no-lock -A scripts/vfs_debug_cargo_run_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_add_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_info_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts
```

Expected: all commands exit zero and each command returns to the shell prompt.

- [ ] **Step 5: Validate artifacts and repository hygiene**

Run:

```bash
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
cmp -s dist/vfs.core.wasm page/src/worker_process/vfs_bindings/vfs.core.wasm
```

Expected: both artifacts validate, `cmp` exits zero, and no whitespace errors are reported.

- [ ] **Step 6: Request adversarial pre-merge review and address blockers**

Review Cargo spawn-mode changes, filesystem conflict/rollback semantics, scalar bridge bounds, Worker cleanup, and all generated artifacts. Any blocker requires a new focused RED/GREEN cycle before commit.

- [ ] **Step 7: Commit final rubrc artifacts**

```bash
git add crates/vfs/cargo_opt.wasm dist page/src/worker_process/vfs_bindings
git commit -m "build(vfs): update Cargo run artifacts"
```

- [ ] **Step 8: Record final commit IDs and protected-file status**

Run `git status --short` and `git log -1 --oneline` in Cargo and rubrc. Confirm only the previously protected untracked files remain and report both new commit IDs.
