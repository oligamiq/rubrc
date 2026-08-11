# Rust-Analyzer WASI Boundary Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine the first rust-analyzer WASI metadata stage that the browser fails to cross after its four host Cargo calls return successfully.

**Architecture:** Rust-analyzer emits numeric, nonblocking boundary events through a new import resolved directly to a rubrc VFS Rust export in the combined Wasm component. The VFS records correlated events in its existing bounded debug ring, and an identical instrumented `lsp_opt.wasm` is used for passing Deno and stalled browser runs. A single experimental fix may be tested only after the first missing boundary is identified.

**Tech Stack:** Rust 2024, rust-analyzer, `wasm32-wasip1-threads`, WebAssembly/WASI, `wasi_virt_layer`, Deno, Bun, Puppeteer.

## Global Constraints

- Rubrc worktree: `/home/oligami/projects/rubrc/.worktrees/rust-analyzer-diagnostics`.
- Rust-analyzer instrumentation worktree: `/tmp/opencode/rust-analyzer-metadata-trace`, branch `debug/wasm-metadata-boundary`, base `b1829d7770`.
- `wasi_virt_layer` trace worktree: `/tmp/opencode/wasi-virt-layer-ra-stall`, commit `1552adeee1ce437c924577d6b79d8efdd03aa8ee`.
- Do not modify Cargo, rustc, browser shim packages, generated bindings manually, registry caches, `deno.lock`, `crates/vfs/expanded.rs`, or `diff.patch`.
- Boundary events contain IDs, stage numbers, statuses, and byte lengths only. Never log arguments, environment values, JSON, source, stdout, or stderr payloads.
- Rust-analyzer boundary emission is WASI-only and must use a direct combined-Wasm import, not stdout, stderr, or a JavaScript callback.
- Boundary recording uses `try_lock`; contention drops the event, increments a counter, and never blocks the observed thread.
- Use one instrumented `lsp_opt.wasm` hash for both controlled paths. Never rebuild between Deno and browser runs.
- Existing rubrc files are heavily dirty. Preserve all existing hunks, create task-owned diffs, and do not stage or commit mixed files.
- An experimental fix changes one behavior only. A successful fix requires interleaved fail-pass-fail-pass evidence; if nondeterministic, run at least three isolated trials per state.

---

### Task 1: Nonblocking VFS Boundary Sink

**Files:**
- Modify: `crates/vfs/src/lib.rs` around debug capture state and `host_run_cargo`
- Modify: `crates/vfs/src/debug_state.rs` snapshot schema
- Test: existing `crates/vfs/src/lib.rs` test modules
- Test: `scripts/vfs_debug_trace_contract_test.ts`

**Interfaces:**
- Produces: `#[unsafe(no_mangle)] pub extern "C" fn host_trace_boundary(trace_id: u32, stage: u32, value_1: u32, value_2: u32) -> u32`.
- Produces: host trace mapping line `host-cargo:map id={host_id} ra_id={trace_id}`.
- Produces: snapshot field `ra_boundary_dropped={count}`.
- Consumes: existing `DEBUG_TERMINAL_CAPTURE`, bounded `DEBUG_TERMINAL_OUTPUT`, and Cargo request JSON.

- [ ] **Step 1: Save before-images and write RED tests**

Save all Task 1 files under `/tmp/opencode/ra-boundary-task-1-before`. Add Rust tests that require:

```rust
assert_eq!(
    format_ra_boundary(9, RaBoundaryStage::FfiReturn as u32, 0, 2106),
    "[ra-wasi-boundary] id=9 stage=ffi:return value_1=0 value_2=2106",
);
assert_eq!(format_host_cargo_map(7, Some(9)), Some("host-cargo:map id=7 ra_id=9".into()));
assert_eq!(format_host_cargo_map(7, None), None);
```

Add a source contract requiring `host_trace_boundary` to use `try_lock`, forbidding `debug_trace(` inside that function, and requiring the snapshot to expose `ra_boundary_dropped`.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
RUSTFLAGS='-C link-arg=-Wl,--unresolved-symbols=ignore-all' cargo test -p vfs ra_boundary
deno test --no-lock --allow-read scripts/vfs_debug_trace_contract_test.ts
```

Expected: Rust compile failure for missing stage/format functions and one failing Deno contract.

- [ ] **Step 3: Implement the fixed stage table and sink**

Add one `#[repr(u32)]` VFS-side stage enum matching Task 2:

