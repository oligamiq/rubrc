# Cargo Repeat Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WebShell `cargo` command callable multiple times by resetting `cargo_opt` before each `cargo` invocation in `crates/vfs`.

**Architecture:** Keep the existing WebShell command dispatch and Cargo spawn bridge intact. Serialize each Cargo entrypoint around args/env/cwd/output setup, reset the embedded WASI module in `run_cargo()`, then call `_main()`.

**Tech Stack:** Rust, WASI, `wasi_virt_layer`, embedded `cargo_opt`, existing `debug_trace` diagnostics.

## Global Constraints

- Modify only `crates/vfs` implementation code.
- Do not modify `crates/vfs-rustc-twice`.
- Do not broaden Cargo child-process support beyond the existing `rustc`-only spawn path.
- Keep the existing `rustc`-only spawn path usable by having `run_rustc()` execute `rustc_opt` with the same reset/main pattern.
- Do not change WebShell parsing, VFS file synchronization, or LSP request shape.
- Do not commit changes unless the user explicitly requests a commit.

---

## File Structure

- Modify: `crates/vfs/src/lib.rs`
  - Responsibility: owns the embedded `cargo_opt` execution path, Cargo output capture, Cargo child process bridge, and LSP `host_run_cargo` entrypoint.
- Modify: `crates/vfs/src/command.rs`
  - Responsibility: owns WebShell command dispatch and sets Cargo args for direct `cargo` shell commands.
- No new source files.
- No test files are required for this minimal reset-path change because the current repo does not expose a focused unit harness for `run_cargo()`; verification is by `cargo check -p vfs` and, if available, WebShell command replay.

### Task 1: Reset Cargo Before Every Run

**Files:**
- Modify: `crates/vfs/src/lib.rs:45-58`
- Modify: `crates/vfs/src/command.rs:189-192`

**Interfaces:**
- Consumes: `CARGO_RUN_LOCK`, `RUSTC_RUN_LOCK`, `MEMORY_MANAGER.ensure_once::<cargo_opt>(&CARGO_RESERVE_ONCE, CARGO_CONFIG)`, `MEMORY_MANAGER.ensure_once::<rustc_opt>(&RUSTC_RESERVE_ONCE, RUSTC_CONFIG)`, `cargo_opt::_reset()`, `cargo_opt::_main()`, `rustc_opt::_reset()`, `rustc_opt::_main()`, `debug_trace(&str)`, `memory_size::<cargo_opt>()`, `memory_size::<rustc_opt>()`.
- Produces: `pub(crate) fn run_cargo()` still takes no arguments and returns `()`. Existing callers in `crates/vfs/src/command.rs` and `host_run_cargo` continue using the same interface.

- [ ] **Step 1: Inspect the current Cargo execution path**

Read `crates/vfs/src/lib.rs:45-58` and confirm it currently contains this pattern:

```rust
static CARGO_STARTED: AtomicBool = AtomicBool::new(false);
pub(crate) static CARGO_EXIT_STATUS: AtomicI32 = AtomicI32::new(0);

pub(crate) fn run_cargo() {
    CARGO_EXIT_STATUS.store(0, Ordering::SeqCst);
    MEMORY_MANAGER.ensure_once::<cargo_opt>(&CARGO_RESERVE_ONCE, CARGO_CONFIG);
    if !CARGO_STARTED.swap(true, Ordering::SeqCst) {
        cargo_opt::_start();
    }
    cargo_opt::_main();
}
```

- [ ] **Step 2: Replace `_start()` gating with reset-main execution**

Change `run_cargo()` to this exact implementation:

```rust
pub(crate) fn run_cargo() {
    CARGO_EXIT_STATUS.store(0, Ordering::SeqCst);
    MEMORY_MANAGER.ensure_once::<cargo_opt>(&CARGO_RESERVE_ONCE, CARGO_CONFIG);
    debug_trace(&format!(
        "cargo:memory:after-ensure pages={}",
        memory_size::<cargo_opt>()
    ));
    debug_trace("cargo:_reset:enter");
    cargo_opt::_reset();
    debug_trace(&format!(
        "cargo:memory:after-reset pages={}",
        memory_size::<cargo_opt>()
    ));
    debug_trace("cargo:_reset:return");
    debug_trace("cargo:_main:enter");
    cargo_opt::_main();
    debug_trace(&format!(
        "cargo:memory:after-main pages={}",
        memory_size::<cargo_opt>()
    ));
    debug_trace("cargo:_main:return");
}
```

- [ ] **Step 3: Remove now-unused `CARGO_STARTED`**

Delete this line from `crates/vfs/src/lib.rs`:

```rust
static CARGO_STARTED: AtomicBool = AtomicBool::new(false);
```

Keep the `AtomicBool` import and keep `RUSTC_STARTED` to match the original task brief. If it remains unused, annotate it with `#[allow(dead_code)]` instead of deleting it.

- [ ] **Step 4: Lock Cargo entrypoints around setup and execution**

Expose the existing lock within `crates/vfs/src/lib.rs`:

```rust
pub(crate) static CARGO_RUN_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
```

Keep `let _run_guard = CARGO_RUN_LOCK.lock();` in `host_run_cargo()` before env/cwd/output setup.

Add the same lock to the WebShell command branch in `crates/vfs/src/command.rs`:

```rust
"cargo" => {
    let _run_guard = crate::CARGO_RUN_LOCK.lock();
    set_cargo_opt_args(&args);
    crate::run_cargo();
}
```

Do not acquire `CARGO_RUN_LOCK` inside `run_cargo()`, because that would either leave caller-side args/env/cwd/output setup unprotected or deadlock when `host_run_cargo()` already holds the lock.

- [ ] **Step 5: Restore the rustc-only Cargo spawn bridge**

Change `run_rustc()` in `crates/vfs/src/lib.rs` so the existing `rustc`-only `wasi_ext_spawn()` branch executes `rustc_opt` instead of trapping:

```rust
fn run_rustc() {
    RUSTC_EXIT_STATUS.store(0, Ordering::SeqCst);
    MEMORY_MANAGER.ensure_once::<rustc_opt>(&RUSTC_RESERVE_ONCE, RUSTC_CONFIG);
    debug_trace(&format!(
        "rustc:memory:after-ensure pages={}",
        memory_size::<rustc_opt>()
    ));
    debug_trace("rustc:_reset:enter");
    rustc_opt::_reset();
    debug_trace(&format!(
        "rustc:memory:after-reset pages={}",
        memory_size::<rustc_opt>()
    ));
    debug_trace("rustc:_reset:return");
    debug_trace("rustc:_main:enter");
    rustc_opt::_main();
    debug_trace(&format!(
        "rustc:memory:after-main pages={}",
        memory_size::<rustc_opt>()
    ));
    debug_trace("rustc:_main:return");
}
```

Keep the unused `RUSTC_STARTED` static with `#[allow(dead_code)]` if it is no longer referenced.

Add a regular `RUSTC_RUN_LOCK` and a thread-local active flag in `crates/vfs/src/lib.rs`:

```rust
pub(crate) static RUSTC_RUN_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
thread_local! {
    static RUSTC_ACTIVE: Cell<bool> = const { Cell::new(false) };
}
```

`run_rustc()` sets thread-local `RUSTC_ACTIVE` for the duration of the run and clears it with a `Drop` guard. At the very top of `wasi_ext_spawn()`, before reading any guest pointers from `cargo_opt` memory, return `1` if `RUSTC_ACTIVE` is set. This rejects spawn calls originating from an active `rustc_opt` execution instead of treating rustc-owned pointers as cargo-owned pointers. Independent rustc spawns on other threads wait on `RUSTC_RUN_LOCK`.

Keep `wasi_ext_spawn()` Cargo-owned: it reads request pointers from `cargo_opt` memory and is not a general spawn bridge for `rustc_opt` callers.

