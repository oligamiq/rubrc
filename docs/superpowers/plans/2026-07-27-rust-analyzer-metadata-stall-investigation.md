# Rust-Analyzer Metadata Stall Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the exact browser-only wait state that prevents embedded Cargo from returning during rust-analyzer project metadata loading.

**Architecture:** Add feature-gated, atomic lifecycle counters and a snapshot API to the adjacent `wasi_virt_layer` worktree. Rubrc records low-volume Cargo, child, pipe, and host-call boundaries in its existing debug capture, exposes a watchdog snapshot through the existing component debug ABI, and uses one shared TypeScript drain helper in the passing Deno path and failing browser path. The final comparison is causal and state-based, not a total ordering of concurrent events.

**Tech Stack:** Rust 2024, WebAssembly/WASI, `wasi_virt_layer`, WIT component bindings, TypeScript/Deno, Puppeteer, Bun/Vite.

## Global Constraints

- Rubrc worktree: `/home/oligami/projects/rubrc/.worktrees/rust-analyzer-diagnostics`.
- `wasi_virt_layer` worktree: `/home/oligami/projects/rubrc/.worktrees/wasi_virt_layer/wasi_virt_layer`.
- `.cargo/config.toml` already patches crates.io `wasi_virt_layer` to that adjacent worktree; do not edit registry caches.
- Do not modify Cargo, rustc, rust-analyzer, or browser shim packages.
- All new `wasi_virt_layer` counters and snapshot APIs must be gated by `trace-thread`; non-trace builds must retain their current fields and hot paths.
- Detailed rubrc capture is active only when `VFS_DEBUG_TRACE=1` and remains bounded to 64 KiB.
- Do not manually edit generated files under `page/src/worker_process/vfs_bindings/`; regenerate them with `bun run vfs:build-debug`.
- Never stage `deno.lock`, `crates/vfs/expanded.rs`, `diff.patch`, or unrelated dirty files.
- `crates/vfs/src/lib.rs`, browser worker files, and diagnostics scripts already contain user changes. Do not commit a mixed file unless the intended hunks can be isolated and reviewed without staging existing work.
- Treat line ranges as navigation hints only. Locate semantic anchors before each patch and preserve surrounding dirty hunks.
- One experimental variable per browser/Deno comparison. Keep `VFS_THREADS=8` in both paths.

---

### Task 1: Trace-Only Virtual Thread Pool Snapshot

**Files:**
- Modify: `/home/oligami/projects/rubrc/.worktrees/wasi_virt_layer/wasi_virt_layer/src/wasi/thread.rs:264-399,429-682,708-953`

**Interfaces:**
- Produces: `VirtualThreadPoolTraceSnapshot` with `capacity`, `worker_count`, `queued_task_count`, `in_flight_runs`, `run_enqueued`, `run_started`, `run_completed`, `add_thread_requested`, `add_thread_completed`, `add_thread_disconnected`, `terminate_requested`, `terminate_completed`, and `terminate_disconnected`.
- Produces: `VirtualThreadPool::trace_snapshot(&self) -> VirtualThreadPoolTraceSnapshot`, available only with `trace-thread`.
- Consumes: existing `VirtualThreadPool::capacity()`, `worker_count()`, `queued_task_count()`, `in_flight_runs`, `VirtualThreadPoolMessage`, and completion send results.

- [ ] **Step 1: Write focused failing unit tests**

Inside `src/wasi/thread.rs`'s existing test module, add a trace-only test that initializes a pool, snapshots it, runs one blocked task, and verifies counter transitions without relying on event order:

```rust
#[cfg(feature = "trace-thread")]
#[test]
fn trace_snapshot_counts_run_lifecycle() {
    let pool = unsafe { VirtualThreadPool::<TestThreadAccessor>::new_const(1) };
    unsafe { pool.init_with_capacity_and_wait(1) };
    let initial = pool.trace_snapshot();
    assert_eq!(initial.run_enqueued, 0);
    assert_eq!(initial.run_started, 0);
    assert_eq!(initial.run_completed, 0);

    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
    let runner = test_runner(move || {
        started_tx.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    let thread_id = pool.new_thread(TestThreadAccessor, runner);
    assert!(thread_id.is_some());
    started_rx.recv().unwrap();

    let active = pool.trace_snapshot();
    assert_eq!(active.run_enqueued, 1);
    assert_eq!(active.run_started, 1);
    assert_eq!(active.run_completed, 0);
    assert_eq!(active.in_flight_runs, 1);

    release_tx.send(()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while pool.trace_snapshot().run_completed == 0 && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    let complete = pool.trace_snapshot();
    assert_eq!(complete.run_completed, 1);
    assert_eq!(complete.in_flight_runs, 0);
}
```