```rust
enum RaBoundaryStage {
    FfiEnter = 1,
    FfiReturn = 2,
    BuffersBorrowed = 3,
    BuffersCopyEnter = 4,
    BuffersCopied = 5,
    BuffersFreeEnter = 6,
    BuffersFreed = 7,
    InvokeReturn = 8,
    MetadataInvokeEnter = 9,
    MetadataInvokeReturn = 10,
    MetadataUtf8Enter = 11,
    MetadataUtf8Return = 12,
    MetadataParseEnter = 13,
    MetadataParseReturn = 14,
    MetadataFinished = 15,
    WorkspaceCargoSpawnEnter = 16,
    WorkspaceCargoSpawnReturn = 17,
    WorkspaceCargoJoinEnter = 18,
    WorkspaceCargoJoinReturn = 19,
    WorkspaceCargoJoinError = 20,
    WorkspaceCargoMapReturn = 21,
    WorkspaceLoadReturn = 22,
    ScopeUnwind = 23,
}
```

`host_trace_boundary` checks `DEBUG_TERMINAL_CAPTURE` first, then calls `DEBUG_TERMINAL_OUTPUT.try_lock()`. On success it pushes one formatted lifecycle event. On lock failure it increments `DEBUG_RA_BOUNDARY_DROPPED` with `Ordering::Relaxed`. It always returns 0 and never retries.

Reset the dropped counter when capture is enabled or disabled. Include it in every wait snapshot.

- [ ] **Step 4: Correlate RA and host Cargo IDs**

After parsing the existing Cargo request JSON, read:

```rust
let ra_trace_id = request
    .get("trace_id")
    .and_then(serde_json::Value::as_u64)
    .and_then(|value| u32::try_from(value).ok());
```

When debug capture is enabled and both IDs exist, emit `host-cargo:map`. Do not reject requests with missing, nonnumeric, or oversized `trace_id`.

- [ ] **Step 5: Run GREEN verification**

Run:

```bash
RUSTFLAGS='-C link-arg=-Wl,--unresolved-symbols=ignore-all' cargo test -p vfs ra_boundary
RUSTFLAGS='-C link-arg=-Wl,--unresolved-symbols=ignore-all' cargo test -p vfs lsp_cargo_result_tests
rustc --edition=2024 --test crates/vfs/src/debug_state.rs -o /tmp/opencode/ra_boundary_debug_state_test
/tmp/opencode/ra_boundary_debug_state_test
deno test --no-lock --allow-read scripts/vfs_debug_trace_contract_test.ts page/src/vfs_debug_trace_test.ts
cargo check -p vfs --no-default-features
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Preserve the mixed worktree**

Generate `/home/oligami/projects/rubrc/.git/worktrees/rust-analyzer-diagnostics/sdd/ra-boundary-task-1-owned.diff` against the saved before-images. Leave all Task 1 rubrc changes unstaged and uncommitted.

### Task 2: Rust-Analyzer Correlated Boundary Events

**Files:**
- Modify: `/tmp/opencode/rust-analyzer-metadata-trace/crates/toolchain/src/wasi_cargo.rs`
- Modify: `/tmp/opencode/rust-analyzer-metadata-trace/crates/project-model/src/cargo_workspace.rs`
- Modify: `/tmp/opencode/rust-analyzer-metadata-trace/crates/project-model/src/workspace.rs`
- Create: `scripts/rust_analyzer_boundary_trace_contract_test.ts` in rubrc

**Interfaces:**
- Produces: `WasiBoundaryStage`, `next_trace_id()`, `trace_boundary()`, `invoke_cargo_with_trace_id()`.
- Produces: optional Cargo request JSON field `trace_id`.
- Consumes: Task 1 `host_trace_boundary` numeric ABI and exact stage values 1 through 23.

- [ ] **Step 1: Write cross-repository RED contracts**

Create a Deno source contract that reads the three rust-analyzer files and Task 1 enum. It must assert:

- all 23 stage discriminants match;
- `host_trace_boundary` is imported from `__wasip1_vfs-host`;
- `CargoRequest` contains `trace_id`;
- copy and free operations each have enter/return brackets;
- Cargo metadata has invoke, UTF-8, parse, and finished brackets;
- workspace has Cargo spawn, join success/error, map, and load-return brackets;
- all calls are inside WASI-gated code;
- no boundary call includes `args`, `envs`, `stdout`, `stderr`, or JSON values.

- [ ] **Step 2: Run the contract to verify RED**

Run from rubrc:

```bash
deno test --no-lock --allow-read scripts/rust_analyzer_boundary_trace_contract_test.ts
```

Expected: failure because the imported function and stage table do not exist.

- [ ] **Step 3: Implement the WASI trace API**

In `wasi_cargo.rs`, add under `cfg(target_os = "wasi")`:

```rust
#[link(wasm_import_module = "__wasip1_vfs-host")]
unsafe extern "C" {
    fn host_trace_boundary(
        trace_id: u32,
        stage: u32,
        value_1: u32,
        value_2: u32,
    ) -> u32;
}