Hold `CARGO_RUN_LOCK` then `RUSTC_RUN_LOCK` around WebShell direct `rustc` argument setup and reset/main execution. `CARGO_RUN_LOCK` prevents races with Cargo's shared args/env/cwd state; `RUSTC_RUN_LOCK` protects the shared `rustc_opt` instance:

```rust
"rustc" => {
    let _tool_guard = crate::CARGO_RUN_LOCK.lock();
    let _rustc_guard = crate::RUSTC_RUN_LOCK.lock();
    // set args, then call crate::run_rustc()
```

Do not lock the whole `wasi_ext_spawn()` body for every child process. It can be re-entered while a running tool already holds `RUSTC_RUN_LOCK`, so locking all child spawns can deadlock on nested linker/helper process creation.

Reject rustc-origin spawn calls before reading cargo-owned request pointers:

```rust
if RUSTC_ACTIVE.with(|active| active.get()) {
    return 1;
}
```

Then compute `program_name` before child env/cwd/output setup. If the child is `rustc`, acquire `RUSTC_RUN_LOCK` before applying that child state and keep it held through restoration:

```rust
let program_name = Path::new(&program)
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or(&program);
if program_name != "rustc" {
    let message = format!("unsupported child process: {program}");
    write_cargo_owned_spawn_result(
        Vec::new(),
        message.into_bytes(),
        127,
        out_exit_code,
        out_stdout_ptr,
        out_stdout_len,
        out_stderr_ptr,
        out_stderr_len,
    );
    return 0;
}
let _rustc_guard = RUSTC_RUN_LOCK.lock();
```

For unsupported non-`rustc` children, return `127` with `write_cargo_owned_spawn_result()` before applying child env/cwd/output state. For supported `rustc` children, replace `VIRTUAL_SHELL_ENV` with the child env block supplied by Cargo and restore the old env after the child completes. If `std::env::set_current_dir()` fails in either `wasi_ext_spawn()` or `host_run_cargo()`, return an error result instead of continuing in the wrong directory. Save and restore the previous `VIRTUAL_ARGS` around temporary `rustc_opt` argument setup.

Within that protected section, keep Cargo-spawned `rustc` argument setup and `run_rustc()` in the `program_name == "rustc"` branch:

```rust
if program_name == "rustc" {
    crate::debug_trace("wasi-ext-spawn:run-rustc:enter");
    command::set_rustc_opt_args(&argv);
    run_rustc();
```

Make `run_rustc()` `pub(crate)` so the direct WebShell `rustc` path can call the same implementation as the Cargo-spawned path.

The fixed debug rustc dispatch also touches `rustc_opt`; inside its spawned thread, acquire locks in the same order, set args, then call `run_rustc()` so it uses the same active guard:

```rust
let _tool_guard = crate::CARGO_RUN_LOCK.lock();
let _rustc_guard = crate::RUSTC_RUN_LOCK.lock();
crate::command::set_rustc_opt_args(fixed_args);
crate::shell::vfs_set_current_session_id(1);
crate::run_rustc();
```

- [ ] **Step 6: Run Rust check**

Run:

```bash
cargo check -p vfs
```

Expected result: command exits successfully. Warnings are acceptable only if they were already present or are unrelated to this change. There must be no new unused `CARGO_STARTED` warning.

- [ ] **Step 7: Optional WebShell replay**

If a local WebShell harness is already available in the working tree, run `cargo b` twice in the same WebShell session.

Expected debug evidence on both runs:

```text
cargo:_reset:enter
cargo:_reset:return
cargo:_main:enter
```

The second run must not return silently before reaching the Cargo reset/main trace markers.

- [ ] **Step 8: Review diff without committing**

Run:

```bash
git diff -- crates/vfs/src/lib.rs crates/vfs/src/command.rs docs/superpowers/specs/2026-07-05-cargo-repeat-run-design.md docs/superpowers/plans/2026-07-05-cargo-repeat-run.md
```

Expected result: diff contains only the Cargo reset-path change, Cargo entrypoint locking, and the two documentation files. Do not commit unless the user explicitly requests it.