Reuse the existing test accessor name from the module if it differs from `TestThreadAccessor`; do not create a second mock accessor.

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
cargo nextest run -r -p wasi_virt_layer -F trace-thread trace_snapshot_counts_run_lifecycle
```

Expected: compile failure because `trace_snapshot()` and the snapshot counter fields do not exist.

- [ ] **Step 3: Add trace-only counters and snapshot type**

Add a trace-only counter block near `InFlightRunGuard`:

```rust
#[cfg(feature = "trace-thread")]
#[derive(Default)]
struct VirtualThreadPoolTraceCounters {
    run_enqueued: AtomicUsize,
    run_started: AtomicUsize,
    run_completed: AtomicUsize,
    add_thread_requested: AtomicUsize,
    add_thread_completed: AtomicUsize,
    add_thread_disconnected: AtomicUsize,
    terminate_requested: AtomicUsize,
    terminate_completed: AtomicUsize,
    terminate_disconnected: AtomicUsize,
}

#[cfg(feature = "trace-thread")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VirtualThreadPoolTraceSnapshot {
    pub capacity: usize,
    pub worker_count: usize,
    pub queued_task_count: Option<usize>,
    pub in_flight_runs: usize,
    pub run_enqueued: usize,
    pub run_started: usize,
    pub run_completed: usize,
    pub add_thread_requested: usize,
    pub add_thread_completed: usize,
    pub add_thread_disconnected: usize,
    pub terminate_requested: usize,
    pub terminate_completed: usize,
    pub terminate_disconnected: usize,
}
```

Store the counters in an `UnsafeOnceCell<Arc<VirtualThreadPoolTraceCounters>>` field under `#[cfg(feature = "trace-thread")]`, initialize it beside `in_flight_runs`, and pass an `Arc` only in trace builds through `Run`, `AddThread`, and `Terminate` messages. Increment requested/enqueued counters immediately before the existing send and started counters immediately after dequeue selects the variant. Create a trace-only RAII guard at execution start that increments `run_completed` on drop, including unwind paths. Use `Ordering::SeqCst`; the stronger operations exist only in trace builds. Classify completion failures by matching `std::sync::mpsc::TrySendError::Disconnected(_)` and `flume::SendError(_)`; do not retry, block, or alter existing return handling.

Implement:

```rust
#[cfg(feature = "trace-thread")]
pub fn trace_snapshot(&self) -> VirtualThreadPoolTraceSnapshot {
    let counters = unsafe { self.trace_counters.get() };
    // Read causal descendants before ancestors. Monotonic SeqCst counters then
    // cannot produce completed > started or started > enqueued in one snapshot.
    let run_completed = counters.run_completed.load(Ordering::SeqCst);
    let run_started = counters.run_started.load(Ordering::SeqCst);
    let run_enqueued = counters.run_enqueued.load(Ordering::SeqCst);
    let add_thread_completed = counters.add_thread_completed.load(Ordering::SeqCst);
    let add_thread_disconnected = counters.add_thread_disconnected.load(Ordering::SeqCst);
    let add_thread_requested = counters.add_thread_requested.load(Ordering::SeqCst);
    let terminate_completed = counters.terminate_completed.load(Ordering::SeqCst);
    let terminate_disconnected = counters.terminate_disconnected.load(Ordering::SeqCst);
    let terminate_requested = counters.terminate_requested.load(Ordering::SeqCst);
    VirtualThreadPoolTraceSnapshot {
        capacity: self.capacity(),
        worker_count: self.worker_count(),
        queued_task_count: self.queued_task_count(),
        in_flight_runs: unsafe { self.in_flight_runs.get() }
            .as_ref()
            .load(Ordering::SeqCst),
        run_enqueued,
        run_started,
        run_completed,
        add_thread_requested,
        add_thread_completed,
        add_thread_disconnected,
        terminate_requested,
        terminate_completed,
        terminate_disconnected,
    }
}
```

