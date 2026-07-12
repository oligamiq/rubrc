# WebShell Cargo Run WASI Execution Design

## Goal

Make `cargo run` execute a `wasm32-wasip1` binary in WebShell and preserve the
basic child-process behavior Cargo needs: arguments, environment variables,
stdout, stderr, and the exit status.

Interactive stdin and access to the live WebShell VFS from the running target
are explicitly outside this first implementation.

## Root Cause

Cargo successfully builds the target and then calls its WASI
`wasi_ext_spawn` bridge with a path such as
`target/wasm32-wasip1/debug/main.wasm`.

The VFS bridge currently executes only `rustc`. Every other child process is
returned to Cargo as an unsupported process with exit code 127. Neither the
VFS guest nor the browser host currently has a dynamic WASI module runner, so
allowing the path through the existing name check is insufficient.

## Scope

The first implementation supports:

- `wasm32-wasip1` command modules produced by Cargo.
- Program arguments supplied through `cargo run -- ...`.
- Environment variables passed by Cargo.
- Ordered stdout and stderr delivery for `cargo run` targets.
- Propagation of the real child exit status.
- A bounded execution time and bounded module and output sizes.

The first implementation does not support:

- Interactive terminal input. File descriptor 0 returns EOF.
- Access to files in the live WebShell VFS. The child receives an empty
  in-memory `/` preopen.
- WASI threads or non-WASI WebAssembly modules.
- More than one active dynamic child at a time.
- Cargo-managed dynamic children that require captured output, including
  build scripts. They retain the current unsupported-child result.
- Long-running servers or programs that exceed the initial time or output
  limits.

## Architecture

### Cargo Spawn Modes

The Cargo WASI process bridge will distinguish the existing captured process
path from a new streaming process path. Only the WASI `exec_replace()`
implementation, which is used for a `cargo run` target, selects streaming
execution.

The public behavior and implementation path of `ProcessBuilder::output()` and
`status()` remain unchanged. A nonzero child status continues to produce the
existing `ProcessError`, and captured non-`rustc` children remain unsupported.
This avoids implicitly claiming build-script support without a shared
filesystem.

The scalar `wasi_ext_spawn` ABI will carry the spawn mode. The existing
`rustc` handling remains unchanged and ignores the dynamic-Wasm mode.

### VFS Dispatch

`wasi_ext_spawn` will keep the current `rustc` branch. For any other program:

1. Require streaming mode and a `.wasm` path; reject other programs with exit
   code 127.
2. Read the module from the VFS using the child path resolved against the
   requested working directory.
3. Validate the module-size limit before starting a host request.
4. Send program metadata and module bytes through a request-ID bridge.
5. Wait for the host runner result through the existing WASIFarm host-call
   suspension mechanism.
6. Return empty captured streams and the exit status through the existing
   Cargo-owned result buffers. Output has already been sent to the terminal.

The dynamic child never calls back into VFS Rust. This avoids a
Rust-to-JavaScript-to-Rust reentrant call chain.

### Scalar Bridge Protocol

Both VFS WIT worlds will expose the same child-process resource with
pointer/length values represented as scalar WIT parameters. Pointers refer
only to the VFS module's own memory. The local generated JavaScript adapter
copies each range before passing data to the host callback, so the host never
dereferences a pointer into another Wasm memory. No WIT lists are used.

The protocol consists of:

- Start a request with mode, serialized metadata lengths, module length, and
  stdin length; receive a request ID.
- Upload null-delimited argv and environment data in bounded chunks.
- Upload module bytes in chunks of at most 256 KiB.
- Run the request and receive scalar status and output-length metadata.
- Read a bounded runner error into a Rust-provided buffer in chunks of at most
  64 KiB.
- End or abort the request and release all retained host state.

`end` is idempotent and is also the explicit abort operation. A VFS-side guard
calls it after upload, execution, or result-read failures. Request IDs are
never reused while active, and the host permits only one streaming child.

Host cleanup does not depend solely on Rust destructors. An upload request has
a 30-second inactivity timer that is refreshed by each accepted chunk. The
host removes an inactive request even if the VFS traps or is interrupted
before calling `end`. Once execution starts, the Worker-owned 120-second timer
performs the same independent cleanup. Worker errors, host exceptions, and
normal completion also release the slot before returning a result.

### Host Runner

The browser and Deno hosts share a child-process bridge implementation. Each
request owns a dedicated Worker. The Worker:

1. Compiles the transferred module.
2. Creates an `@bjorn3/browser_wasi_shim` WASI instance with argv, env, an
   empty stdin, streaming stdout/stderr, and an empty `/` preopen.
3. Instantiates and invokes the module's WASI command entry point.
4. Converts normal return, `proc_exit`, traps, and setup failures into an exit
   status and optional runner error.
5. Posts the result and terminates.

The Worker isolates synchronous Wasm execution from the WebShell VFS worker.
The parent host owns the 120-second timer and can terminate a stuck child even
when the child's event loop is blocked.

### Output Handling

Streaming execution preserves stdout/stderr ordering using `{ fd, bytes }`
events.
The child Worker applies synchronous coalescing:

- The first write is sent immediately.
- Later writes are accumulated until 64 KiB is available or at least 16 ms
  has elapsed since the previous event, checked during each `fd_write` call.
- Remaining bytes are flushed when the module exits or traps.
- Total streamed output is limited to 4 MiB.

This gives the first write immediate feedback and batches tight print loops.
A later small write may remain buffered until another write or process exit
when it arrives within 16 ms of the previous event. The limits bound memory
and IPC pressure without adding Atomics or SharedArrayBuffer usage.

## Limits And Errors

- Module size: 16 MiB.
- Streamed output: 4 MiB total.
- Execution timeout: 120 seconds.
- Upload inactivity timeout: 30 seconds.
- Active dynamic children: 1.
- Module upload chunk: 256 KiB.
- Output event and runner-error read chunk: 64 KiB.

Unsupported paths retain exit code 127. Invalid modules, unavailable WASI
imports, resource-limit failures, and timeout failures produce a concise
stderr message and a nonzero status. Host exceptions do not cross the bridge.

Every terminal state terminates the Worker and removes retained request data.

## Testing

### Focused Tests

- Bridge validation, chunk boundaries, request ownership, cleanup, and limits.
- Child Worker normal exit, explicit `proc_exit`, trap, timeout, and output
  overflow.
- Stream ordering and coalescing.
- Unsupported captured dynamic children still return exit code 127.

### WebShell End-To-End Tests

- A minimal project prints a marker through `cargo run` and returns to the
  shell prompt.
- `cargo run -- first second` propagates both arguments.
- A nonzero target reports the real status and stderr.

### Regression Tests

- `cargo build` still completes through the existing rustc spawn path.
- `cargo add hello` still updates the manifest and returns to the prompt.
- `cargo info dashmap` still completes through the HTTP bridge.
- Both generated VFS artifacts validate and remain byte-identical.

## Follow-Up Work

Interactive stdin, live VFS access, captured build-script execution, and
long-running process support require separate designs. They need a
bidirectional process channel and a filesystem-sharing model that does not
reenter the suspended VFS guest. None will be added as part of this
implementation.
