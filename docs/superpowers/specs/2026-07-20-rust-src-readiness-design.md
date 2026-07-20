# Rust Source Readiness Design

## Context

The live diagnostics design starts the embedded rust-analyzer after Monaco and
the VFS report readiness. The VFS currently reports readiness before Rust
source is available, while `/rust-project.json` declares
`/sysroot/lib/rustlib/src/rust/library` as `sysroot_src`.

The real rust-analyzer integration test demonstrated the consequence: the
server initializes, then rejects the workspace because the declared sysroot
source has no `core` library. It does not publish diagnostics for the open
document.

## Decision

VFS readiness includes Rust source readiness. During VFS bootstrap, after the
root and terminal session exist, the worker sends a dedicated bootstrap event.
That event invokes the same loader used by `load_sysroot rust-src`, but it is
not TTY input and therefore cannot be confused with a manual command. The
bootstrap operation runs asynchronously and records a one-shot load state.

The load states are `NotStarted`, `Loading`, `Ready`, and `Failed`. An internal
`rustSrcLoadState()` VFS binding exposes the state to the worker. The shell
sets `Ready` only after the load completes and
`/sysroot/lib/rustlib/src/rust/library/core/src/lib.rs` exists. Any command
error or missing crate root sets `Failed`.

The application retains a two-input LSP start gate:

1. Monaco is ready.
2. VFS bootstrap settles successfully, including a complete Rust source tree.

The existing `vfs_ready` callback now carries a discriminated success or
failure result, so startup also settles when rust-src cannot be prepared. A
failure is shown once and prevents LSP startup without leaving an unresolved
frontend wait. No third application readiness channel is introduced.
`rust-project.json` retains `sysroot_src`, preserving rust-analyzer's core and
standard-library analysis. The manual `load_sysroot rust-src` command remains
available and uses the same underlying loader, but it does not read or mutate
the bootstrap state.

This supplemental design overrides the earlier live-diagnostics design where
it described `vfs_ready_id` as a payload-free success notification.

## Data Flow

1. The VFS worker instantiates the component and creates terminal session 0.
2. It dispatches the dedicated rust-src bootstrap event exactly once.
3. The bootstrap wrapper records `Loading` and invokes the shared shell loader.
4. The loader calls the existing `sysrootStartFetch("rust-src")` host
   bridge.
5. The browser downloads and decompresses the hosted rust-src archive.
6. The shell writes the archive entries below
   `/sysroot/lib/rustlib/src/rust/library`.
7. The bootstrap wrapper verifies the `core` crate root and records `Ready` or
   `Failed`.
8. The worker polls `rustSrcLoadState()` without blocking the shell worker.
9. The worker calls `vfs_ready` with success on `Ready` or with the concrete
   error on `Failed`.
10. The application starts the language client only for the success result.

## Failure Handling

A fetch, decompression, VFS write, or final validation failure records
`Failed`. The terminal reports the concrete failure, and `vfs_ready` reports a
failure result so the application startup wait settles. Editing and normal
terminal interaction remain available, but rust-analyzer does not start with a
known-invalid workspace.

The browser host applies a bounded timeout to fetching and decompressing
rust-src. Timeout rejects the host bridge operation and therefore follows the
same `Failed` transition; the worker does not abandon an operation that can
later report `Ready`. State transitions are monotonic: `NotStarted` to
`Loading`, then exactly one of `Ready` or `Failed`.

An empty archive is a failure because final validation cannot find the `core`
crate root. Bootstrap performs the load once per VFS worker instance; it does
not add retry loops or silently remove `sysroot_src`.

## Testing

The real embedded rust-analyzer integration test prepares the compiled target
sysroot and serves the cached rust-src archive through the existing host
bridge. It drives the same dedicated bootstrap event, state query, and
readiness-result contract as production. It then preserves the production
`rust-project.json`, initializes the embedded server, opens invalid Rust,
verifies an error diagnostic, changes the document to valid Rust, and verifies
that error diagnostics clear.

Because rust-analyzer writes from a spawned Wasm worker, the test parent
forwards `terminalWrite` payloads to the diagnostics worker over a dedicated
`MessageChannel`. Both main-thread and spawned-worker output feed the same LSP
frame decoder.

A focused bootstrap test verifies dedicated-event identity, monotonic state
transitions, failure and host-timeout paths, and that the readiness result is
successful only after `core/src/lib.rs` validation. It also verifies that a
failure result settles the application gate without starting the client. The
browser acceptance test then verifies that the resulting LSP diagnostics
become Monaco markers and disappear after correction.

## Non-Goals

- Changing rust-analyzer, Cargo, rustc, `wasi_virt_layer`, or browser shim
  artifacts.
- Removing `sysroot_src` to reduce startup time.
- Adding a new user-visible loading workflow or retry control.
- Caching beyond the browser's existing HTTP behavior and the integration
  test's existing local artifact cache.
