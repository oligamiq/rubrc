# Cargo Spawn Stdin ABI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pass Cargo's `ProcessBuilder::stdin` bytes through `wasi_ext_spawn` so `rustc -` probes consume their intended input and `cargo b -j 1` reaches compilation instead of hanging.

**Architecture:** Extend the synchronous guest/host ABI with `stdin_ptr` and `stdin_len`. The patched Cargo guest passes its existing `Option<Vec<u8>>`; the rubrc VFS host copies those bytes from Cargo memory and exposes them through the existing `ChildProcessStdio` virtual stdin while rustc runs synchronously.

**Tech Stack:** Rust, Cargo `ProcessBuilder`, wasm32-wasip1-threads, raw Wasm FFI, wasi_virt_layer, Deno regression harness.

## Global Constraints

- Do not commit, amend, push, or create a PR.
- Preserve `/home/oligami/projects/cargo` untracked files `cargo1.wasm`, `cargo2.wasm`, `cargo3.wasm`, `cargo4.wasm`, and `compile.md`.
- Preserve `/home/oligami/projects/rubrc` untracked files `diff.patch` and `out.wat`.
- Use TDD: the existing `scripts/vfs_debug_cargo_pipe_test.ts` timeout is the end-to-end RED case.
- Keep the spawn operation synchronous; do not introduce process handles or background host tasks.
- Add full stdin behavior only to `crates/vfs`; keep `crates/vfs-rustc-twice` compile-compatible without porting the full child stdio model.

---

### Task 1: Cargo Guest Stdin Serialization

**Files:**
- Modify: `/home/oligami/projects/cargo/crates/cargo-util/src/process_builder.rs:1-17,228-231,304-389,791-846`
- Modify: `/home/oligami/projects/cargo/src/cargo/util/network/wasi_http.rs:44-58,93-108`

**Interfaces:**
- Consumes: `ProcessBuilder.stdin: Option<Vec<u8>>`.
- Produces: `wasi_ext_spawn(..., stdin_ptr: *const u8, stdin_len: usize, ...)` with stdin arguments immediately after `cwd_len`.

- [ ] **Step 1: Fix the existing baseline compile failure**

Add the trait import required by the existing non-WASI `ChildStdin::write_all` calls:

```rust
use std::io::Write;
```

- [ ] **Step 2: Add a focused unit test for the ABI-facing stdin view**

Add a private helper used by the WASI branch and host-side unit tests:

```rust
#[cfg(any(target_os = "wasi", test))]
fn stdin_bytes(&self) -> &[u8] {
    self.stdin.as_deref().unwrap_or_default()
}
```

Add tests in the existing `mod tests`:

```rust
#[test]
fn wasi_spawn_stdin_defaults_to_eof() {
    let process = ProcessBuilder::new("rustc");
    assert_eq!(process.stdin_bytes(), b"");
}

#[test]
fn wasi_spawn_stdin_preserves_raw_bytes() {
    let mut process = ProcessBuilder::new("rustc");
    process.stdin([0xff, 0x00, b'r', b's']);
    assert_eq!(process.stdin_bytes(), &[0xff, 0x00, b'r', b's']);
}
```

- [ ] **Step 3: Run the unit tests and verify the helper contract**

Run: `cargo test -p cargo-util wasi_spawn_stdin`

Expected: both tests pass. Before Step 1, the crate fails to compile because `std::io::Write` is missing; after Step 1, the focused tests compile and pass.

- [ ] **Step 4: Extend the guest FFI declaration and call**

Insert these arguments after `cwd_len` in the declaration:

```rust
stdin_ptr: *const u8,
stdin_len: usize,
```

Before the call, obtain the ABI-facing slice:

```rust
let stdin = self.stdin_bytes();
```

Pass it after `cwd_s.len()`:

```rust
stdin.as_ptr(), stdin.len(),
```

Update the duplicate declaration and call in `wasi_http.rs` with the same parameter ordering. That network helper has no request body stdin, so pass an empty slice:

```rust
std::ptr::null(), 0,
```

- [ ] **Step 5: Verify host and wasm32 compilation**

Run: `cargo test -p cargo-util`

Expected: `cargo-util` tests pass; existing `filetime` cfg warnings may remain.

