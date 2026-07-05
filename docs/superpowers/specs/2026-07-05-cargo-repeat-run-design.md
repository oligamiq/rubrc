# Cargo Repeat Run Design

## Goal

Make the WebShell `cargo` command callable multiple times in `crates/vfs` by resetting the embedded `cargo_opt` instance before each invocation, following the existing `rustc` command pattern.

## Scope

- Modify only `crates/vfs`.
- Do not modify `crates/vfs-rustc-twice`.
- Do not broaden Cargo child-process support beyond the existing `rustc`-only spawn path.
- Keep the existing `rustc`-only spawn path usable by having `run_rustc()` execute `rustc_opt` with the same reset/main pattern.
- Do not change WebShell parsing, VFS file synchronization, or LSP request shape.

## Current Behavior

`run_cargo()` reserves memory for `cargo_opt`, calls `cargo_opt::_start()` only on the first run, then calls `cargo_opt::_main()` on every run. The second invocation can reuse dirty WASI/Cargo runtime state because `cargo_opt::_reset()` is never called.

## Design

Update the two Cargo entrypoints so each Cargo invocation:

1. Acquires `CARGO_RUN_LOCK` before mutating Cargo invocation state.
2. Sets Cargo args/env/cwd/output state as appropriate for the entrypoint.
3. Stores `0` into `CARGO_EXIT_STATUS`.
4. Ensures `cargo_opt` memory is reserved using the existing `MEMORY_MANAGER.ensure_once` call.
5. Calls `cargo_opt::_reset()`.
6. Calls `cargo_opt::_main()`.

The existing `CARGO_STARTED` / `_start()` gating is no longer used by `run_cargo()`. This makes Cargo match the working `rustc` execution model used by `crates/vfs/src/command.rs`, where the target is reset before `_main()`.

The WebShell `cargo` branch in `crates/vfs/src/command.rs` holds `CARGO_RUN_LOCK` around `set_cargo_opt_args()` and `run_cargo()`. The LSP `host_run_cargo()` path in `crates/vfs/src/lib.rs` holds the same lock around env/cwd/output setup, `set_cargo_opt_args()`, `run_cargo()`, output collection, and restoration. WebShell direct `rustc` and the fixed debug rustc dispatch also take `CARGO_RUN_LOCK` before `RUSTC_RUN_LOCK` and execute through `run_rustc()` so they cannot race with Cargo's shared args/env/cwd state and both use the same active guard.

The Cargo spawn bridge remains limited to `rustc`. When Cargo spawns `rustc`, `wasi_ext_spawn()` sets `rustc_opt` args and calls `run_rustc()`, which resets `rustc_opt` and calls `_main()` instead of trapping.

`rustc_opt` is also a shared embedded instance. The WebShell direct `rustc` path holds `RUSTC_RUN_LOCK` around argument setup and reset/main execution. `run_rustc()` marks a thread-local `RUSTC_ACTIVE` flag for the duration of the run. `wasi_ext_spawn()` checks that flag at the top before reading any guest pointers; if a spawn originates while `rustc_opt` is active on the same thread, it returns `1` immediately rather than reading or writing through `cargo_opt` memory. Otherwise, Cargo-spawned `rustc` computes `program_name` before child env/cwd/output state is applied, acquires `RUSTC_RUN_LOCK` before child state is applied, and holds it through `rustc_opt` argument setup, `run_rustc()`, output collection, and restoration. Independent concurrent rustc spawns on other threads wait on `RUSTC_RUN_LOCK` instead of being rejected. Non-`rustc` child spawns do not take `RUSTC_RUN_LOCK`, because `wasi_ext_spawn()` can be re-entered from inside a running tool for linker or helper processes. Top-level shared args/env/cwd races are prevented by taking `CARGO_RUN_LOCK` before direct Cargo, LSP Cargo, direct rustc, and debug rustc execution.

`wasi_ext_spawn()` remains a Cargo-owned spawn bridge: it reads request pointers from `cargo_opt` memory. It is not a general spawn bridge for `rustc_opt`; a cross-thread nested `rustc` spawn from inside `rustc_opt` is outside this bridge's supported caller model.

Unsupported non-`rustc` children return status `127` through `write_cargo_owned_spawn_result()` before child env/cwd/output state is applied. This keeps the unsupported path from mutating global state.

For supported `rustc` children, `wasi_ext_spawn()` replaces the virtual environment with the child env block supplied by Cargo, restores the previous env after the child completes, and restores `VIRTUAL_ARGS` after temporarily setting `rustc_opt` args. Both `wasi_ext_spawn()` and `host_run_cargo()` return an error result if `std::env::set_current_dir()` fails instead of silently running in the wrong directory.

## Diagnostics

Add debug trace markers around Cargo reset and main execution, mirroring the existing `rustc:_reset:*` and `rustc:_main:*` markers. This makes repeated Cargo calls easier to inspect from WebShell debug output.

## Error Handling

Cargo exit status remains reported through `CARGO_EXIT_STATUS`, and command bridge return behavior remains unchanged. `wasi_ext_spawn()` and `host_run_cargo()` now return error results when changing cwd fails, so Cargo/rustc do not silently execute in the wrong directory.

`run_cargo()` itself does not acquire `CARGO_RUN_LOCK`; callers own the lock so their per-invocation args/env/cwd/output setup remains in the same critical section as reset/main execution.

## Testing

Run `cargo check -p vfs` after the code change. If an existing WebShell harness can issue shell commands, run `cargo b` twice and confirm the second invocation reaches `cargo:_reset` and `cargo:_main` instead of returning silently from stale state.