static NEXT_TRACE_ID: AtomicU32 = AtomicU32::new(1);

#[repr(u32)]
#[derive(Clone, Copy)]
pub enum WasiBoundaryStage { /* exact Task 1 values 1..=23 */ }

pub fn next_trace_id() -> u32 {
    NEXT_TRACE_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn trace_boundary(id: u32, stage: WasiBoundaryStage, value_1: u32, value_2: u32) {
    unsafe { host_trace_boundary(id, stage as u32, value_1, value_2); }
}
```

Add `trace_id: u32` to `CargoRequest`. Keep `invoke_cargo(cmd)` as a compatibility wrapper that reserves an ID and calls `invoke_cargo_with_trace_id(cmd, id)`.

- [ ] **Step 4: Bracket FFI ownership transitions**

In `invoke_cargo_with_trace_id`, emit the exact stages around `host_run_cargo`, pointer validation, `to_vec`, each `host_free_memory` phase, and final return. Length values use checked `u32` conversion with `u32::MAX` saturation for observation only.

Use an unwind guard whose `Drop` emits `ScopeUnwind` unless `complete()` is called before normal return. Put the originating enter-stage discriminant in `value_1`, so concurrent unwind records remain attributable. Trace failure never changes the underlying result.

- [ ] **Step 5: Bracket metadata and workspace tasks**

Reserve one ID in `ProjectWorkspace::load` before spawning the Cargo metadata child. Pass it into a new `FetchMetadata::exec_with_trace_id` method. Emit spawn before/after, and join enter/success/error using that same ID.

Inside `exec_with_trace_id`, bracket invocation, UTF-8/JSON-line extraction, parse, and the existing finished progress call. Emit map/load return stages in `workspace.rs` with the same ID.

Do not change the execution order, error conversion, or returned metadata.

- [ ] **Step 6: Run source and native checks**

Run:

```bash
deno test --no-lock --allow-read scripts/rust_analyzer_boundary_trace_contract_test.ts
cargo test -p toolchain
cargo test -p project-model
cargo fmt --check -p toolchain -p project-model
```

Expected: contracts and available native tests pass. WASI-only code is compiled in Task 3.

- [ ] **Step 7: Commit the clean rust-analyzer worktree**

Inspect status, diff, and recent log. Stage only the three rust-analyzer files and commit:

```bash
git add -- crates/toolchain/src/wasi_cargo.rs crates/project-model/src/cargo_workspace.rs crates/project-model/src/workspace.rs
git commit -m "debug: trace WASI metadata boundaries"
```

Leave the rubrc contract test uncommitted with the other mixed-worktree investigation files.

### Task 3: Build One Instrumented LSP Wasm

**Files:**
- Build: `/tmp/opencode/rust-analyzer-metadata-trace/target/wasm32-wasip1-threads/release/rust-analyzer.wasm`
- Build: `/tmp/opencode/rust-analyzer-metadata-trace/lsp_boundary_opt_3.wasm`
- Replace in isolated rubrc snapshot only: `crates/vfs/lsp_opt.wasm`

**Interfaces:**
- Produces: one optimized instrumented `lsp_opt.wasm` and SHA-256 used by Task 4.
- Consumes: Tasks 1 and 2 matching numeric ABI.

- [ ] **Step 1: Build rust-analyzer for WASI threads**

Run from `/tmp/opencode/rust-analyzer-metadata-trace`:

```bash
export WASI_SDK_PATH=/opt/wasi-sdk
export WASI_SYSROOT="$WASI_SDK_PATH/share/wasi-sysroot"
export CC_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/clang"
export CXX_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/clang++"
export AR_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/llvm-ar"
export CFLAGS_wasm32_wasip1_threads="--target=wasm32-wasip1-threads --sysroot=$WASI_SYSROOT -pthread"
export CXXFLAGS_wasm32_wasip1_threads="--target=wasm32-wasip1-threads --sysroot=$WASI_SYSROOT -pthread"
RUSTFLAGS='-Cpanic=unwind -Cllvm-args=-wasm-use-legacy-eh=false' \
  cargo +nightly build -r --bin rust-analyzer --target wasm32-wasip1-threads -Zbuild-std
```

Expected: exit 0 and `rust-analyzer.wasm` exists.

- [ ] **Step 2: Optimize exactly three passes**

Run:

```bash
wasm-opt -Oz target/wasm32-wasip1-threads/release/rust-analyzer.wasm -o lsp_boundary_opt_1.wasm
wasm-opt -Oz lsp_boundary_opt_1.wasm -o lsp_boundary_opt_2.wasm
wasm-opt -Oz lsp_boundary_opt_2.wasm -o lsp_boundary_opt_3.wasm
sha256sum lsp_boundary_opt_3.wasm
```

Record size and hash.

- [ ] **Step 3: Create an isolated rubrc experiment snapshot**

Create `/tmp/opencode/rubrc-ra-boundary-run` from the current rubrc worktree, excluding `.git`, `target`, `dist`, and `node_modules`; symlink root and page dependencies. Copy `lsp_boundary_opt_3.wasm` to snapshot `crates/vfs/lsp_opt.wasm`.

In the snapshot only, point `.cargo/config.toml` at `/tmp/opencode/wasi-virt-layer-ra-stall/wasi_virt_layer`. Record the copied `crates/vfs/lsp_opt.wasm` hash before the VFS build.

- [ ] **Step 4: Build the combined debug VFS**

Run from the snapshot:

```bash
bun run vfs:build-debug
sha256sum page/src/worker_process/vfs_bindings/vfs.core.wasm crates/vfs/lsp_opt.wasm
```

Expected: build succeeds, generated bindings are internally consistent, and the instrumented LSP hash still matches both Step 2 and the pre-build snapshot hash. If `lsp_opt.wasm` changes, stop and investigate the build pipeline before running diagnostics.

- [ ] **Step 5: Verify source contracts and Deno startup**

Run:

```bash
deno test --no-lock --allow-read scripts/rust_analyzer_boundary_trace_contract_test.ts scripts/vfs_debug_trace_contract_test.ts
deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts
```

Expected: Deno diagnostics pass and include all planned metadata/workspace return stages with `ra_boundary_dropped=0`. If not, stop before browser testing.

### Task 4: Controlled Browser Boundary And Experimental Fix

**Files:**
- Create: `/home/oligami/projects/rubrc/.git/worktrees/rust-analyzer-diagnostics/sdd/rust-analyzer-wasi-boundary-result.md`
- Modify in isolated snapshot only: observation timeout configuration and, if justified, one candidate implementation.

**Interfaces:**
- Consumes: Task 3 frozen combined Wasm and boundary traces.
- Produces: first missing browser stage or verified experimental fix evidence.

- [ ] **Step 1: Freeze the experiment artifacts**

Record SHA-256 of `lsp_opt.wasm`, `vfs.core.wasm`, Task 1 owned diff, and rust-analyzer instrumentation commit. Do not rebuild after this point.

- [ ] **Step 2: Run one browser observation**

In the isolated snapshot only set `STARTUP_TIMEOUT_MS=300000` and Puppeteer `protocolTimeout=360000`. Run with an outer timeout of at least 720 seconds:

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome bun run test:lsp-browser
```

Expected control: diagnostics still time out after 300,000 ms, all four correlated host calls return, and boundary events remain bounded with `ra_boundary_dropped=0`.

- [ ] **Step 3: Compare stage sets by RA ID**

For every RA ID, tabulate stages 1 through 23 for Deno and browser. Identify the last common stage and first browser-missing stage. Do not infer from output order or fill missing events from global snapshots.

- [ ] **Step 4: Test one supported hypothesis if available**

If the trace isolates one code boundary and a one-behavior candidate exists, write a failing focused test or source contract, apply that one change in a second isolated snapshot, rebuild once, and run Deno then browser.

If browser passes, run the required sequence with identical harness settings:

```text
control failure -> candidate pass -> control failure -> candidate pass
```

If either state varies, run at least three isolated trials per state and report rates. Never stack a second candidate on a failed first candidate.

- [ ] **Step 5: Write and adversarially review the result**

The report includes commands, hashes, durations, stage tables, dropped counts, WebShell evidence, experimental changes, and the narrowest supported cause statement. Obtain an adversarial review focused on observer effects and alternate waiters. Resolve Critical/Major gaps before concluding.

- [ ] **Step 6: Preserve workspaces**

Remove only disposable experiment snapshots after logs and hashes are retained. Keep both source worktrees and branches unless the user explicitly chooses integration or cleanup.
