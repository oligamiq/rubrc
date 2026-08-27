# Staged rust-analyzer Startup Design

## Problem

Browser startup currently blocks rust-analyzer behind the complete sysroot bootstrap. The shell loads the target sysroot before `rust-src`, and the named `file:///src/main.rs` Monaco model is not created until rust-analyzer has started and `didOpen` has completed. If rust source loading fails, the editor remains attached to a blank temporary model and the user sees only a generic missing-`core` warning.

Startup must instead show editable code immediately, initialize the rust-analyzer server before Cargo-related project work, load independent assets in parallel, verify `core` explicitly, and retain a visible progress indicator until initial semantic analysis has completed.

## Goals

- Show `file:///src/main.rs` with the initial code as soon as Monaco mounts.
- Keep the editor editable during all startup phases.
- Initialize the rust-analyzer process and LSP connection before enabling project and Cargo work.
- Fetch independent sysroot archives in parallel with rust-analyzer's lightweight initialization.
- Do not activate the Rust project until `rust-src/core` and the target sysroot are installed and verified.
- Re-snapshot current editor text at every startup boundary so early edits are never overwritten.
- Keep an editor-local loading overlay visible until initial diagnostics and an explicit semantic request complete.
- Preserve terminal detail logs while presenting concise progress in the editor.
- Produce specific failures instead of reducing every rust source failure to "missing core".

## Non-Goals

- Replacing MonacoLanguageClient diagnostics with manual markers.
- Allowing Run or other Cargo operations before project activation completes.
- Changing normal post-startup `didChange` or debounced VFS synchronization behavior.
- Redesigning the terminal or application shell.
- Introducing Atomics, `SharedArrayBuffer`, WIT lists, or Rust re-entry from JavaScript callbacks.

## Startup Coordinator

A single `StartupCoordinator` owns the browser startup generation, phase, progress, failure, and readiness promise. Existing readiness helpers become inputs to this coordinator rather than independent sticky gates.

The coordinator exposes a read-only state suitable for Solid UI rendering:

```ts
type StartupPhase =
  | "editor-visible"
  | "vfs-starting"
  | "analyzer-initializing"
  | "sysroots-loading"
  | "project-activating"
  | "semantic-warming"
  | "ready"
  | "failed";

type StartupState = {
  generation: number;
  phase: StartupPhase;
  tasks: Array<{
    id: "editor" | "analyzer" | "rust-src" | "target-sysroot" | "project";
    label: string;
    state: "pending" | "running" | "complete" | "failed";
    progress?: number;
  }>;
  error?: string;
};
```

Only the active generation may publish state or send activation events. Completion from an older generation is ignored.

## Startup Phases

### 1. Editor Visible

Monaco creates exactly one named model at `file:///src/main.rs` with language `plaintext` and the initial code. It is attached immediately and remains editable. Using plaintext prevents the Rust language client from sending an early `didOpen` before the project is ready.

The loading overlay appears inside the editor. It does not hide the code or block editing. Run and Cargo-related controls remain disabled.

### 2. VFS Starting

The VFS Wasm download, compilation, worker startup, and filesystem import begin. In parallel, the browser starts fetching and decompressing:

- `rust-src`, which must contain `core/src/lib.rs`.
- The selected target sysroot, initially `wasm32-wasip1`.

Archive fetch completion does not permit shell extraction or Cargo work by itself.

### 3. Analyzer Initializing

After the VFS runtime can accept LSP bytes and workspace writes:

1. Read the current Monaco model text.
2. Write it to the browser workspace and Rust VFS.
3. Start rust-analyzer with a lightweight initialization configuration that has no linked project and does not trigger Cargo metadata.
4. Wait for the LSP `initialize`/`initialized` handshake to complete.

The model remains plaintext, so no Rust `didOpen` is sent during this phase.

The lightweight configuration sets `rust-analyzer.linkedProjects` to an empty list and suppresses automatic project discovery. The integration trace must prove that no host Cargo or embedded rustc request occurs in this phase; configuration alone is not accepted as proof.

`MonacoLanguageClient.start()` is invoked explicitly. Its initialize handshake does not depend on a model matching the Rust `documentSelector`; the selector intentionally prevents document synchronization and feature routing while the named model remains plaintext.

### 4. Sysroots Loading

Once their downloads and the VFS runtime are ready, `rust-src` and the target sysroot are extracted concurrently where the VFS transaction model permits it. If the guest filesystem requires serialization, extraction is serialized while fetch/decompression remains parallel.

`rust-src` readiness requires all of the following:

- The complete archive extraction task has returned successfully.
- The archive index contains `core/src/lib.rs`.
- The browser workspace contains `/sysroot/lib/rustlib/src/rust/library/core/src/lib.rs` with non-empty file data.
- The Rust VFS contains the same path with non-empty file data.

