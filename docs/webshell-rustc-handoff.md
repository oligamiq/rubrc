# WebShell `rustc` hang handoff

## Repository state

- Branch: `use-wasi_virt_layer`
- Debug environment commit:
  `268d1deb414858e3dc127a6ad4daf8a4538da849`
- Commit subject:
  `feat(vfs): add terminal capture for debugging and improve rustc sysroot handling`
- `wasi_virt_layer`: `0.5.3`
- `@oligami/browser_wasi_shim-threads`: `0.3.7`
- Rust target: `wasm32-wasip1-threads`
- VFS build mode: single combined memory with WASI threads

For a related repository, the current diagnostic environment can be imported with:

```bash
git cherry-pick 268d1deb414858e3dc127a6ad4daf8a4538da849
```

## Symptom

Running either command in WebShell does not return:

```bash
rustc
rustc -v
```

Expected native behavior:

- `rustc` prints usage and exits.
- `rustc -v` reports that no input filename was given and exits with status 1.

Chrome was confirmed not to fail with a browser memory error. Firefox headless
ran out of memory while loading the approximately 410 MB combined Wasm, so
Firefox is not currently useful for reproducing this issue.

## Reproduction without the UI

Build the combined VFS first:

```bash
bun run vfs:build
```

Run a control command:

```bash
VFS_DEBUG_TIMEOUT_MS=5000 bun run vfs:debug-shell nope
```

This must finish and include:

```text
[vfs-debug] command:start nope
[vfs-debug] command:return
```

Reproduce the rustc hang:

```bash
VFS_DEBUG_TIMEOUT_MS=5000 bun run vfs:debug-shell rustc
VFS_DEBUG_TIMEOUT_MS=5000 bun run vfs:debug-shell rustc -v
```

Both currently time out with the last trace at:

```text
[vfs-debug] command:start rustc
[vfs-debug] rustc:_reset:enter
[vfs-debug] rustc:_reset:return
[vfs-debug] rustc:_start:enter
```

Use the production thread count when required:

```bash
VFS_DEBUG_THREADS=8 bun run vfs:debug-shell rustc
```

The default is two threads to reduce startup time. The hang reproduces with two
threads.

## Confirmed observations

1. WebShell parsing and fallback command dispatch work. The control command
   enters and returns from `vfs_execute_command`.
2. The rustc argument buffer reaches `crates/vfs/src/command.rs`.
3. `rustc_opt::_reset()` returns.
4. The call to `rustc_opt::_start()` does not return within the timeout.
5. The same behavior occurs for bare `rustc` and `rustc -v`.
6. Adding `--sysroot /sysroot` does not resolve this hang.
7. Calling embedded rustc directly on the VFS root thread is different:
   without a sysroot it reports an error finding the sysroot; with
   `--sysroot /sysroot` it returns the expected no-input diagnostic.

The confirmed stopping point is `_start()`. The exact internal lock, wait, or
corrupted state inside `_start()` has not yet been identified.

## Strong cause candidate

The `wasi_virt_layer 0.5.3` source documents `_reset()` as not thread-safe in
`wasi-threads` and single-memory configurations. It states that resetting
memory can destroy active stacks, TLS, mutexes, atomics, and shared globals.

Current execution does this from a WebShell session thread:

```rust
rustc_opt::_reset();
rustc_opt::_start();
rustc_opt::_main();
```

This matches the observed sequence: `_reset()` appears to return, then
`_start()` hangs. This is a strong explanation, but it remains an inference
until the wait or corrupted state inside `_start()` is instrumented.

Relevant upstream source:

```text
~/.cargo/registry/src/*/wasi_virt_layer-0.5.3/src/memory.rs
```

Search for `WARNING: Multithreading Vulnerabilities`.

## Approaches already tested

### Initialize rustc before starting the thread pool

Calling `_reset()` and `_start()` once before the VFS thread pool starts avoids
the hang, but `_start()` executes rustc immediately using startup arguments.
It prints rustc usage before WebShell starts. A later `_main()` call returns
without producing the command result. This is not a valid fix.

### Call `_main()` without `_reset()` or `_start()`

Calling `_main()` directly from the WebShell session thread also hangs.

### Add a default sysroot

Commands without an explicit sysroot are changed to include:

```text
--sysroot /sysroot
```

This prevents the separate `current_dll_path not supported` sysroot failure,
but does not affect the WebShell `_start()` hang.

### Browser-only debugging

The original generated Deno runner only starts VFS and does not create a shell
session. An earlier attempt to route terminal output through the SharedObject
host callback failed while serializing terminal messages. The current capture
API keeps terminal output inside the VFS Wasm and avoids that bridge.

## Debug environment design

The harness creates a real `vfs-shell` session and sends input through the same
dispatch events as WebShell:

- event `3`: create session
- event `0`: input character
- event `5`: close session

Terminal output is captured inside VFS through these WIT exports:

```wit
debug-set-terminal-capture: func(enabled: bool);
debug-terminal-output-len: func() -> u32;
debug-read-terminal-output: func(ptr: u32, len: u32) -> u32;
```

Important files:

- `scripts/vfs_debug_shell.ts`: command-line entry point and timeout handling
- `scripts/vfs_debug_shell_worker.ts`: VFS instantiation and session driver
- `crates/vfs/src/lib.rs`: terminal capture buffer and WIT implementation
- `crates/vfs/src/shell.rs`: command entry/return trace
- `crates/vfs/src/command.rs`: rustc stage traces and default sysroot
- `crates/vfs/wit/vfs-host.wit`: debug exports
- `page/src/worker_process/vfs_bindings/vfs.js`: generated component binding
- `page/src/worker_process/vfs_bindings/vfs.d.ts`: generated type declarations

Current harness limitations:

- Terminal capture is global, not keyed by session ID.
- Run one diagnostic command at a time.
- Arguments are joined with spaces, so it does not preserve complex shell
  quoting.
- A timeout means the worker is terminated; it does not unwind the hung guest.

## Recommended next steps

### Option A: Isolate rustc in a dedicated Worker

Instantiate rustc in a separate Worker or separate Wasm memory for each command.
Terminate that Worker after completion. This avoids resetting the memory that
contains active VFS and shell thread stacks.

This is the most practical application-level direction.

### Option B: Fix or extend `wasi_virt_layer`

Add a supported lifecycle for re-running an embedded module in a threaded,
single-memory build. Likely requirements include:

- no full-memory reset while any thread uses the shared memory;
- per-module stack and TLS isolation;
- explicit module instance recreation, or a safe snapshot/restore boundary;
- tests that invoke `_reset()`, `_start()`, and `_main()` from a virtual thread.

This belongs in the `wasi_virt_layer` project if the library is expected to
support reusable embedded commands under WASI threads.

### Immediate instrumentation target

Instrument the generated/imported implementation behind
`__wasip1_vfs_rustc_opt__start` and identify its first wait, mutex operation, or
WASI call. The existing harness will preserve the last stage marker and enforce
a timeout.

## Verification completed

The following checks pass at the handoff commit:

```bash
cargo check -p vfs --target wasm32-wasip1-threads
bun run vfs:build
bun run --cwd page build
deno fmt --check scripts/vfs_debug_shell.ts scripts/vfs_debug_shell_worker.ts
git diff --check
```

The Rust check has two pre-existing warnings:

- unused `wasi_virt_layer::prelude::*` in `crates/vfs/src/command.rs`;
- unnecessary `unsafe` around `lsp_opt::_start()` in `crates/vfs/src/lib.rs`.
