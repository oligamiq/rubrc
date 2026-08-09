# Browser Diagnostics Final Hardening Design

## Goal

Close the blocking lifecycle, cache-readiness, and memory findings from the
whole-branch rust-analyzer browser diagnostics review without changing the
validated semantic diagnostics architecture.

The browser must still start the VS Code wrapper before importing `App`, wait
for Monaco and VFS readiness, prepopulate `/src/main.rs` before
`client.start()`, create the named Monaco model only after startup, and let
`MonacoLanguageClient` own diagnostic markers.

## Scope

This hardening addresses five confirmed root causes:

1. The temporary Monaco model is editable during startup, so edits are lost
   when Solid Monaco switches to the post-start named model. The temporary
   model is also not disposed after the switch.
2. LSP startup timeout and component unmount cannot cancel an in-progress
   `MonacoLanguageClient.start()` operation promptly.
3. The same-origin rust-src archive uses a stable CacheStorage key across
   deployments.
4. Guest rust-src readiness can remain in `Loading` forever after a guest-side
   stall or panic.
5. A sysroot read can request up to 50 MiB, which expands into large JavaScript
   number arrays and multiple byte-buffer copies across the host boundary.

Streaming tar parsing, worker restart, editable pre-start model replay, and
unrelated bridge hardening are explicitly outside this change.

## Editor Handoff

The post-start named-model invariant remains binding. `App` renders the
temporary Monaco model as read-only. A separate editor-ready signal, rather
than LSP readiness itself, controls when the editor becomes editable.

`handleMount` captures the temporary model and installs a one-shot
`onDidChangeModel` listener. When Solid Monaco switches to
`file:///src/main.rs`, the listener disposes the previous temporary model,
marks the editor ready, and then disposes itself. The named model cannot become
editable before the handoff finishes. If the component unmounts before a
switch, Solid Monaco's existing cleanup owns the current temporary model and
App only disposes the listener.

This prevents lost user work by prohibiting edits that cannot be preserved,
retains editor-before-LSP gate satisfaction, and avoids one leaked model per
mount.

## Startup Cancellation

`LspStartGate` owns an `AbortController`. Its starter interface becomes:

```ts
(monaco: TMonaco, signal: AbortSignal) => Promise<DisposableLspSession>
```

`dispose()` marks the gate disposed and aborts before waiting for the pending
start promise. The signal flows through the entry-owned callback into
`startRustLspClient` and `runRustLspStartup`.

`runRustLspStartup` calls `startClient()` exactly once and retains that promise.
It attaches a rejection observer immediately, so a promise that outlives the
secondary cancellation deadline can never become an unhandled rejection.
If the timeout or abort signal wins, it invokes a `cancelClientStart` action
that disposes the already-created LSP message transports.
`MyMessageReader.dispose()` emits its close event before destroying its
emitters, causing pending JSON-RPC initialize work to reject. The startup
sequencer waits for the retained start promise to settle before it rethrows the
original timeout or abort reason. That secondary wait has a short independent
deadline so a defective transport cannot make component disposal unbounded;
after the deadline, ordinary owner cleanup still closes every directly owned
resource and reports any client-state cleanup error.

On successful startup, abort listeners and the timeout are removed before the
named model is created. A later gate disposal uses the returned session's
existing cleanup path. The gate's existing post-resolution disposed check
closes the handoff race by disposing a session that resolves after `dispose()`
was called. App attaches an error handler to asynchronous gate cleanup so
cleanup failures do not become unhandled rejections.

## Rust-Source Cache And Readiness

Vite defines a build-time source revision from `SOURCE_SHA`, falling back to
the explicit value `development` outside production publishing. The Pages
publish script passes its already-validated Git source SHA into `build:prod`.

Only the same-origin rust-src URL receives `?v=<source revision>`. External
target sysroot URLs retain their existing versioned paths. After the new
rust-src archive parses successfully, cache maintenance fetches the existing
`.rubrc-pages-build.json` with `cache: "no-store"`. It deletes other cached
requests with the same origin and rust-src pathname only when the deployed
metadata SHA equals the running bundle's source revision. A stale background
tab therefore cannot delete a newer deployment's cache. Failed or partial
loads, metadata failures, and non-current bundles retain existing entries and
do not evict unrelated cached assets.

`waitForRustSrcBootstrap` receives a configurable outer timeout. Production
uses a budget longer than the archive loader's 60-second network/parser
timeout. A persistent `NotStarted` or `Loading` state returns the existing
`VfsReadyResult` failure shape with a timeout message. The waiter reports once
and stops polling; a later guest state change cannot emit a second readiness
result. The UI follows its current degraded path: terminal controls become
available, while `LspStartGate` refuses to start rust-analyzer.

## Sysroot Transport Bound

The guest's per-call sysroot read limit returns from 50 MiB to 512 KiB. The
host validates the same upper bound and rejects an oversized request instead
of silently truncating it. This is a custom exact-length chunk protocol, not a
POSIX/WASI `read`: the updated guest always requests at most the cap, so an
oversized host request indicates a version or protocol mismatch. This caps
number-array and codec amplification while preserving the existing chunked WIT
protocol and whole-file guest assembly.

The tar parser remains non-streaming in this change. Its peak memory and the
long-lived rust-src backing buffer are documented follow-up risks, but they no
longer combine with a single 50 MiB host payload.

## Error Semantics

- Timeout and abort preserve their original error as the startup failure.
- Transport-close rejection is observed permanently; active cancellation waits
  for settlement only within its independent bounded deadline.
- Cleanup failures remain observable through `console.error` and do not become
  unhandled promise rejections.
- Rust-src readiness timeout returns `{ ok: false, error }`; it does not invent
  a fallback language server or bypass VFS readiness.
- Oversized sysroot chunk requests fail at the host boundary rather than
  producing a partial response.

## Test Strategy

Every behavior change follows a separate RED/GREEN cycle:

1. Editor source contracts require reactive startup read-only behavior and
   one-shot temporary-model disposal. Browser acceptance requires one remaining
   Rust model at `file:///src/main.rs` and an editable editor after readiness.
2. Gate tests require disposal to abort and settle a pending starter. Startup
   tests require `cancel -> start settled -> cleanup` ordering. Bridge tests
   require reader disposal to emit close exactly once.
3. Sysroot URL tests require a revision only for rust-src, a publishing
   contract requires `SOURCE_SHA` to reach the production build, and cache
   tests require pruning only when no-store deployment metadata matches the
   running revision.
4. Readiness tests hold the guest permanently in `Loading`, use a fake deadline,
   require a timeout failure, and require exactly one bootstrap dispatch.
5. Full-VFS diagnostics records the maximum requested chunk and rejects values
   above 512 KiB before the guest cap is restored.

Fresh final verification includes focused Deno tests, VFS Rust tests, Vite and
VFS builds, Wasm validation and required exports, exact browser semantic marker
publish/clear, full-VFS publish/clear, the clean branch's direct minimal
control, and the layered control from the validated read-only reference
worktree. The external rust-analyzer source fixture mismatch in the boundary
trace contract remains a separately reported baseline limitation.

## Rejected Alternatives

- Creating the named Monaco model before LSP startup would preserve early edits
  but violate the approved post-start model ordering.
- Replaying temporary-model edits would preserve both properties but adds a
  cross-startup synchronization path that is unnecessary when startup editing
  is explicitly disabled.
- Streaming tar parsing and worker restart would improve resilience further but
  are independent architectural changes.
- Leaving the 50 MiB transport as a documented pre-existing risk would keep a
  confirmed high-memory failure mode in the branch's final integration gate.