- [ ] **Step 4: Verify focused and repository checks**

Run from `/home/oligami/projects/rubrc/.worktrees/wasi_virt_layer/wasi_virt_layer`:

```bash
cargo nextest run -r -p wasi_virt_layer -F trace-thread thread::tests
cargo clippy -p wasi_virt_layer --all-targets --all-features -- -D warnings
cargo fmt --check
```

Expected: all pass. Confirm a build without `trace-thread` still passes with `cargo check -r -p wasi_virt_layer --no-default-features -F threads,own-memory,dynamic-fs`.

- [ ] **Step 5: Review and commit the clean external repository**

Run `git status --short`, `git diff`, and `git log --oneline -10` in the `wasi_virt_layer` worktree. Stage only `src/wasi/thread.rs`, then commit:

```bash
git add -- src/wasi/thread.rs
git commit -m "feat(thread): expose trace lifecycle snapshot"
```

### Task 2: Bounded Rubrc Debug State And Snapshot ABI

**Files:**
- Create: `crates/vfs/src/debug_state.rs`
- Modify: `crates/vfs/src/lib.rs:43-45,88-318,335-342,630-654,1552-1560,2726-2829`
- Modify: `crates/vfs/wit/vfs-host.wit:49-56`
- Test: `crates/vfs/src/debug_state.rs` (`#[cfg(test)]` tests compiled standalone)
- Regenerate: `page/src/worker_process/vfs_bindings/` via build command only

**Interfaces:**
- Produces: pure-`std` `DebugState::push_event`, `push_snapshot`, lifecycle setters, `drain`, and `snapshot_line`, with a 64 KiB event limit and dropped-event count.
- Produces: component export `debug-capture-wait-snapshot: func()`.
- Consumes: `THREAD_POOL.trace_snapshot()` from Task 1 when feature `debugging` is enabled.

- [ ] **Step 1: Add standalone RED tests for bounded capture and state snapshots**

