# WebShell Cargo Run WASI Execution Design

## Goal

Make `cargo run` execute a `wasm32-wasip1` binary in WebShell and preserve the
basic child-process behavior Cargo needs: arguments, environment variables,
stdin, stdout, stderr, filesystem access, and the exit status.

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
- Inherited terminal stdin, stdout, and stderr.
- A filesystem snapshot synchronized from VFS before execution.
- File additions, updates, and removals synchronized back to VFS after
  execution.
- Propagation of the real child exit status.
- A bounded execution time and module size.

The first implementation does not support:

- WASI threads or non-WASI WebAssembly modules.
- More than one active dynamic child at a time.
- Cargo-managed dynamic children that require captured output, including
  build scripts. They retain the current unsupported-child result.
- Live filesystem coherence while the child is running. Files are reconciled
  immediately before and after execution.
- Long-running servers that exceed the initial execution timeout.

## Architecture

### Cargo Spawn Modes

The Cargo WASI process bridge will distinguish the existing captured process
path from a new streaming process path. Only the WASI `exec_replace()`
implementation, which is used for a `cargo run` target, selects streaming
execution.

The public behavior and implementation path of `ProcessBuilder::output()` and
`status()` remain unchanged. A nonzero child status continues to produce the
existing `ProcessError`, and captured non-`rustc` children remain unsupported.
This keeps build-script support outside the first implementation even though
the streaming target receives a shared filesystem snapshot.

The scalar `wasi_ext_spawn` ABI will carry the spawn mode. The existing
`rustc` handling remains unchanged and ignores the dynamic-Wasm mode.

### VFS Dispatch

`wasi_ext_spawn` will keep the current `rustc` branch. For any other program:

1. Require streaming mode and a `.wasm` path; reject other programs with exit
   code 127.
2. Read the module from the VFS using the child path resolved against the
   requested working directory.
3. Validate the module-size limit before starting a host request.
4. Reconcile the runtime-visible VFS tree into the backing WASIFarm
   filesystem and record a baseline fingerprint for each synchronized path.
5. Send program metadata and module bytes through a request-ID bridge.
6. Wait for the host runner result through the existing WASIFarm host-call
   suspension mechanism.
7. On normal return or explicit `proc_exit`, reconcile child changes from the
   backing WASIFarm filesystem into VFS. On a trap or timeout, restore the
   backing filesystem baseline instead.
8. Return empty captured streams and the exit status through the existing
   Cargo-owned result buffers. The inherited terminal descriptors have
   already delivered output.

The dynamic child never calls back into VFS Rust. This avoids a
Rust-to-JavaScript-to-Rust reentrant call chain.

### Filesystem Reconciliation

The existing `flush_from_vfs` and `flush_to_vfs` operations will become a
bidirectional mirror rather than add-only recursive copies.

Before execution, VFS is authoritative. Reconciliation creates missing host
directories and files, overwrites changed file contents, replaces entries
whose file/directory type changed, and removes host entries absent from VFS.
It records type, size, and content fingerprints for conflict detection and
rollback.

Synchronization covers the project-visible root while excluding internal
runtime/cache trees that a normal target does not need: `/sysroot`, `/target`,
`/.cargo/registry`, `/.cargo/git`, `/.git`, `/node_modules`, and `/.cache`. The
executable is transferred separately through the child-process bridge. These
exclusions avoid duplicating compiler artifacts, dependency trees, and caches
before every run.

The synchronized tree is limited to 10,000 entries and 64 MiB of file content.
The pre-run phase fails with an explicit resource-limit error before starting
the child if either budget would be exceeded. This prevents an unbounded full
workspace copy while keeping ordinary Rust project data available.

After a graceful execution, reconciliation applies only paths that differ
from the recorded host baseline. Before changing a VFS path, it verifies that
the VFS path still matches its pre-run fingerprint. A concurrent VFS edit wins
and is reported as a synchronization conflict rather than being overwritten
or deleted. Child-created and child-modified files otherwise become visible
to subsequent WebShell commands.

After a trap, Worker error, or timeout, potentially partial child writes are
not imported. The TypeScript filesystem is restored from the baseline before
the request slot is released.

The Cargo run lock and the one-child limit serialize reconciliation with the
target execution. This is snapshot sharing, not live bidirectional coherence:
changes become visible across the boundary only at the two reconciliation
points.

Completion uses a two-phase acknowledgement. The host retains a gracefully
completed request until VFS finishes reverse reconciliation and calls `end`.
If VFS traps before acknowledging, the completed filesystem state remains in
the WASIFarm. A scalar recovery operation reports the pending request ID,
lifecycle state, and status to a replacement VFS before a new request can
start.

For the normal path, the current VFS instance owns the baseline fingerprints
used for conflict detection. The host request also retains the baseline
manifest until acknowledgement. If the VFS instance traps and is replaced,
the replacement has no concurrent local edits to preserve; it performs a
full authoritative import from the persistent farm filesystem, acknowledges
the recovered request ID, and then accepts new commands. This recovery path
does not attempt conflict detection with the discarded VFS instance.

If recovery finds an upload or execution still active, the replacement VFS
aborts it before accepting commands. The host terminates a running Worker,
restores the TypeScript filesystem baseline, and releases the request. If no
replacement VFS appears, the existing upload-inactivity or execution timeout
performs the same rollback and cleanup.

