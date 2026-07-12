# Cargo Info HTTP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WebShell `cargo info dashmap` fetch crates.io metadata and return to the shell prompt without hanging.

**Architecture:** On WASI, Cargo bypasses its HTTP worker/oneshot path and calls the existing synchronous `fetch_wasi` bridge directly. VFS uses a two-pass WIT bridge: async host fetch starts and retains a response, then VFS-owned buffers read metadata and bounded chunks before explicitly ending the response. JavaScript never re-enters Wasm while handling a Wasm callback.

**Tech Stack:** Rust, Cargo HTTP client, WIT component bindings, the existing `call_unknown_fn` transport, TypeScript Fetch API, Deno regression harness.

## Global Constraints

- Preserve native Cargo HTTP worker behavior unchanged.
- Do not expose `cargo_opt` pointers directly to component host callbacks.
- Preserve HTTP status, response headers, and binary body without text decoding.
- Network failures must return an explicit Cargo error instead of hanging.
- Preserve the existing process stdin ABI, Cargo build behavior, and protected untracked files.
- Do not amend, force-push, or create a PR.
- Do not add or directly use `Atomics` or `SharedArrayBuffer`; rely only on the existing `call_unknown_fn` abstraction.

---

### Task 1: Cargo WASI Direct HTTP Request

**Files:**
- Modify: `/home/oligami/projects/cargo/src/cargo/util/network/http_async.rs:99-175,285-347`
- Test: `/home/oligami/projects/cargo/src/cargo/util/network/http_async.rs`

**Interfaces:**
- Consumes: `Client::request_blocking(Request) -> HttpResult<Response>` and `fetch_wasi`.
- Produces: WASI `Client::request(Request)` that resolves on its first poll without an HTTP worker channel; native behavior remains worker-backed.

- [ ] **Step 1: Add a failing cfg-selection test**

Add a small private selector that reports whether the current target uses a worker, compile it under `#[cfg(any(target_os = "wasi", test))]`, and test the intended WASI-direct branch. Also add a source-level assertion or target check proving the WASI `request` body does not send to `self.channel`.

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test -p cargo --lib http_async
```

Expected: the new direct-request contract fails before implementation, or the known native Cargo test baseline fails before tests; record the exact result.

- [ ] **Step 3: Implement target-specific client construction**

On non-WASI, keep the existing MPSC channel and worker thread. On WASI, construct `Client` without spawning `WorkerServer`; keep fields cfg-compatible and avoid an unused receiver that can block a hidden thread.

- [ ] **Step 4: Implement target-specific request dispatch**

In `Client::request`, retain the oneshot path under `#[cfg(not(target_os = "wasi"))]`. Under `#[cfg(target_os = "wasi")]`, return `self.request_blocking(request)` directly from the async function.

- [ ] **Step 5: Verify Cargo source**

Run the focused test as feasible, then the established SDK-backed check:

```bash
WASI_SDK_PATH=/opt/wasi-sdk \
WASI_SYSROOT=/opt/wasi-sdk/share/wasi-sysroot \
CC_wasm32_wasip1_threads=/opt/wasi-sdk/bin/clang \
CXX_wasm32_wasip1_threads=/opt/wasi-sdk/bin/clang++ \
AR_wasm32_wasip1_threads=/opt/wasi-sdk/bin/llvm-ar \
CFLAGS_wasm32_wasip1_threads='--target=wasm32-wasip1-threads --sysroot=/opt/wasi-sdk/share/wasi-sysroot -pthread' \
CXXFLAGS_wasm32_wasip1_threads='--target=wasm32-wasip1-threads --sysroot=/opt/wasi-sdk/share/wasi-sysroot -pthread' \
RUSTFLAGS='-Cpanic=unwind -Cllvm-args=-wasm-use-legacy-eh=false' \
cargo +nightly check --bin cargo --target wasm32-wasip1-threads -Zbuild-std
```

Expected: exit 0 with only existing WASI-port warnings.

---

### Task 2: VFS WIT HTTP Bridge

**Files:**
- Modify: `/home/oligami/projects/rubrc/crates/vfs/wit/vfs-host.wit`
- Modify: `/home/oligami/projects/rubrc/crates/vfs/src/lib.rs:822-837`
- Modify: `/home/oligami/projects/rubrc/crates/vfs-rustc-twice/wit/vfs-host.wit`
- Modify: `/home/oligami/projects/rubrc/crates/vfs-rustc-twice/src/lib.rs:586-600`
- Create: `/home/oligami/projects/rubrc/page/src/worker_process/vfs_bindings/http_import.ts`
- Modify: `/home/oligami/projects/rubrc/page/src/worker_process/vfs_bindings/inst.ts:68-190`
- Test: create `/home/oligami/projects/rubrc/scripts/vfs_http_import_test.ts`

