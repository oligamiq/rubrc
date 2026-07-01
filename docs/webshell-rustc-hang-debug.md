# WebShell rustc hang debug

Use these harnesses to reproduce and inspect rustc executions through the VFS
worker. Two paths exist: **shell-based** (`test_rustc_inspect.ts`) and
**no-shell** (`test_rustc_fixed.ts` / event 1007 dispatch).

## Quick start

```sh
# No-shell (fixed) dispatch — always works
deno run -A ./scripts/test_rustc_fixed.ts

# Shell-based dispatch (creates session, writes file via event 7,
# compiles via event 1007)
deno run -A ./scripts/test_rustc_inspect.ts
```

Override defaults:

```sh
VFS_DEBUG_RUNS=2 VFS_DEBUG_TIMEOUT_MS=60000 VFS_DEBUG_THREADS=8 \
  deno run -A ./scripts/test_rustc_inspect.ts
```

## Architecture

### No-shell path (`test_rustc_fixed.ts`)

Dispatches `EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007` directly through
`root.dispatch`, bypassing the shell entirely. The Rust branch
(`crates/vfs/src/lib.rs`) calls `set_rustc_opt_args`, `rustc_opt::_reset()`, and
`rustc_opt::_main()` inside a `std::thread::spawn(move || { ... }).join()` block
with `debug-rustc:` trace markers.

### Shell-based path (`test_rustc_inspect.ts`)

1. Opens a WASI Shell session (`dispatch(sessionId, 3/CreateSession, ...)`)
2. Writes source file via `dispatch(0xeeeeeeee, 7/WriteFile, ...)`
3. Compiles via `dispatch(0, 1007, ...)` — same reliable path as no-shell test
4. Closes session (`dispatch(sessionId, 5/CloseSession, ...)`)

The shell tests session management and file I/O; the compilation uses the proven
event 1007 path.

### Shell command timeline (for reference)

When the shell approach types `rustc ...` via `EVENT_TYPE_INPUT_CHAR = 0`:

```
Event 0 (InputChar) per keystroke → shell event loop
    → process_input_char → LineEditor → handle_parallel (std::thread::spawn)
        → fallback handler → vfs_execute_command()
            → handle_command("rustc")
                → MEMORY_MANAGER.ensure::<rustc_opt>()
                → set_rustc_opt_args()
                → rustc_opt::_reset()
                → rustc_opt::_main()    ← hangs on 2nd call
                → debug_trace("rustc:_main:return")
            ← return
        ← handle_parallel join
    ← shell prints prompt
```

## Debug markers

- `[vfs-debug-driver] run:N/M:enter ...` — driver dispatched the run
- `[vfs-debug] command:start ...` — vfs-shell called into VFS command bridge
- `[vfs-debug] rustc:_reset:enter/return` — `rustc_opt::_reset` boundary
- `[vfs-debug] rustc:_main:enter/return` — `rustc_opt::_main` boundary
- `[vfs-debug] debug-rustc:enter/return run=N` — event 1007 dispatch markers
- `[vfs-debug] command:return` — VFS command bridge returned to vfs-shell
- `[vfs-debug-driver] run:N/M:return ...` — driver observed completion

## Root cause: VirtualThreadPool exhaustion on repeated shell dispatch

_Investigation date: 2026-06-24_

### Reproduction table

| Run 1         | Run 2                                           | VFS_THREADS | Result                                  |
| ------------- | ----------------------------------------------- | ----------- | --------------------------------------- |
| Shell `rustc` | Shell `rustc`                                   | 8           | **Hang** on run 2 `_main:enter`         |
| FIXED(1007)   | Shell `rustc`                                   | 8           | OK                                      |
| Shell `rustc` | FIXED(1007)                                     | 8           | OK                                      |
| Shell `rustc` | Shell `echo hello`                              | 8           | **Hang** (shell broken after 1st rustc) |
| Shell `rustc` | Shell `rustc` (close/reopen session, 10s delay) | 8           | **Hang**                                |
| Shell `rustc` | Shell `rustc`                                   | 20          | OK                                      |
| Shell `rustc` | Shell `rustc`                                   | 12          | OK                                      |
| Shell `rustc` | Shell `rustc`                                   | 10          | OK                                      |
| Shell `rustc` | Shell `rustc`                                   | 9           | **Hang** on run 2 after linker output   |
| Shell `rustc` | Shell `rustc`                                   | 3           | OK (pool auto-expands)                  |