### Scalar Bridge Protocol

Both VFS WIT worlds will expose the same child-process resource with
pointer/length values represented as scalar WIT parameters. Pointers refer
only to the VFS module's own memory. The local generated JavaScript adapter
copies each range before passing data to the host callback, so the host never
dereferences a pointer into another Wasm memory. No WIT lists are used.

The protocol consists of:

- Start a request with serialized metadata lengths and module length; receive
  a request ID.
- Upload null-delimited argv and environment data in bounded chunks.
- Upload module bytes in chunks of at most 256 KiB.
- Run the request and receive scalar status and runner-error length metadata.
- Read a bounded runner error into a Rust-provided buffer in chunks of at most
  64 KiB.
- Recover the ID, lifecycle state, and status of any unacknowledged request;
  active requests can be aborted by the recovering VFS.
- End or abort the request and release all retained host state.

`end` is idempotent and is also the explicit abort operation. A VFS-side guard
calls it after upload, execution, or result-read failures. Request IDs are
never reused while active, and the host permits only one streaming child.

Host cleanup does not depend solely on Rust destructors. An upload request has
a 30-second inactivity timer that is refreshed by each accepted chunk. The
host removes an inactive request even if the VFS traps or is interrupted
before calling `end`. Once execution starts, the parent host's 120-second timer
performs the same independent cleanup. Worker errors and host exceptions
restore the baseline and release the slot. Normal completion terminates the
Worker but retains the request slot and result until VFS acknowledges it.

### Host Runner

The browser and Deno hosts share a child-process bridge implementation. Each
request owns a dedicated Worker. The Worker:

1. Compiles the transferred module.
2. Creates a `WASIFarmAnimal` from
   `@oligami/browser_wasi_shim-threads` using the existing WASIFarm reference,
   argv, and env, without enabling thread spawning.
3. Inherits the farm's stdin, stdout, stderr, and preopened root filesystem.
4. Instantiates the module with the animal's WASI Preview 1 imports and invokes
   its command entry point through `WASIFarmAnimal.start()`.
5. Converts normal return, `proc_exit`, traps, and setup failures into an exit
   status and optional runner error.
6. Posts the result and terminates.

The Worker isolates synchronous Wasm execution from the WebShell VFS worker.
WASI filesystem calls are handled by the existing farm and operate on the
same TypeScript filesystem populated during pre-execution reconciliation. The
parent host owns the 120-second timer and can terminate a stuck child even
when the child's event loop is blocked.

`WASIFarm.get_ref()` returns the same cloneable reference object already sent
to the existing VFS utility Worker. The dedicated child Worker constructs its
own `WASIFarmAnimal` from that reference. Synchronous filesystem and terminal
operations use the shim's existing farm transport; this design adds no direct
Atomics or SharedArrayBuffer implementation.

### Standard I/O

The child uses the existing WASIFarm descriptor mappings. No parallel output
transport or duplicate buffering layer is introduced. Terminal input and
output therefore follow the same ordering, blocking behavior, and resource
management as other processes attached to the farm.

## Limits And Errors

- Module size: 16 MiB.
- Filesystem synchronization: 10,000 entries and 64 MiB.
- Execution timeout: 120 seconds.
- Upload inactivity timeout: 30 seconds.
- Active dynamic children: 1.
- Module upload chunk: 256 KiB.
- Runner-error read chunk: 64 KiB.

Unsupported paths retain exit code 127. Invalid modules, unavailable WASI
imports, resource-limit failures, and timeout failures produce a concise
stderr message and a nonzero status. Host exceptions do not cross the bridge.

Every terminal state terminates the Worker. Abnormal states restore the
baseline and remove retained request data. Gracefully completed filesystem
state is retained until the VFS sends its post-reconciliation
acknowledgement.

## Testing

### Focused Tests

- Bridge validation, chunk boundaries, request ownership, cleanup, and limits.
- Child Worker normal exit, explicit `proc_exit`, trap, and timeout.
- `WASIFarmAnimal` executes a non-threaded command with inherited descriptors.
- Pre-run synchronization exposes existing VFS files to the child.
- Post-run synchronization reflects create, update, delete, and type changes
  into VFS.
- Runtime/cache exclusions are not copied to the child filesystem.
- Concurrent VFS changes are preserved and reported as conflicts.
- Trap and timeout paths restore the TypeScript filesystem baseline.
- An unacknowledged graceful result is imported before the next spawn.
- Unsupported captured dynamic children still return exit code 127.

### WebShell End-To-End Tests

- A minimal project prints a marker through `cargo run` and returns to the
  shell prompt.
- `cargo run -- first second` propagates both arguments.
- A nonzero target reports the real status and stderr.
- A target reads an existing project file, writes another file, and the shell
  reads the new contents after `cargo run` returns.

### Regression Tests

- `cargo build` still completes through the existing rustc spawn path.
- `cargo add hello` still updates the manifest and returns to the prompt.
- `cargo info dashmap` still completes through the HTTP bridge.
- Both generated VFS artifacts validate and remain byte-identical.

## Follow-Up Work

Live filesystem coherence during execution, threaded target execution,
captured build-script execution, and long-running process support require
separate designs. None will be added as part of this implementation.
