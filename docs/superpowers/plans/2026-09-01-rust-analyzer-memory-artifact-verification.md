# Rust Analyzer Memory Artifact Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the browser runs a VFS artifact containing the 4096-page rust-analyzer reserve, expose enough lifecycle evidence to diagnose an OOM, and measure cold startup and one-edit behavior.

**Architecture:** Add structured VFS debug events around per-target memory reservation and the embedded rust-analyzer entry points. Extend the existing full SquashFS diagnostics integration to require those events from the actual generated `vfs.core.wasm`, then rebuild the artifact and run isolated browser acceptance. Do not increase the shared-memory maximum or change startup admission until the measured 4096-page artifact is tested.

**Tech Stack:** Rust, `wasi_virt_layer` own-memory lowering, Deno tests, WebAssembly shared memory, Vite, Puppeteer/Chrome.

## Global Constraints

- Work in the existing main workspace as previously approved.
- Do not stage or commit files.
- Preserve all unrelated dirty-worktree changes.
- Keep `--own-memory`, the 32,775-page shared-memory maximum, and the staged rust-analyzer startup architecture unchanged.
- Treat `page/src/worker_process/vfs_bindings/vfs.core.wasm` as generated output; modify its source and rebuild it rather than editing the binary.
- Use the existing `VFS_DEBUG_TRACE` collector instead of introducing a second telemetry channel.
- Do not claim the OOM is fixed until the rebuilt artifact passes full diagnostics and browser acceptance.

---

### Task 1: Trace LSP Memory Reservation And Lifecycle

**Files:**
- Modify: `crates/vfs/src/debug_state.rs`
- Modify: `crates/vfs/src/memory_manager.rs`
- Modify: `crates/vfs/src/lib.rs`
- Test: `crates/vfs/src/debug_state.rs`

**Interfaces:**
- Consumes: `crate::debug_trace(message: &str)`, `WasmAccessName::NAME`, `MemoryReserveManager::ensure_once`.
- Produces: structured `memory:target=lsp_opt ...` and `lsp:*` events in the existing debug trace.

- [ ] **Step 1: Add failing lifecycle-event acceptance assertions**

Extend `debug_capture_accepts_only_structured_lifecycle_events` with:

```rust
"memory:target=lsp_opt action=reserve current=64 minimum=4096 requested=4096 result=4096",
"lsp:thread:start",
"lsp:_main:enter",
```

- [ ] **Step 2: Run the focused Rust test and confirm RED**

Run:

```bash
cargo test -p vfs debug_capture_accepts_only_structured_lifecycle_events
```

Expected: FAIL because `is_lifecycle_event` does not accept the new structured prefixes.

- [ ] **Step 3: Accept only structured memory and LSP events**

Extend `is_lifecycle_event` with prefix checks for `memory:target=` and `lsp:`. Do not accept arbitrary command lines or document text.

- [ ] **Step 4: Emit reserve decisions**

In `MemoryReserveManager::ensure_once`, emit one event when the target already meets its minimum and one event after `memory_reserve`:

```text
memory:target=<name> action=skip current=<pages> minimum=<pages>
memory:target=<name> action=reserve current=<pages> minimum=<pages> requested=<pages> result=<value>
```

The existing warning remains the user-visible failure path.

- [ ] **Step 5: Emit embedded analyzer lifecycle boundaries**

Around the LSP thread and `_reset`, `_start`, `_main` calls, emit enter/return markers. If execution traps or aborts, the last retained marker identifies the failed boundary without changing control flow.

- [ ] **Step 6: Run focused Rust tests and confirm GREEN**

Run:

```bash
cargo test -p vfs debug_capture_accepts_only_structured_lifecycle_events
cargo test -p vfs lsp_reserve_covers_complete_rust_src_diagnostics_peak
```

Expected: both PASS.

---

### Task 2: Require 4096 Pages From The Actual Artifact

**Files:**
- Modify: `scripts/vfs_lsp_diagnostics_test.ts`
- Generated: `page/src/worker_process/vfs_bindings/vfs.core.wasm`
- Generated bindings as produced by: `scripts/copy_vfs_bindings.mjs`