Run: `cargo +nightly check -p cargo-util --target wasm32-wasip1-threads -Zbuild-std`

Expected: the updated raw FFI declaration and call compile for wasm32.

---

### Task 2: VFS Host Stdin Consumption

**Files:**
- Modify: `/home/oligami/projects/rubrc/crates/vfs/src/lib.rs:847-975`
- Modify: `/home/oligami/projects/rubrc/crates/vfs-rustc-twice/src/lib.rs:618-690`
- Modify: `/home/oligami/projects/rubrc/scripts/vfs_debug_cargo_pipe_test.ts:103-106`

**Interfaces:**
- Consumes: Cargo guest `stdin_ptr: i32` and `stdin_len: i32` immediately after `cwd_len`.
- Produces: `with_child_process_stdio(cwd, stdin, run_rustc)` in `crates/vfs`; ABI-compatible ignored stdin fields in `vfs-rustc-twice`.

- [ ] **Step 1: Extend both host signatures**

Insert after `cwd_len`:

```rust
stdin_ptr: i32,
stdin_len: i32,
```

In `vfs-rustc-twice`, name them `_stdin_ptr` and `_stdin_len` because that experimental crate does not implement `ChildProcessStdio`.

- [ ] **Step 2: Copy Cargo-owned stdin bytes in the primary VFS**

Read stdin beside the existing program/args/env/cwd reads:

```rust
let stdin = cargo_opt::get_array(stdin_ptr as *const u8, stdin_len as usize).to_vec();
```

Replace the empty child input:

```rust
let ((), child_output) = with_child_process_stdio(cwd.to_vec(), stdin, run_rustc);
```

- [ ] **Step 3: Verify Rust host compilation**

Run: `cargo check -p vfs -p vfs-rustc-twice`

Expected: both host implementations compile against the extended ABI.

- [ ] **Step 4: Make the end-to-end assertion require a real compile spawn**

Replace the current single-marker assertion with a count. Cargo performs two rustc probes before compiling the crate, so a successful path must enter rustc at least three times:

```typescript
const rustcRuns = result.output.match(
  /\[vfs-debug\] wasi-ext-spawn:run-rustc:enter/g,
)?.length ?? 0;
if (rustcRuns < 3) {
  console.error(`Cargo reached ${rustcRuns} rustc runs; compile spawn was not reached`);
  Deno.exit(1);
}
```

---

### Task 3: Standalone Cargo Host ABI Parity

**Files:**
- Modify: `/home/oligami/projects/cargo/test_run.ts:323-377`

**Interfaces:**
- Consumes: the same stdin pointer/length ordering as the Rust hosts.
- Produces: a standalone Deno host that can run child commands with finite stdin bytes.

- [ ] **Step 1: Extend the TypeScript host callback signature**

Add `stdinPtr` and `stdinLen` after the cwd arguments and copy the bytes before spawning:

```typescript
const stdin = getMemory().slice(stdinPtr, stdinPtr + stdinLen);
```

- [ ] **Step 2: Feed bytes synchronously without interpolating command arguments**

For non-empty stdin, write a temporary file and invoke POSIX `sh` with positional arguments rather than shell interpolation:

```typescript
const inputPath = Deno.makeTempFileSync();
Deno.writeFileSync(inputPath, stdin);
try {
  output = new Deno.Command("sh", {
    args: ["-c", 'exec "$@" < "$0"', inputPath, program, ...args],
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
} finally {
  Deno.removeSync(inputPath);
}
```

Keep the existing direct `Deno.Command(program, ...)` path when stdin is empty.

- [ ] **Step 3: Type-check the standalone host**

Run: `deno check test_run.ts`

Expected: no TypeScript errors.

---

### Task 4: Rebuild Cargo Wasm and Verify End to End

**Files:**
- Regenerate: `/home/oligami/projects/rubrc/crates/vfs/cargo_opt.wasm`
- Regenerate ignored build output under `/home/oligami/projects/rubrc/dist/` and `/home/oligami/projects/rubrc/page/src/worker_process/vfs_bindings/`

**Interfaces:**
- Consumes: patched Cargo guest and updated rubrc host ABI.
- Produces: a linked VFS runtime where Cargo's `rustc -` probe receives its source bytes and returns to the shell.