**Interfaces:**
- Consumes: Cargo's existing `wasi_ext_fetch` pointer ABI.
- Produces: WIT `Http` start/read/end bridge returning a request ID, status, lengths, newline-encoded headers, raw body, and explicit error bytes.

- [ ] **Step 1: Write the generated-import adapter RED test**

Create a Deno behavior test for a small `createHttpImports(memory, callUnknownFn)` helper. With a fake memory and callback, verify request-start copies method, URL, headers, and binary body before transport; writes only scalar ID/status/length metadata; each read requests at most 16 KiB for the correct request ID and copies returned bytes into the supplied VFS buffer; and end clears the same request ID. The helper must not accept or call any Wasm export. Also compare the `http` resource declarations in both WIT worlds for exact parity.

- [ ] **Step 2: Run RED**

Run:

```bash
deno test --no-lock -A scripts/vfs_http_import_test.ts
```

Expected: fail because the HTTP import helper does not exist.

- [ ] **Step 3: Extend both WIT worlds identically**

Add an `http` resource to `bridge` with identical functions in both WIT worlds:

- `request-start` accepts VFS-owned method, URL, encoded headers, and body pointers and writes a unique request ID, status, plus header/body/error lengths.
- `response-read-headers`, `response-read-body`, and `response-read-error` accept the request ID and copy the next bounded chunk into a VFS-provided destination.
- `response-end` accepts the request ID and clears only that retained host state.

Return zero for a structurally valid response and nonzero for bridge failure.

- [ ] **Step 4: Implement and install the generated binding adapter**

Implement `createHttpImports` in `http_import.ts`, then install its result as the WIT `Http` resource in `inst.ts`. Read VFS-owned input buffers and call `call_unknown_fn` with `httpRequestStart`. The existing transport may await the host Promise before returning its resolved metadata; do not add asynchronous WIT imports, `Atomics`, or `SharedArrayBuffer`. Store no response bytes in Wasm from this callback; write only scalar request ID/status/length metadata to caller-provided pointers. Implement read functions by requesting at most 16 KiB JSON-safe chunks for that request ID and copying them directly into VFS-provided destinations. Implement request-scoped `response-end` cleanup. Do not call `root.allocBuf` or any other Wasm export from a Wasm-initiated callback.

- [ ] **Step 5: Replace the VFS fetch stub**

In primary VFS, copy Cargo request pointers with `cargo_opt::get_array`, invoke `request-start`, retain its request ID, allocate VFS-owned vectors from returned lengths, fill each vector through request-scoped read calls of at most 16 KiB, and always invoke `response-end` for that ID. Format Cargo's expected response bytes, allocate Cargo-owned output with `wasi_ext_allocate`, and write `out_status`, `out_resp_ptr`, and `out_resp_len` through `cargo_opt::memcpy`.

Keep `vfs-rustc-twice` WIT ABI-compatible; it may return an explicit unsupported error because that crate is not the Cargo host.

- [ ] **Step 6: Verify VFS compilation and bridge tests**

Run:

```bash
deno test --no-lock -A scripts/vfs_http_import_test.ts
cargo check -p vfs
cargo check -p vfs-rustc-twice --target wasm32-wasip1-threads
deno check --no-lock page/src/worker_process/vfs_bindings/http_import.ts
git diff --check
```

Expected: all target-appropriate checks pass.

---

### Task 3: Browser and Deno HTTP Host Handlers

**Files:**
- Create: `/home/oligami/projects/rubrc/lib/src/http_bridge.ts`
- Modify: `/home/oligami/projects/rubrc/page/src/xterm.tsx:325-390`
- Modify: `/home/oligami/projects/rubrc/scripts/vfs_debug_shell.ts`
- Modify: `/home/oligami/projects/rubrc/scripts/vfs_debug_shell_worker.ts` only if response routing requires it
- Test: `/home/oligami/projects/rubrc/scripts/vfs_http_bridge_test.ts`

**Interfaces:**
- Consumes: `httpRequest` unknown-function messages from generated `inst.ts`.
- Produces: a `Map<number, ResponseState>`, request-scoped scalar metadata, and bounded JSON-safe chunks.

- [ ] **Step 1: Write and run the host bridge RED test**

Create a Deno test for a shared `httpRequestStart`/read/end contract using an injected fake `fetch`: verify unique request IDs, two overlapping retained responses without cross-wiring, method, URL, request headers, binary request body, response status, comma-joined repeated response headers, 16 KiB maximum binary chunks, rejected-fetch error chunks, and state cleanup after end. Run it and confirm it fails because the shared handler does not exist.

- [ ] **Step 2: Implement one shared handler**