**Interfaces:**
- Consumes: `result.trace` from `scripts/vfs_lsp_diagnostics_worker.ts`.
- Produces: an integration failure when the checked-in/generated artifact does not contain the current LSP reserve and lifecycle instrumentation.

- [ ] **Step 1: Add failing artifact trace assertions**

After printing the returned trace, require:

```ts
if (
  !/memory:target=lsp_opt action=reserve current=64 minimum=4096 requested=4096 result=[1-9]\d*/
    .test(result.trace)
) {
  throw new Error("actual VFS artifact did not reserve 4096 LSP pages");
}
if (!result.trace.includes("lsp:_main:enter")) {
  throw new Error("actual VFS artifact did not enter rust-analyzer main");
}
```

- [ ] **Step 2: Run the full diagnostics test and confirm RED**

Run:

```bash
RUBRC_LSP_HOST_CARGO_FOCUSED=1 deno test --no-lock --allow-all scripts/vfs_lsp_diagnostics_test.ts
```

Expected: FAIL on the new trace assertion because the current generated artifact predates the 4096-page source change.

- [ ] **Step 3: Rebuild the VFS development artifact**

Run:

```bash
bun run vfs:build
```

Expected: `vfs.core.wasm` and generated bindings are rebuilt with `--own-memory`, `--vfs-unwind`, debug trace support, and the source `LSP_CONFIG` value of 4096.

- [ ] **Step 4: Confirm artifact provenance**

Compare timestamps and hashes for `crates/vfs/src/memory_manager.rs` and `page/src/worker_process/vfs_bindings/vfs.core.wasm`. The artifact must be newer than the source.

- [ ] **Step 5: Run the full diagnostics test and confirm GREEN**

Run the command from Step 2 again. Expected: diagnostics complete and the trace reports the exact 4096-page reservation plus `lsp:_main:enter`.

---

### Task 3: Measure Browser Cold Start And One Edit

**Files:**
- Verify: `scripts/lsp_browser_diagnostics_test.mjs`
- Verify: `page/src/startup_coordinator.ts`
- Verify: `page/src/rust_analyzer_readiness.ts`

**Interfaces:**
- Consumes: existing startup snapshots, Chrome console messages, VFS debug trace, and generated VFS artifact.
- Produces: measured phase timings and evidence that one edit does not OOM or prevent readiness.

- [ ] **Step 1: Build the browser acceptance bundle**

Run the repository's existing browser diagnostics build path with `VITE_RUBRC_LSP_TEST=1`, preserving the generated VFS artifact.

- [ ] **Step 2: Run an unedited cold start**

Record transitions through `vfs-starting`, `analyzer-initializing`, `sysroots-loading`, `project-activating`, `semantic-warming`, and `ready`. Require completion within the existing 300-second acceptance budget.

- [ ] **Step 3: Run one controlled edit during semantic warming**

Change the mounted Rust model once, then stop editing. Require a current-version diagnostics publication, a successful inlay-hint barrier, and eventual `ready` without an OOM or worker fatal.

- [ ] **Step 4: Classify the result**

- If both runs pass and peak LSP logical pages remain below the 4096-page reservation, retain the current memory values.
- If the rebuilt artifact still OOMs, capture the exact last lifecycle marker and memory event before changing any limit.
- If only the edited run stalls without OOM, investigate readiness generation/deadline handling separately from memory.

---

### Task 4: Final Verification And Review

**Files:**
- Verify all files changed by Tasks 1-3.

- [ ] **Step 1: Run focused tests**

```bash
cargo test -p vfs debug_capture_accepts_only_structured_lifecycle_events
cargo test -p vfs lsp_reserve_covers_complete_rust_src_diagnostics_peak
deno test --no-lock --allow-read page/src/rust_analyzer_readiness_test.ts page/src/rust_lsp_startup_test.ts
```

- [ ] **Step 2: Run actual-artifact and browser regressions**

Run the full SquashFS diagnostics and browser acceptance commands from Tasks 2 and 3.

- [ ] **Step 3: Check formatting and scope**

```bash
cargo fmt --check -p vfs
deno fmt --check scripts/vfs_lsp_diagnostics_test.ts
git diff --check
git status --short
```

- [ ] **Step 4: Review**

Review for memory accounting correctness, trace safety, generated-artifact provenance, and preservation of unrelated worktree changes. Do not stage or commit.