Create `crates/vfs/src/debug_state.rs` with tests first. Define the expected interface in the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_is_bounded_and_counts_dropped_events() {
        let mut state = DebugState::new(32);
        state.push_event("first");
        state.push_event("x".repeat(64).as_str());
        assert!(state.buffered_len() <= 32);
        assert_eq!(state.dropped_events(), 1);
        assert!(String::from_utf8(state.drain(32)).unwrap().contains("first"));
    }

    #[test]
    fn snapshot_reports_outstanding_lifecycle_state() {
        let mut state = DebugState::new(1024);
        state.cargo_enter(7);
        state.rustc_enter(11);
        state.set_pipe_state(11, PipeKind::Stdout, 24, false);
        state.set_wait("cargo-main");
        let snapshot = state.snapshot_line(ThreadPoolState {
            capacity: 14,
            worker_count: 15,
            queued_tasks: 0,
            in_flight_runs: 1,
            run_enqueued: 4,
            run_started: 4,
            run_completed: 4,
            completion_disconnected: 1,
        });
        assert!(snapshot.contains("cargo=7"));
        assert!(snapshot.contains("rustc=11"));
        assert!(snapshot.contains("stdout_bytes=24"));
        assert!(snapshot.contains("wait=cargo-main"));
        assert!(snapshot.contains("in_flight=1"));
    }

    #[test]
    fn priority_snapshot_evicts_old_events_instead_of_being_dropped() {
        let mut state = DebugState::new(64);
        state.push_event("old-one");
        state.push_event("old-two");
        state.push_snapshot("snapshot wait=cargo-main");
        let output = String::from_utf8(state.drain(64)).unwrap();
        assert!(output.contains("snapshot wait=cargo-main"));
        assert!(state.dropped_events() > 0);
    }
}
```

- [ ] **Step 2: Run standalone tests to verify RED**

Run:

```bash
rustc --edition=2024 --test crates/vfs/src/debug_state.rs -o /tmp/opencode/vfs_debug_state_test
```

Expected: compile failure because `DebugState`, `PipeKind`, and `ThreadPoolState` are not implemented.

- [ ] **Step 3: Implement the minimal fixed-size debug state**

Keep this module on `std` only so its tests remain valid under the standalone `rustc --test` command. Define the local `ThreadPoolState` adapter in this module; `lib.rs` converts `VirtualThreadPoolTraceSnapshot` into it instead of coupling the standalone module to `wasi_virt_layer`.

Use `VecDeque<String>` and track encoded byte length. `push_event` appends `\r\n[vfs-debug] {event}\r\n`; if the complete line would exceed the configured limit, increment `dropped_events` and retain existing lines. `push_snapshot` is priority data: evict the oldest complete event lines, incrementing `dropped_events` for each eviction, until the snapshot fits, then append it. `drain(max_bytes)` removes only complete lines whose combined encoded size is at most `max_bytes`. Store only active Cargo/rustc invocation IDs, pipe byte counts/EOF flags, and the current named wait. Do not store command output or source text.

At 64 KiB, preserving earlier lifecycle boundaries is more useful than evicting them; the current state is always available through `snapshot_line` even after event overflow.

- [ ] **Step 4: Integrate state into existing debug exports and lifecycle boundaries**

Replace `DEBUG_TERMINAL_OUTPUT` with `LazyLock<parking_lot::Mutex<DebugState>>`, preserving the existing nonblocking `debug_terminal_output_len` and draining `debug_read_terminal_output` behavior. Keep `DEBUG_TERMINAL_CAPTURE` as the fast disabled-path gate.

Assign correlation IDs with one `AtomicUsize` using `fetch_add(Ordering::Relaxed)` only when debug capture is enabled. Add paired events and state transitions around:

```text
run_cargo: cargo:enter -> wait=cargo-main -> cargo:return
run_rustc_invocation: rustc:enter -> stdio:installed -> run callback -> stdio:drained -> rustc:return
ChildProcessStdioGuard::drop: stdio:restored
host_run_cargo: host-cargo:request -> host-cargo:response status={status}
THREAD_POOL initialization/capacity flush: pool:init/capacity/flush-return
```

Add to `crates/vfs/wit/vfs-host.wit`:

```wit
export debug-capture-wait-snapshot: func();
```

Implement the export so it writes one priority `snapshot ...` event containing the `DebugState` lifecycle fields and, under `#[cfg(feature = "debugging")]`, all fields from `THREAD_POOL.trace_snapshot()`. `crates/vfs/Cargo.toml` already maps `debugging` to `wasi_virt_layer/trace`, which includes `trace-thread`; verify that mapping remains unchanged rather than adding a duplicate dependency feature. In non-debugging builds, emit `thread_pool=trace-disabled` without calling an unavailable API.

- [ ] **Step 5: Verify tests and regenerate bindings**

Run:

```bash
rustc --edition=2024 --test crates/vfs/src/debug_state.rs -o /tmp/opencode/vfs_debug_state_test
/tmp/opencode/vfs_debug_state_test
bun run vfs:build-debug
deno run --no-lock -A scripts/vfs_debug_cargo_run_test.ts
deno test --no-lock --allow-read scripts/vfs_host_pointer_test.ts
```

Expected: standalone tests pass; generated `Root` includes `debugCaptureWaitSnapshot(): void`; Cargo run test still returns to both prompts and includes paired lifecycle events.

- [ ] **Step 6: Check generated and dirty-file scope without committing mixed hunks**

Run `git diff --check`, scoped formatting, and inspect diffs for `debug_state.rs`, `lib.rs`, the WIT file, and generated bindings. Do not stage `lib.rs` or generated files while they contain pre-existing user changes. Record the intended file/hunk list in the SDD ledger for later clean extraction.

### Task 3: Shared Trace Drain In Deno And Browser Paths