The target sysroot requires successful completion of its complete extraction task plus an equivalent target-specific existence check for its `core` library artifact. A partial extraction or a generic completed archive transfer is not sufficient readiness.

No linked-project configuration, `didOpen`, Cargo metadata, Run, or shell Cargo command is allowed before both sysroot tasks complete.

### 5. Project Activating

After lightweight analyzer initialization and both sysroot barriers complete:

1. Wait for the initial browser-filesystem import, including `/Cargo.toml`, `/.cargo/config.toml`, and `/rust-project.json`, to be fully flushed into the Rust VFS.
2. Read the latest editor text again.
3. Synchronize it to the browser workspace and Rust VFS, and await completion.
4. Send `workspace/didChangeConfiguration` with the full sysroot, sysroot source, and linked-project settings.
5. The linked-project crate uses the unique `display_name` `rubrc-main`. Poll `rust-analyzer/viewCrateGraph` with `{ full: true }` at a bounded interval until its Graphviz DOT response contains both the exact `rubrc-main` workspace node label and the exact `core` sysroot node label. The bundled rust-analyzer emits crate display names, not root-module paths, in this graph. This is the observable completion condition for the automatic workspace fetch caused by the `linkedProjects` change. Do not send a redundant `rust-analyzer/reloadWorkspace` request.
6. Install the version-scoped diagnostics readiness listener.
7. Change the named model language from `plaintext` to `rust`.
8. Allow MonacoLanguageClient to send the standard `didOpen` only after the crate graph is attached.

Project activation is the first point at which rust-analyzer may perform Cargo metadata or embedded rustc work.

### 6. Semantic Warming

Workspace attachment and document semantic warming are strictly sequential. Responses received before crate-graph confirmation cannot satisfy semantic readiness. After `didOpen` completes, the coordinator waits for both:

- A `publishDiagnostics` notification for the latest version of `file:///src/main.rs`, including an empty diagnostics array.
- A successful `textDocument/inlayHint` response for the latest document version and its current full range. An empty hint array is a successful response.

Readiness does not depend on optional `rustAnalyzer/Fetching end` telemetry. `rust-analyzer/viewSyntaxTree` is not used as the semantic barrier because it can succeed for a detached file without a complete crate graph. `rust-analyzer/fetchDependencyList` is not used because it excludes local workspace crates.

The LSP client advertises `textDocument.publishDiagnostics.versionSupport = true`, and startup rejects unversioned diagnostics as insufficient readiness. The coordinator dispatches the `textDocument/inlayHint` request directly; it does not depend on Monaco's viewport-driven automatic hint request.

Edits remain enabled. Changes after `didOpen` use normal immediate LSP `didChange` delivery and the existing debounced filesystem mirror.

Semantic readiness is associated with a concrete document version. Every `didChange` invalidates in-flight semantic readiness and resets the inactivity timeout. The coordinator waits for diagnostics and the semantic response corresponding to the latest version after a bounded quiet window. Continuous user editing keeps the overlay in `semantic-warming`; it does not produce a false startup failure.

### 7. Ready

The editor overlay is removed and Run/Cargo controls become enabled. The coordinator's readiness promise resolves only at this phase.

## Loading UI

The editor-local overlay displays a concise task list over the visible code:

```text
Rust toolingを準備中

✓ エディタ
✓ rust-analyzer
◌ Rust core                 68%
◌ wasm32-wasip1 sysroot    42%
○ プロジェクト解析
```

The UI requirements are:

- Code stays visible behind the overlay.
- Editing remains possible throughout startup.
- Phase text updates before expensive work begins; the browser must receive a rendering opportunity before a long synchronous operation.
- Archive progress is reported when byte totals are known. Indeterminate tasks use a spinner without fabricated percentages.
- Detailed VFS and extraction logs remain in xterm.
- Failures replace the progress list with the failed task and actionable message while retaining code and edits.

## Code Synchronization Contract

The model shown to the user is authoritative from the moment it is created.

- Initial model construction uses the default source exactly once.
- Immediately before rust-analyzer process startup, the coordinator snapshots the current model into both filesystem layers.
- Immediately before project activation, it snapshots the current model again.
- `didOpen` is forwarded only after the activation snapshot reaches the Rust VFS.
- No later startup callback may write the original default source.
- After `didOpen`, existing immediate LSP changes and 300 ms debounced VFS writes continue unchanged.
- Run retains its flush barrier and additionally requires coordinator phase `ready`.

## Load Ordering and Concurrency

The dependency graph is:

```text
Monaco mounted -> named model visible/editable

VFS runtime ---------------------> lightweight analyzer initialize ----+
     |                                                               |
     +-> rust-src fetch -> rust-src install -> core verification -----+
     |                                                               +-> project activation
     +-> target fetch -> target install -> target verification -------+        |
                                                                               +-> didOpen
                                                                               +-> semantic warming
                                                                               +-> ready
```