- [ ] **Step 1: Build patched Cargo for wasm32-wasip1-threads**

Run from `/home/oligami/projects/cargo` with the installed WASI SDK paths:

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
```

Expected: `target/wasm32-wasip1-threads/release/cargo.wasm` is produced.

- [ ] **Step 2: Optimize and install the guest artifact**

Run:

```bash
wasm-opt -Oz target/wasm32-wasip1-threads/release/cargo.wasm -o /home/oligami/projects/rubrc/crates/vfs/cargo_opt.wasm
```

Expected: `crates/vfs/cargo_opt.wasm` imports the extended 15-parameter `wasi_ext_spawn` ABI.

- [ ] **Step 3: Rebuild VFS bindings**

Run from `/home/oligami/projects/rubrc`: `bun run vfs:build`

Expected: build exits 0.

- [ ] **Step 4: Validate generated Wasm**

Run:

```bash
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
```

Expected: both commands exit 0 with no output.

- [ ] **Step 5: Run the end-to-end regression**

Run: `deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts`

Expected: exit 0; output contains at least three `[vfs-debug] wasi-ext-spawn:run-rustc:enter` markers, contains no poisoned-stdin error, and returns to the shell prompt before the watchdog.

- [ ] **Step 6: Run existing shell smoke tests**

Run:

```bash
deno run --no-lock -A scripts/vfs_debug_shell.ts "cargo b"
deno run --no-lock -A scripts/vfs_debug_shell.ts "mkdir .cargo && touch .cargo/config.toml && download .cargo/config.toml"
```

Expected: empty-root `cargo b` reports missing `Cargo.toml`; `.cargo/config.toml` remains a downloadable file.

- [ ] **Step 7: Final hygiene**

Run `git diff --check` and `git status --short` in all three repositories:

```text
/home/oligami/projects/cargo
/home/oligami/projects/rubrc
/home/oligami/projects/wasi_virt_layer
```

Expected: no whitespace errors; only intentional tracked modifications plus the previously identified untracked files are present.

---

### Task 5: Avoid Waiting on an Empty Resolver Future Pool

**Files:**
- Modify: `/home/oligami/projects/cargo/src/cargo/util/local_poll_adapter.rs:90-100`
- Verify: `/home/oligami/projects/rubrc/scripts/vfs_debug_cargo_pipe_test.ts`
- Regenerate: `/home/oligami/projects/rubrc/crates/vfs/cargo_opt.wasm`

**Interfaces:**
- Consumes: `LocalPollAdapter::pending_count() == 0` after a resolver activation round with no registry queries.
- Produces: `LocalPollAdapter::wait() -> true` without entering `block_on_stream` when its `FuturesUnordered` pool is empty.

- [ ] **Step 1: Preserve the failing end-to-end evidence**

The existing regression is the WASI-specific RED that native unit tests cannot reproduce:

```text
[resolver-diag] round:1:activate-exit
[resolver-diag] wait:enter pending=0
command timed out after 120000ms on run 1/1: cargo b --offline -j 1 -p app
```

Run before implementation only if fresh reproduction is needed:

```bash
deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts
```

Expected before the fix: exit 1 after exactly two rustc markers and no shell prompt return.

- [ ] **Step 2: Return before invoking the executor for an empty pool**

Replace `LocalPollAdapter::wait` with the semantically equivalent form that does not pass an empty stream to the WASI executor:

```rust
pub fn wait(&mut self) -> bool {
    if self.pool.is_empty() {
        return true;
    }
    for (k, v) in crate::util::block_on_stream(&mut self.pool) {
        *self
            .cache
            .get_mut(&k)
            .expect("all pending work is in the cache") = Poll::Ready(v);
    }
    false
}
```

- [ ] **Step 3: Run focused native tests**

Run:

```bash
cargo test -p cargo --lib local_poll_adapter
```

Expected: the immediate-success/error and deferred-success/error cases pass. If the repository's known unrelated `cargo` package dependency errors prevent this command from compiling, record the exact blocker and continue to the target-specific build and E2E regression.

- [ ] **Step 4: Clean rebuild the patched Cargo guest and VFS**

Run the Task 4 Step 1 WASI Cargo build command from `/home/oligami/projects/cargo`, then:

```bash
wasm-opt -Oz target/wasm32-wasip1-threads/release/cargo.wasm -o /home/oligami/projects/rubrc/crates/vfs/cargo_opt.wasm
```

Run from `/home/oligami/projects/rubrc`:

```bash
bun run vfs:build
```

Expected: both builds exit 0 and the final artifact no longer contains temporary resolver diagnostics.

- [ ] **Step 5: Verify the end-to-end regression turns GREEN**

Run:

```bash
deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts
```

Expected: exit 0, at least three rustc markers, no poisoned-stdin error, and shell prompt return before the watchdog.

- [ ] **Step 6: Re-run artifact and shell verification**

Run:

```bash
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
deno run --no-lock -A scripts/vfs_debug_shell.ts "cargo b"
deno run --no-lock -A scripts/vfs_debug_shell.ts "mkdir .cargo && touch .cargo/config.toml && download .cargo/config.toml"
```

Expected: both Wasm validations and both smoke tests exit 0 with the Task 4 expected output.

- [ ] **Step 7: Final hygiene without committing**

Run `git diff --check` and `git status --short` in Cargo, rubrc, and wasi_virt_layer. Do not commit, amend, push, or create a PR.

---

### Task 6: Use a WASI-Safe Synchronous Future Executor

**Files:**
- Modify: `/home/oligami/projects/cargo/src/cargo/util/mod.rs:78-80,184-214`
- Verify: `/home/oligami/projects/rubrc/scripts/vfs_debug_cargo_pipe_test.ts`
- Regenerate: `/home/oligami/projects/rubrc/crates/vfs/cargo_opt.wasm`

**Interfaces:**
- Consumes: existing Cargo call sites named `crate::util::block_on` and `crate::util::block_on_stream`.
- Produces: unchanged synchronous future/stream APIs, backed by cooperative polling on `target_os = "wasi"` and the existing futures executor on other targets.

- [ ] **Step 1: Write focused tests before the helper exists**

Under the existing `#[cfg(test)] mod test`, add tests that call `wasi_block_on` with an immediately ready future and a `poll_fn` future that yields once, plus a test that drains and terminates a finite stream through `wasi_block_on_stream`.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
cargo test -p cargo --lib wasi_block_on
```

Expected before implementation: compilation fails because `wasi_block_on` and `wasi_block_on_stream` do not exist. If the known unrelated `git2` errors prevent reaching these tests, preserve that exact evidence and use the already-observed E2E timeout at `block_on(Downloads::download(...))` as the target-specific RED.

- [ ] **Step 3: Keep the native executor and add WASI cooperative polling**

Keep the futures executor re-export only for non-WASI targets. Add test-visible WASI helpers that pin and poll a future with `futures::task::noop_waker_ref()`, return on `Poll::Ready`, and call `std::thread::yield_now()` after `Poll::Pending`. Add a small `WasiBlockingStream<S>` iterator whose `next()` calls the WASI helper on `self.stream.next()`.

The public crate-local names must remain:

```rust
crate::util::block_on(future)
crate::util::block_on_stream(stream)
```

No call site may change.

- [ ] **Step 4: Run focused tests and target compilation**

Run:

```bash
cargo test -p cargo --lib wasi_block_on
cargo +nightly check --bin cargo --target wasm32-wasip1-threads -Zbuild-std
```

Expected: focused tests pass when the package test baseline compiles; the WASI Cargo target check exits 0.

- [ ] **Step 5: Clean rebuild and run the full Task 4 verification**

Repeat Task 4 Steps 1-6 from restored source. Confirm the regenerated artifacts contain none of `resolver-diag`, `post-wait-diag`, `package-set-diag`, or `download-diag`.

Expected E2E: exit 0, at least three rustc markers, no poisoned-stdin error, and shell prompt return.

- [ ] **Step 6: Final hygiene without committing**

Run `git diff --check` and `git status --short` in Cargo, rubrc, and wasi_virt_layer. Preserve all existing untracked files. Do not commit, amend, push, or create a PR.

---

### Task 7: Stabilize the WASI Executor and Remove Duplicate Rustc Discovery

**Files:**
- Modify: `/home/oligami/projects/cargo/src/cargo/util/mod.rs`
- Modify: `/home/oligami/projects/cargo/src/cargo/core/profiles.rs`
- Modify: `/home/oligami/projects/cargo/src/cargo/ops/cargo_compile/mod.rs`
- Test: existing unit tests in the modified modules, plus the poisoned-stdin E2E in Task 8

**Interfaces:**
- Consumes: Task 5's empty `LocalPollAdapter` guard and Task 6's WASI-only `block_on`/`block_on_stream` names.
- Produces: a wake-aware WASI executor without `thread::park`, and a compile path that reuses `RustcTargetData::rustc.host` instead of running and dropping a duplicate `rustc -vV` result.

- [ ] **Step 1: Strengthen executor tests before changing production code**

Add focused tests for an empty `FuturesUnordered`, a child that wakes after returning `Pending`, multiple pending children, and a future woken from another thread. Run the focused test command and record either the expected Task 6 test failure or the known unrelated `cargo-test-support`/`git2` compile blocker.

- [ ] **Step 2: Replace the noop-waker spin loop**

Replace Task 6's `noop_waker_ref()` executor with a WASI-only wake-aware implementation using `futures::task::ArcWake` and an `AtomicBool` notification flag. Clear the flag before polling, return on `Ready`, and on `Pending` yield until a wake notification is observed. Do not use `thread::park`, alter non-WASI behavior, or change any executor call site.

- [ ] **Step 3: Add a constructor that accepts an existing rustc host**

Refactor `Profiles::new` so its existing body delegates to an internal constructor that accepts `rustc_host: InternedString`. Keep `Profiles::new` for existing callers.

- [ ] **Step 4: Reuse `RustcTargetData::rustc.host` in `create_bcx`**

Change the compile path in `create_bcx` to call the new constructor with the already-live target-data rustc host. Do not cache `Rustc` globally, use `mem::forget`, box fields, or add explicit drop logic.

- [ ] **Step 5: Run source checks**

Run focused tests as feasible, the established SDK-backed `wasm32-wasip1-threads` Cargo check, and `git diff --check` on the modified Cargo files.

- [ ] **Step 6: Review before rebuilding artifacts**

Review exact API compatibility, wake correctness, lost-wakeup prevention, non-WASI behavior, and the compile-path host provenance. Do not proceed to artifact regeneration with unresolved Important findings.

---

### Task 8: Rebuild and Verify the Stabilized Cargo Guest

**Files:**
- Regenerate: `/home/oligami/projects/rubrc/crates/vfs/cargo_opt.wasm`
- Regenerate ignored VFS outputs under `dist/` and `page/src/worker_process/vfs_bindings/`

- [ ] **Step 1: Clean build and install**

Run the established Task 4 WASI Cargo release build, optimize it into `crates/vfs/cargo_opt.wasm`, and run `bun run vfs:build`.

- [ ] **Step 2: Validate artifacts and diagnostic hygiene**

Validate both core Wasm files and confirm no temporary diagnostic prefixes from Tasks 4-6 remain.

- [ ] **Step 3: Run exactly one poisoned-stdin E2E**

Run `deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts`. Success requires at least three rustc entries, no poisoned-stdin/probe/cwd/incremental error, command return, and shell prompt return.

- [ ] **Step 4: Run smoke tests on success**

Run both Task 4 shell smoke tests and final cross-repository hygiene. If the E2E still times out, do not add a production workaround; continue only to Task 9 diagnostics.

---

### Task 9: Isolate the BuildRunner Boundary Only If Needed

**Files:**
- Temporarily instrument: `/home/oligami/projects/cargo/src/cargo/core/compiler/build_runner/mod.rs`
- Temporarily instrument supporting compiler files only after a paired boundary proves they are entered.

- [ ] **Step 1: Add paired stage markers**

Add low-volume markers around package-cache shared lock acquisition, `JobQueue::new`, LTO generation, `prepare_units`, `prepare`, custom-build map creation, collision checks, metadata preparation, root-unit compilation, and `queue.execute`.

- [ ] **Step 2: Rebuild and run one diagnostic E2E**

Identify the first paired boundary whose exit marker is missing. Do not fix a later unproven operation.

- [ ] **Step 3: Remove diagnostics and report the exact root cause**

Restore diagnostic source, rebuild marker-free artifacts, and propose a separate TDD fix only for the proven non-returning operation.
