# Base-Call OOM Diagnostics Design

## Goal

Identify which runtime host callback fails when browser cold startup reports
`base call failed: OutOfMemory`, without changing startup ordering, allocator
capacity, WebAssembly memory limits, or production behavior.

## Context

The browser acceptance test has produced three relevant outcomes from the same
fresh VFS artifact:

- A complete browser run passed.
- A run terminated by the outer command timeout surfaced as `frame got detached`.
- A later full run failed during `sysroots-loading` with
  `base call failed: OutOfMemory`, while subsequent direct browser runs passed.

The OOM is emitted by the independent 64 MiB base-call payload allocator used by
`WASIFarm`, not by the 8192-page rust-analyzer own-memory reserve. Existing
evidence does not identify whether the failed allocation belongs to a request,
a response, or which callback was active.

## Scope

Modify only test-build observability and browser failure reporting:

- `page/src/worker_process/vfs_bindings/inst.ts`
- `page/src/worker_process/util_cmd.ts`, only to remove the superseded wrapper
- `scripts/lsp_browser_diagnostics_test.mjs`
- `scripts/lsp_browser_diagnostics_contract_test.ts`
- focused tests for any extracted pure helper, if one is needed

Do not modify the allocator implementation, dependency patch, capacities,
startup semantics, retry behavior, or production telemetry.

## Design

### Host-Call Trace

The first implementation attempt wrapped the forwarding callback passed by
`startUtilityGuest` in `util_cmd.ts`. A fresh browser run proved that this is not
the active boundary: sysroot and cargo calls made by rust-analyzer execute in
child thread workers, whose generated `thread_spawn.ts` forwards directly from
the authored and preserved `vfs_bindings/inst.ts` adapter to
`animal.call_unknown_fn`. The built bundle contained the `util_cmd.ts` allowlist
but emitted no `host-call` lines.

When `import.meta.env.VITE_RUBRC_LSP_TEST === "1"`, route the four relevant Wasm
imports in `vfs_bindings/inst.ts` through the existing `traceVfsHostCall` helper.
Trace these callback names:

- `sysrootStartFetch`
- `sysrootArchiveGetMeta`
- `sysrootReadArchiveChunk`
- `hostRunCargo`

The existing trace format records a call ID, callback name, and `request`,
`response`, or `reject` phase. IDs increase monotonically within each worker's
VFS instance. Calls outside this allowlist retain their current behavior.
Non-test builds continue to call the supplied `call_unknown_fn` directly.

Do not edit generated `vfs_bindings/thread_spawn.ts` or patch its copy process.
`inst.ts` is an authored overlay preserved by `scripts/copy_vfs_bindings.mjs`, so
instrumentation there survives binding regeneration and covers both root and
child-thread instances. Remove the superseded `util_cmd.ts` callback wrapper to
avoid double tracing root-instance calls.

Tracing must wrap the existing call exactly once and must not retry it. This is
important because callbacks may have side effects and the base-call API is not
idempotent.

`sysrootReadArchiveChunk` produces many calls. The test trace may contain every
call because exact request/response pairing is required to identify the first
unmatched or rejected operation. The existing bounded trace collector remains
the only storage and truncation mechanism.

### Fatal Error Detail

When cold startup sees console text containing
`base call failed: OutOfMemory`, evaluate the console arguments before rejecting
the fatal promise. Preserve the Error name, message, and stack when available,
plus the console source location. Include these details in the fatal error text.

Failure to inspect a console argument must not hide the original OOM. Represent
an uninspectable argument as a string and still reject with the original fatal
classification.

### Failure Interpretation

On the next reproduced OOM:

- A `host-call ... phase=reject` identifies a reference-side request allocation
  failure or a terminal allocator failure returned by the Park.
- A final `phase=request` without `response` or `reject` identifies the callback
  active when transport termination interrupted observation.
- The captured Error stack identifies the generated/import call site and helps
  distinguish request publication from response consumption.

This change diagnoses the failing boundary. It does not claim to distinguish
allocator exhaustion from allocator corruption; allocator-internal statistics
remain a separate follow-up only if boundary tracing is insufficient.

## Tests

Use TDD for the diagnostics changes:

1. Extend the browser diagnostics contract test to require test-build tracing
   for all four callback names and to require OOM console-argument inspection.
2. Confirm the contract test fails before implementation.
3. Implement the smallest forwarding and error-detail changes.
4. Run the contract test and the existing `traceVfsHostCall` unit tests.
5. Build the test page and run direct browser acceptance on port 4174. A
   successful cold startup must observe paired sysroot host-call trace events in
   the existing bounded collector so a source-only or dead-path implementation
   cannot pass.
6. Run the focused 120-test startup-progress suite and `git diff --check`.

Because the OOM is nondeterministic, a successful browser run verifies that the
instrumentation preserves behavior. A future failed run supplies the diagnostic
evidence; reproducing the OOM is not required to accept this observability-only
change.

## Constraints

- Preserve the dirty worktree and all unrelated changes.
- Do not stage or commit files.
- Keep port 4173 untouched; use port 4174 for browser acceptance.
- Do not add another crate-graph request or another telemetry channel.
- Do not increase the 64 MiB base-call allocator or any WebAssembly memory limit.
