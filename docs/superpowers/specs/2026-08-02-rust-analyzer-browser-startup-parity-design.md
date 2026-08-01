# Rust-Analyzer Browser Startup Parity Design

## Goal

Make rust-analyzer start in the rubrc browser application and publish diagnostics that Monaco renders as markers. The existing full-VFS diagnostics harness is the behavioral reference because it already initializes rust-analyzer and publishes and clears diagnostics in the current worktree.

## Current Difference

The full-VFS harness sends `textDocument/didOpen` after the initialize response. Production instead waits for a `rustAnalyzer/Fetching` progress notification with `kind: "end"` before creating `file:///src/main.rs`.

The progress notification is not a guaranteed startup-completion contract. If it is absent or never ends, no Monaco model is created, no `didOpen` is sent, and production reports `rust-analyzer project loading timed out` after 300 seconds even though the language client may already be initialized.

## Scope

This change will:

- preserve the full VFS composition and embedded Cargo/rustc path;
- preserve the existing worker, rust-src bootstrap, and editor readiness gates;
- pre-populate `/src/main.rs` in the VFS before LSP initialization;
- make `client.start()` the only rust-analyzer startup gate;
- create the main Rust model immediately after initialization;
- keep `rustAnalyzer/Fetching` as non-blocking telemetry;
- verify that pushed diagnostics become Monaco markers and clear after a valid edit;
- retain current debug instrumentation until browser markers work reliably.

This change will not:

- replace production with the minimal layered backend;
- rewrite LSP stdin or Cargo host boundaries;
- add a fallback language-server path;
- set Monaco markers directly;
- clean up unrelated debug instrumentation or existing dirty changes.

## Startup Architecture

The application continues to wait for both Monaco and the VFS worker to become ready through `LspStartGate`. Worker readiness remains downstream of VFS initialization and rust-src bootstrap.

`startRustLspClient` then creates the VFS writer and awaits writing the default Rust document to `/src/main.rs` before starting the language client. This gives the linked project a valid root module while rust-analyzer initializes. It then creates the document synchronization middleware, LSP transport, and `MonacoLanguageClient`. The call to `client.start()` remains bounded by the existing 300-second timeout. Once `client.start()` resolves, the application creates `file:///src/main.rs` if it does not already exist.

Creating the model causes the language client to open the document. `RustDocumentSync.didOpen` first mirrors the document contents into the VFS and then forwards `didOpen`, preserving filesystem-before-LSP ordering. Subsequent edits continue through the existing debounced VFS synchronization and LSP `didChange` path.

The language client remains the sole owner of pushed diagnostics and Monaco marker updates. Pull diagnostics remain disabled, and no custom `setModelMarkers` call is introduced.

## Progress And Failure Handling

The `rustAnalyzer/Fetching` progress listener remains installed for test telemetry and debugging, but startup does not await it. A missing progress begin/end pair therefore cannot block model creation. Recent progress and connection events remain attached to acceptance-test failures so a dependency or bridge failure is visible without treating progress completion as a readiness contract.

The startup timeout applies to `client.start()`. If initialization fails or times out, `RustLspResourceOwner` disposes the client, transport, document synchronization, and VFS shared reference while preserving the original startup error.

The browser acceptance path records these milestones:

1. VFS worker ready
2. default `/src/main.rs` VFS pre-population completed
3. LSP transport connected
4. initialize response received
5. main model created
6. `didOpen` VFS mirror completed
7. `didOpen` completed
8. diagnostics published
9. Monaco marker observed
10. marker cleared after a valid edit

Failures report the last completed milestone and recent LSP/progress events instead of only reporting a global timeout.

## Testing

Implementation follows a regression-first sequence:

1. Add a focused test in which `client.start()` resolves but `rustAnalyzer/Fetching` never emits `end`. The expected result is that the main model is still created.
2. Update the existing startup-order contract so it requires model creation after `client.start()`, without requiring a second progress-readiness wait.
3. Preserve the `RustDocumentSync` test proving that the `didOpen` VFS mirror completes before `didOpen` is forwarded.
4. Run the full-VFS diagnostics harness and require initialize plus diagnostics publish/clear.
5. Run the browser acceptance test, edit the Rust model to a semantic type mismatch, and require a `rust-analyzer` Monaco marker whose message identifies the mismatch.
6. Restore valid Rust and require the marker to clear.
7. Re-run the minimal direct and layered controls and require the layered result to remain `non-hang`.

Deterministic local milestones have short bounded waits so a failure identifies the first divergent boundary. The semantic-marker milestone may require background sysroot and project loading, so it receives the remainder of the 300-second global budget instead of a short fail-fast timeout. The overall startup timeout remains the final safety limit for background analysis.

## Success Criteria

The work is complete when the rubrc browser application:

- starts rust-analyzer without waiting for `rustAnalyzer/Fetching` completion;
- creates and opens `file:///src/main.rs` after LSP initialization;
- mirrors the document to the full VFS;
- receives pushed diagnostics for a semantic type mismatch;
- exposes those diagnostics as Monaco markers;
- clears the markers after a valid edit;
- keeps the existing full-VFS and minimal layered diagnostics checks passing.