Fetch/decompression is parallel. Filesystem mutations follow existing transaction locks. Cargo-related work begins only through project activation after all prerequisites are satisfied.

The shell's demonstration precommands must not automatically load a target sysroot ahead of the coordinator. Automatic target loading becomes an explicit coordinator event or command with observable completion. Interactive shell input handlers should be registered once the runtime is available rather than after rust source bootstrap.

## Core Handling

The rust source pipeline must distinguish these failures:

- Asset request failed or returned an invalid response.
- Brotli decompression failed.
- Tar parsing failed.
- Archive did not contain `core/src/lib.rs`.
- Browser filesystem population failed.
- Rust VFS extraction failed.
- Browser core path validation failed.
- Rust VFS core path validation failed.

Build and serving paths must guarantee that `rust-src.tar.vfsbr` is present. Production and browser-test builds continue to invoke the asset preparation script. Development startup continues to use the validated development asset plugin. A plain page build that omits the asset must fail with a specific missing-asset message rather than a misleading rustup suggestion.

## Error and Timeout Behavior

- Every phase has a bounded timeout and reports its phase name.
- A failure transitions only the current generation to `failed`.
- Code and edits remain visible and preserved.
- Run/Cargo controls remain disabled because the project state is not trustworthy.
- Terminal-only functionality that does not depend on Cargo may remain available.
- Reload first disposes the prior `MonacoLanguageClient`, LSP transports, SharedObject references, timers, and document-sync middleware, then terminates the generation-owned WebAssembly workers. Only after teardown settles may it create a new generation.
- Stale work from a prior generation cannot publish state or send LSP events, even while teardown is settling.
- The generic missing-core readiness message is removed in favor of the originating error plus the failed validation path.
- Semantic warmup timeout after the latest document version has remained unchanged for the configured quiet window is an error, not readiness. The overlay remains with retry/reload guidance.

## Component Boundaries

- `StartupCoordinator`: phase machine, dependencies, generation ownership, readiness.
- `RustAnalyzerSession`: lightweight initialization, full configuration activation, semantic probe.
- `SysrootBootstrap`: fetch, extraction request, browser/Rust verification, progress.
- `EditorStartup`: named model creation, language activation, authoritative snapshots.
- `StartupOverlay`: pure rendering of coordinator state.

`RustAnalyzerSession.dispose()` owns complete LSP and worker teardown. `StartupCoordinator` must await it before replacing a generation.

Each component exposes promises/events and does not directly mutate another component's internal state.

## Testing

### Unit and Contract Tests

- State transitions follow the approved phase order.
- Analyzer initialization and archive fetches overlap.
- Project activation cannot occur before analyzer, rust-src/core, and target barriers complete.
- Project activation cannot occur before the initial `/Cargo.toml`, Cargo config, and rust-project filesystem import completes.
- The named model is visible and editable before analyzer startup.
- Edits made during initialization are used by both pre-start and pre-activation snapshots.
- The initial default source is never written after user edits.
- No Cargo/sysroot activation event is sent before lightweight analyzer initialization completes.
- `didOpen` follows the final VFS write.
- Crate-graph polling must complete before `didOpen`; only subsequent diagnostics and inlay-hint responses may satisfy `ready`.
- A `didChange` during semantic warming invalidates earlier responses and resets the quiet-window timeout.
- Old-generation completions are ignored.
- Starting a replacement generation disposes the previous language client and terminates its workers.
- Failure messages preserve the originating stage.

### Sysroot Tests

- The archive must contain `core/src/lib.rs`.
- Browser and Rust filesystem verification must both succeed.
- Missing asset, malformed archive, missing core, and write failure are distinguishable.
- The 74,096,640-byte OOM regression archive remains streamed with a bounded host request.

### Browser Acceptance

The browser test observes this order:

1. Named source model and code are visible.
2. Editor is editable while the loading overlay is visible.
3. Analyzer lightweight initialization completes.
4. Core and target sysroot complete.
5. Project activation and `didOpen` complete.
6. First diagnostics and semantic response complete.
7. Overlay disappears and Run becomes enabled.

The test also edits the source during startup and verifies that rust-analyzer analyzes the edited text, not the default source.

## Acceptance Criteria

- No startup path presents a blank editor after Monaco mounts.
- No missing-core warning is emitted before the core bootstrap has completed or failed specifically.
- rust-analyzer's LSP initialization completes before project/Cargo activation.
- Independent network and runtime preparation work overlaps.
- `core/src/lib.rs` exists in both filesystem layers before project activation.
- Initial semantic analysis completes before loading UI disappears.
- User edits made at any startup phase survive and are reflected in rust-analyzer.
- Run/Cargo actions cannot execute before readiness.
- Existing diagnostics ownership, `didChange` behavior, and run flush semantics remain intact.