**Files:**
- Create: `page/src/vfs_debug_trace.ts`
- Create: `page/src/vfs_debug_trace_test.ts`
- Modify: `scripts/vfs_lsp_diagnostics_worker.ts:27-118,121-177,233-246`
- Modify: `page/src/worker_process/util_cmd.ts:387-507`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs:40-83`

**Interfaces:**
- Produces: `drainVfsDebugTrace(root, memory) -> string`.
- Produces: `startVfsDebugTracePump({ root, memory, emit, intervalMs, snapshotEvery }) -> { stop(): void; captureSnapshot(): string }`.
- Consumes: generated `Root` debug exports from Task 2 and shared Wasm memory.

- [ ] **Step 1: Write RED tests for memory-safe draining and periodic snapshots**

Create `page/src/vfs_debug_trace_test.ts` with a fake root and shared one-page core memory. Verify that the helper allocates, reads exactly the returned byte count, frees in `finally`, decodes text, and calls `debugCaptureWaitSnapshot` on the requested interval. Include a fake `debugReadTerminalOutput` that returns zero once to prove lock contention is treated as an empty sample rather than completion. This project explicitly passes `sharedMemory.memory` into `custom_instantiate`; the helper accesses that same core memory, not an encapsulated component-model memory. Keep `scripts/vfs_host_pointer_test.ts` as the production-pointer verification.

The core assertion is:

```ts
const text = drainVfsDebugTrace(root, memory);
assertEquals(text, "snapshot cargo=7 wait=cargo-main");
assertEquals(root.freeCalls, [{ ptr: 64, len: encoded.length }]);
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
deno test --no-lock --allow-read page/src/vfs_debug_trace_test.ts
```

Expected: module-not-found failure for `page/src/vfs_debug_trace.ts`.

- [ ] **Step 3: Implement the shared drain helper**

Implement `drainVfsDebugTrace` with this control flow:

```ts
const len = root.debugTerminalOutputLen();
if (len === 0) return "";
const ptr = root.allocBuf(len);
try {
  const read = root.debugReadTerminalOutput(ptr, len);
  return read === 0
    ? ""
    : new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, read).slice());
} finally {
  root.freeBuf(ptr, len);
}
```

`startVfsDebugTracePump` calls `root.debugSetTerminalCapture(true)` once, drains every 250 ms, triggers a snapshot every 20 drains, emits non-empty chunks, and performs one final snapshot/drain in `stop()`. It must clear its timer exactly once.

- [ ] **Step 4: Integrate the passing Deno path**

Add `VFS_DEBUG_TRACE=1` to the `WASIFarmAnimal` environment in `vfs_lsp_diagnostics_worker.ts`. Start the pump immediately after `custom_instantiate`, emit chunks into a local `trace: string[]`, and include the joined trace in both success and error worker results. Stop it in `finally` before posting the result.

Replace the existing ad-hoc `hostRunCargo request/response` logs with correlated lines appended to the same trace:

```text
host-call id={n} name=hostRunCargo phase=request
host-call id={n} name=hostRunCargo phase=response
host-call id={n} name=hostRunCargo phase=reject error={ErrorName}
```

Do not serialize request payloads.

- [ ] **Step 5: Integrate the browser path**

In `util_cmd.ts`, start the same pump only when `import.meta.env.VITE_RUBRC_LSP_TEST === "1"`. Emit each chunk with `console.debug("[vfs-stall-trace]", chunk)` and wrap `animal.call_unknown_fn` with the same host-call phase lines. Preserve synchronous return values and Promise behavior; use `Promise.resolve(result).then(...)` only when the returned value is already promise-like.

In `lsp_browser_diagnostics_test.mjs`, collect all console messages beginning with `[vfs-stall-trace]` in a `traceChunks` array. Include `traceChunks.join("")` in readiness and quiescence failure state instead of relying on `document.body.innerText.slice(-4_000)` for VFS evidence.

- [ ] **Step 6: Verify helper, contracts, and build**

Run:

```bash
deno test --no-lock --allow-read page/src/vfs_debug_trace_test.ts scripts/lsp_browser_diagnostics_contract_test.ts
bun run --cwd page build
```

Expected: all tests pass and Vite builds without changing production behavior when `VITE_RUBRC_LSP_TEST` is absent.

- [ ] **Step 7: Review dirty-file scope**

Inspect scoped diffs and run `git diff --check`. Stage the two new helper files only if they contain no unrelated content. Do not stage the three modified dirty integration files until their intended hunks are separated from existing user changes.

### Task 4: Controlled Causal Comparison And Root-Cause Report

**Files:**
- Create: `.git/worktrees/rust-analyzer-diagnostics/sdd/rust-analyzer-metadata-stall-root-cause.md` (outside the commit graph)
- Modify after diagnosis only: temporary high-volume trace points from Tasks 1-3

**Interfaces:**
- Consumes: `VirtualThreadPoolTraceSnapshot`, bounded rubrc lifecycle trace, Deno diagnostics result trace, and browser failure trace.
- Produces: one evidence-backed classification and the first divergent lifecycle phase.

- [ ] **Step 1: Build the same debug VFS once for both paths**

Run from the rubrc worktree:

```bash
bun run vfs:build-debug
```

Record the SHA-256 of `page/src/worker_process/vfs_bindings/vfs.core.wasm`. Do not rebuild between the Deno and browser runs.

- [ ] **Step 2: Run the passing Deno control**

Run:

```bash
deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts
```

Expected: exit 0 with initial valid diagnostics, invalid diagnostics after change, valid diagnostics after correction, and a final trace snapshot immediately before Cargo/project loading completes.

- [ ] **Step 3: Run the failing browser path with an isolated 300-second observation window**

Copy the worktree to `/tmp/opencode/rubrc-ra-stall-browser` excluding `.git`, `target`, `dist`, and `node_modules`; symlink the existing dependency directories. In the snapshot only, change `STARTUP_TIMEOUT_MS` from `15000` to `300000`. Make no production change. Run once:

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome bun run test:lsp-browser
```