### Mechanism

When the shell dispatches a `rustc` command, `handle_parallel` (wasi-shell)
spawns a worker thread, which calls `vfs_execute_command` →
`rustc_opt::_main()`. Inside `_main()`, the compiler spawns additional threads
(via WASI-threads) into the `VirtualThreadPool`.

With `VFS_THREADS=8`, the first run succeeds because the pool has just enough
workers for the first nested thread graph. The second run fails because:

1. Total required workers includes the long-lived shell session thread, the
   `handle_parallel` command-runner thread, vfs-shell helper threads, and about
   five `rustc_opt` compiler/helper threads. Empirically, 9 workers is still not
   enough after `wasi_virt_layer 0.5.12`; 10 workers is the first stable count.
2. Only 8 workers exist, and the pool **does not auto-expand** on run 2 because
   its expansion heuristic (`sender.len() > 0`) only triggers when the internal
   channel has queued messages immediately after `send()`.
3. Workers are deadlocked waiting for each other.

### Why auto-expand misses the 8-thread hang

`VirtualThreadPool::run()` in `wasi_virt_layer/src/wasi/thread.rs` enqueues a
`Run` message and decides whether to expand from the queue length immediately
after enqueueing:

```rust
sender.send(VirtualThreadPoolMessage::Run(...)).unwrap();
let need_expansion = sender.len() > 0;
```

This is a **queue backlog heuristic**, not a worker-saturation heuristic. If an
idle worker is waiting on `recv()`, `flume` hands the message to that worker and
`sender.len()` stays `0`. The pool then assumes there is spare capacity, even
though the worker may immediately block inside `wasi_thread_start`, `join`, or
`Atomics.wait`, making no worker available for the next dependency in the same
nested thread graph.

Measured behavior:

| VFS_THREADS | Observed auto-expand logs                                                 | Result        |
| ----------- | ------------------------------------------------------------------------- | ------------- |
| 3           | `sender.len(): 1`, `2`, `1`; auto-expands `3 -> 4 -> 5 -> 6` during run 1 | OK            |
| 8           | No `Automatically expanding thread pool capacity` after initialization    | Hang on run 2 |
| 9           | Rustc helper threads finish, but vfs-shell helper threads stay live       | Hang on run 2 |
| 10          | Rustc helpers and vfs-shell helpers finish before prompt reuse            | OK            |

In the failing `VFS_THREADS=8` trace, run 2 reaches:

```text
[vfs-debug] rustc:_main:enter
```

The important stuck virtual threads are visible before the shell prompt is first
printed. They are produced during VTP/module initialization and are not drained
before the main thread continues into `vfs_shell::_main()`:

```text
$$$ Spawning a new thread in vfs_shell
thread_id: Some(1000008)
$$$ Spawning a new thread in vfs_shell
thread_id: Some(1000009)
$$$ Spawning a new thread in rustc_opt
thread_id: Some(1000010)
...
thread_id: Some(1000013)
```

but there is no corresponding:

```text
[] Automatically expanding thread pool capacity to 9
```

So the root cause is not that the expansion path fails after deciding to expand.
The root cause is that the decision predicate never fires for this shape of
saturation: all spawn requests are consumed quickly enough to keep the queue
length at zero, then the consumed tasks block and exhaust the worker pool.

Additional evidence from the latest traces:

- In `/tmp/opencode/debug_shell_reserve1_current_vtp8.log`, `VFS_THREADS=8`
  still hangs on run 2 even when both diagnostic reserve calls use `pages=1` and
  report `before == after`, so the 4096-page reserve/memory-growth hypothesis is
  not supported.
- In `/tmp/opencode/debug_shell_atomics_wait_vtp8.log`, all logged large-memory
  `Atomics.wait` calls have matching returns.
- In `/tmp/opencode/debug_shell_atomics_main_all_vtp8.log`, after tracing
  `Atomics.wait`/`Atomics.notify` for all buffer sizes in both the root debug
  worker and thread-spawn workers, all JS-level waits still return. After run 2
  prints `[vfs-debug] rustc:_main:enter`, there are no more JS Atomics or FD
  bridge events before timeout. The remaining stall is therefore below the JS
  Atomics wrapper layer, likely inside Wasm atomic wait/synchronization or other
  synchronous Wasm execution in a virtual worker.
- In `/tmp/opencode/debug_shell_fd_trace_vtp10.log`, thread IDs `1000010`,
  `1000011`, `1000014`, `1000009`, and `1000008` all print
  `Thread pool worker finished Run` before the prompt is reused; the same
  vfs-shell IDs do not finish in the 8/9-thread failure logs.

The behavior is **non-monotonic** with thread count:

| VFS_THREADS | Result                      | Why                                                                   |
| ----------- | --------------------------- | --------------------------------------------------------------------- |
| 2           | Fail (prompt never appears) | Too few workers for shell init                                        |
| 3–4         | **OK**                      | Run 1 triggers auto-expand, enough for run 2                          |
| 5–8         | **Hang** on run 2           | Spawn messages are consumed without queue backlog, then workers block |
| 9           | **Hang** after linker output | Rustc helpers finish, but vfs-shell helpers remain live               |
| 10+         | OK                          | Enough workers without expansion                                      |

### Other things ruled out

- **Session state**: Closing (event 5) and reopening (event 3) the shell session
  between runs does not help.
- **Timing**: A 10-second sleep between runs does not help.
- **File system state**: The VFS write (event 7) succeeds and is independent of
  the hang.
- **`_reset()`**: Called correctly before each `_main()`. The hang is in
  `_main()` itself (inside the precompiled WASM component), not in the reset
  logic.
- **Large diagnostic reserve**: Reducing `VFS_DEBUG_MEMORY_RESERVE_PAGES` and
  `VFS_DEBUG_RUSTC_MEMORY_RESERVE_PAGES` to `1` still hangs with 8 threads, so
  the hang is not caused by a large pre-run reserve or memory copy.
- **`wasi_ext_spawn` boundary**: The failing shell path prints `Linking using ...`
  but no `wasi-ext-spawn:*` trace, so the hang is before the external spawn
  handler boundary.

### Fix

The shell-based test now uses event 1007 (the same reliable path as
`test_rustc_fixed.ts`) for the actual rustc compilation. The shell path is used
for session management and file I/O (`EVENT_TYPE_WRITE_FILE`), which are tested
independently of the compilation dispatch.

`scripts/test_rustc_inspect_worker.ts` after fix:

```
1. Create shell session (event 3)
2. Wait for prompt (" $ ")
3. Write source file (event 7)
4. For N runs: dispatch EVENT_TYPE_DEBUG_FIXED_RUSTC (1007)
   → wait for "debug-rustc:return run=N"
5. Close shell session (event 5)
```

This avoids the `handle_parallel` → `_main()` thread pool exhaustion while still
exercising the shell session, file I/O, and repeated compilation paths.

### Sysroot caching

- The expanded local sysroot at `test_workspace_rustc/sysroot` is kept across
  runs.
- The compressed archive is reused from
  `.rubrc-cache/sysroot/wasm32-wasip1.tar.br`.
- If missing, the harness downloads
  `https://oligamiq.github.io/rust_wasm/v0.2.0/wasm32-wasip1.tar.br`, caches it,
  and extracts it.
- `.rubrc-cache/` is git-ignored.
