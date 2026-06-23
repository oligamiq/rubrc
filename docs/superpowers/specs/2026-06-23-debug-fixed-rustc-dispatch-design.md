# Debug Fixed Rustc Dispatch Design

## Purpose

Add a diagnostic-only `dispatch` path that invokes `rustc_opt` directly with fixed compile arguments. This isolates the current two-run hang from WebShell boot, interactive character dispatch, and shell command parsing while preserving the reused `rustc_opt` instance and VFS host environment.

## Constraints

- Do not create a fresh `rustc_opt` instance per command.
- Do not use the WebShell command path for this diagnostic.
- Do not boot the shell in the diagnostic harness.
- Keep the event number offset from normal user-facing dispatch events.
- Treat this as diagnosis, not a production fix.
- Preserve unrelated dirty worktree changes.

## Dispatch Event

Add `EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007` in `crates/vfs/src/lib.rs`.

The new branch runs before the fallback to `vfs_shell_dispatch`. It ignores `session_id`, `arg1`, and `arg2` for behavior. If a run marker is useful for logs, `arg1` may be printed only as diagnostic context.

## Rustc Invocation

The event branch will ensure the same modules needed by the existing direct rustc command path:

- `rustc_opt` with `RUSTC_CONFIG`
- `llvm_opt` with `LLVM_CONFIG`

It will set fixed arguments through `command::set_rustc_opt_args`:

```text
rustc
/src/main.rs
--sysroot
/sysroot
--target
wasm32-wasip1
-Clinker-flavor=wasm-ld
-Clinker=wasm-ld
```

It will then call the current direct sequence under investigation:

```text
rustc_opt::_reset()
rustc_opt::_main()
```

The branch may print explicit diagnostic markers around setup, `_reset`, `_main`, return, and panic boundaries so the harness can distinguish timeout locations.

## Harness Flow

Add a no-shell diagnostic mode or harness that:

1. Instantiates `vfs.core.wasm` with the existing WASI farm setup.
2. Writes `/src/main.rs` through `EVENT_TYPE_WRITE_FILE = 7`.
3. Dispatches `EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007` twice.
4. Waits for return markers or timeout without relying on a shell prompt.
5. Reports which run entered, returned, or timed out.

The harness must not call `dispatch(sessionId, 3, 0, 0)` and must not send interactive character input events.

## Expected Diagnostic Value

If the second run still hangs, the failure is below WebShell boot/input/command parsing and remains in the reused `rustc_opt`/WVL/thread/reset path.

If the second run succeeds, the failure likely depends on WebShell state, command dispatch, prompt handling, or initialization performed by the shell path.

## Out Of Scope

- Fixing the hang.
- Changing WVL reset semantics.
- Introducing new `Atomics` or `SharedArrayBuffer` use.
- Reworking `run_rustc()` or cargo spawn behavior except where explicitly needed by this diagnostic.
- Cleaning unrelated temporary debug prints or unrelated untracked files.