Implement an HTTP response store in `lib/src/http_bridge.ts`. `requestStart(args, fetchImpl = fetch)` allocates a monotonically increasing request ID, builds a `Headers` object, preserves binary request/response bodies, calls `fetchImpl`, stores encoded headers/body/error in `Map<number, ResponseState>`, and returns only ID plus scalar metadata. Request-scoped read methods return at most 16 KiB as strict-JSON byte arrays and advance independent offsets. `end(id)` clears only that response. Catch exceptions and retain encoded error bytes.

- [ ] **Step 3: Integrate production WebShell**

Add an `httpRequest` branch to the existing `WASIFarm` `unknown_fn` in `page/src/xterm.tsx`, delegating to the shared handler. Preserve download and sysroot handlers unchanged.

- [ ] **Step 4: Integrate debug harness**

Configure `scripts/vfs_debug_shell.ts`'s `WASIFarm` with the same async unknown-function handler so `cargo info` uses real Deno `fetch()`.

- [ ] **Step 5: Verify handler and TypeScript**

Run:

```bash
deno test --no-lock -A scripts/vfs_http_bridge_test.ts
deno check --no-lock scripts/vfs_debug_shell.ts
deno fmt --check lib/src/http_bridge.ts scripts/vfs_http_bridge_test.ts scripts/vfs_debug_shell.ts
```

Expected: all pass.

---

### Task 4: Rebuild and End-to-End Regression

**Files:**
- Create: `/home/oligami/projects/rubrc/scripts/vfs_debug_cargo_info_test.ts`
- Regenerate: `/home/oligami/projects/rubrc/crates/vfs/cargo_opt.wasm`
- Regenerate ignored VFS outputs under `dist/` and `page/src/worker_process/vfs_bindings/`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a browser-compatible Cargo guest where `cargo info dashmap` completes with real crates.io data.

- [ ] **Step 1: Add the command regression**

Create an isolated harness with a fresh in-memory VFS and no host Cargo cache preopen. Run `cargo info dashmap`, reject timeout/network/Cargo errors, require DashMap package metadata, command return, shell prompt return, and at least one invocation of an injected counting wrapper around real `fetch()`. Use the same HTTP unknown-function handler as production.

- [ ] **Step 2: Confirm RED against the old artifact**

Run the two commands separately. Record the first command's expected nonzero timeout result, then run the baseline even though RED failed:

```bash
deno run --no-lock -A scripts/vfs_debug_cargo_info_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts
```

Expected: the new info regression times out after `Updating crates.io index` before rebuilding Cargo/VFS; the existing pipe/build regression remains a passing baseline.

- [ ] **Step 3: Build and install Cargo**

Run the established clean `wasm32-wasip1-threads` Cargo release build from `/home/oligami/projects/cargo`, then optimize its artifact into rubrc:

```bash
WASI_SDK_PATH=/opt/wasi-sdk \
WASI_SYSROOT=/opt/wasi-sdk/share/wasi-sysroot \
CC_wasm32_wasip1_threads=/opt/wasi-sdk/bin/clang \
CXX_wasm32_wasip1_threads=/opt/wasi-sdk/bin/clang++ \
AR_wasm32_wasip1_threads=/opt/wasi-sdk/bin/llvm-ar \
CFLAGS_wasm32_wasip1_threads='--target=wasm32-wasip1-threads --sysroot=/opt/wasi-sdk/share/wasi-sysroot -pthread' \
CXXFLAGS_wasm32_wasip1_threads='--target=wasm32-wasip1-threads --sysroot=/opt/wasi-sdk/share/wasi-sysroot -pthread' \
RUSTFLAGS='-Cpanic=unwind -Cllvm-args=-wasm-use-legacy-eh=false' \
cargo +nightly build -r --bin cargo --target wasm32-wasip1-threads -Zbuild-std

wasm-opt -Oz /home/oligami/projects/cargo/target/wasm32-wasip1-threads/release/cargo.wasm \
  -o /home/oligami/projects/rubrc/crates/vfs/cargo_opt.wasm
```

- [ ] **Step 4: Rebuild and validate VFS**

Before rebuilding, record the SHA-256 of both existing VFS artifacts. Run:

```bash
bun run vfs:build
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
cmp -s dist/vfs.core.wasm page/src/worker_process/vfs_bindings/vfs.core.wasm
```

Expected: all exit 0, the rebuilt files are byte-identical to each other, and their SHA-256 differs from the pre-build artifacts. This proves the checks did not merely validate two stale copies.

- [ ] **Step 5: Run GREEN and build regression**

Run:

```bash
deno run --no-lock -A scripts/vfs_debug_cargo_info_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts
```

Expected: `cargo info dashmap` displays DashMap metadata and returns to the prompt; the isolated Cargo build still compiles, links, reports `Finished dev profile`, and returns successfully.

- [ ] **Step 6: Final review and hygiene**

Run focused tests, final adversarial review, `git diff --check`, and `git status --short` in Cargo, rubrc, and wasi_virt_layer. Commit only the intentional Cargo and rubrc changes; preserve unrelated untracked files.