Expected before the root-cause fix: exit 1 at browser readiness, but with a complete bounded lifecycle trace and final wait snapshot.

- [ ] **Step 4: Compare causal state, not linear event order**

For each correlated Cargo/rustc/child invocation, tabulate enter, host request, host response, pipe EOF, child reap, run completion, and Cargo return. Compare final pool snapshot fields. The report must identify exactly one earliest incomplete phase and include the relevant IDs and counters.

Use these classification rules:

```text
host request without response/reject => rubrc host bridge wait
active rustc/child or pipe without EOF/reap => child or pipe lifecycle wait
run_enqueued > run_started and queued_task_count > 0 => queued job not scheduled
add/terminate disconnected > 0 with matching missing completion => completion channel loss
all child/pipe/host states complete and all run/completion counters balanced but Cargo active => Cargo-internal wait
```

Do not classify from worker count alone.

- [ ] **Step 5: Write and adversarially review the root-cause report**

Write the exact commands, Wasm hash, last shared causal phase, first divergent phase, snapshot fields, and ownership boundary to the SDD report. Obtain an adversarial review focused on concurrency and alternative explanations. If the review identifies an unobserved state that could change the classification, add only the missing observation and repeat one controlled pair.

- [ ] **Step 6: Remove temporary high-volume instrumentation**

Retain the trace-only snapshot API and concise state dump only if they remain useful and their tests pass. Remove per-event logging that is no longer needed.

Re-run from `/home/oligami/projects/rubrc/.worktrees/wasi_virt_layer/wasi_virt_layer`:

```bash
cargo nextest run -r -p wasi_virt_layer -F trace-thread thread::tests
cargo clippy -p wasi_virt_layer --all-targets --all-features -- -D warnings
cargo fmt --check
```

Re-run from `/home/oligami/projects/rubrc/.worktrees/rust-analyzer-diagnostics`:

```bash
rustc --edition=2024 --test crates/vfs/src/debug_state.rs -o /tmp/opencode/vfs_debug_state_test
/tmp/opencode/vfs_debug_state_test
deno test --no-lock --allow-read page/src/vfs_debug_trace_test.ts scripts/lsp_browser_diagnostics_contract_test.ts scripts/vfs_host_pointer_test.ts
bun run --cwd page build
git diff --check
```

Expected: all commands pass. Report any full browser acceptance failure separately; the investigation deliverable is complete only when the first divergent wait state is established.

## Execution Safety

The external `wasi_virt_layer` repository is clean and may use normal task commits after status/diff/log review. The rubrc worktree is heavily dirty; commits there must contain only newly created files or demonstrably isolated intended hunks. Never use reset, checkout, stash, or broad formatting to obtain a clean state.
