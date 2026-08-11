# Rust Analyzer Minimal Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing raw `lsp_opt.wasm` with a new `browser_wasi_shim-threads` harness and prove it publishes diagnostics for a minimal local Cargo workspace.

**Architecture:** A Deno test owns an in-memory WASI filesystem and parsed LSP output. A dedicated worker instantiates the unchanged rust-analyzer Wasm, while a separate thread worker supplies `wasi.thread-spawn`. Stdin reads and rust-analyzer process requests are forwarded through the shim's Promise-capable host callback; this lets the package block only the Wasm worker while the host supplies LSP input or runs local `cargo`/`rustc`.

**Tech Stack:** Deno, TypeScript, `@bjorn3/browser_wasi_shim`, `@oligami/browser_wasi_shim-threads`, local Cargo, raw `crates/vfs/lsp_opt.wasm`.

## Global Constraints

- Do not modify rust-analyzer source or `crates/vfs/lsp_opt.wasm`.
- Do not use the existing VFS composition, browser UI, or existing LSP harnesses.
- Forward `host_run_cargo` requests to local `cargo` or `rustc`; do not use embedded Cargo or rustc Wasm.
- Keep this as a one-shot smoke test: success is an initialize response followed by non-empty diagnostics.
- Do not add explicit Atomics or SharedArrayBuffer orchestration outside `browser_wasi_shim-threads` setup required by its public API.

---

### Task 1: Independent Rust Analyzer Smoke Harness

**Files:**
- Create: `scripts/rust_analyzer_minimal/Cargo.toml`
- Create: `scripts/rust_analyzer_minimal/src/main.rs`
- Create: `scripts/rust_analyzer_minimal/lsp_stream.ts`
- Create: `scripts/rust_analyzer_minimal/main_worker.ts`
- Create: `scripts/rust_analyzer_minimal/thread_worker.ts`
- Create: `scripts/rust_analyzer_minimal/background_worker.ts`
- Create: `scripts/rust_analyzer_minimal/smoke_test.ts`

**Interfaces:**
- `LspInputQueue.push(message)` resolves pending `lspStdinRead` host callbacks with Content-Length framed JSON-RPC bytes.
- `LspOutputFd.waitFor(predicate, timeoutMs)` resolves with the first parsed JSON-RPC message matching the predicate.
- `main_worker.ts` consumes a `WASIFarmRefObject`, compiled module, imported memory, and worker URLs, then starts `_start`.
- `thread_worker.ts` supplies the two `__wasip1_vfs-host` stubs to every spawned rust-analyzer thread.
- The farm `unknown_fn` callback executes requested local `cargo`/`rustc` commands and returns stdout, stderr, and status to the calling worker.
- The main worker overrides WASI `fd_read` only for fd 0 and uses `animal.call_unknown_fn` to wait for the host input queue; all other fds use the package implementation.

- [ ] **Step 1: Add the protocol regression test first**

Create `lsp_stream.ts` with queue-backed input and buffered Content-Length output descriptors, then add Deno tests in the same file covering split headers, split bodies, and multiple messages in one write.

- [ ] **Step 2: Verify the protocol tests fail before implementation**

Run: `deno test --no-lock --allow-read scripts/rust_analyzer_minimal/lsp_stream.ts`

Expected: FAIL because the descriptor methods are not implemented.

- [ ] **Step 3: Implement the minimum descriptors**

Implement only the async host input queue, framed output parser, and predicate waiters needed by the smoke test.

- [ ] **Step 4: Verify protocol tests pass**

Run: `deno test --no-lock --allow-read scripts/rust_analyzer_minimal/lsp_stream.ts`

Expected: all protocol tests pass.

- [ ] **Step 5: Add the unchanged raw-Wasm worker setup**

Instantiate imports under `wasi_snapshot_preview1`, `wasi`, `env`, and `__wasip1_vfs-host`. `host_run_cargo` must decode the request, route it through `animal.call_unknown_fn`, and copy local command stdout/stderr into a smoke-only reserved region of the imported memory. `host_free_memory` is a no-op for this one-shot harness.

- [ ] **Step 6: Add and run the one-shot smoke test**

Run local `cargo metadata --no-deps --format-version 1`, mirror the fixture into a `PreopenDirectory`, send `initialize`, `initialized`, and `didOpen`, then assert an initialize response and non-empty `textDocument/publishDiagnostics` for `main.rs`.

Run: `deno test --no-lock -A scripts/rust_analyzer_minimal/smoke_test.ts`

Expected: one passing smoke test, at least one local `rustc`/`cargo` call, and no embedded tool invocation.

- [ ] **Step 7: Verify formatting without touching unrelated files**

Run: `deno fmt --check scripts/rust_analyzer_minimal`

Expected: all new files are formatted.
