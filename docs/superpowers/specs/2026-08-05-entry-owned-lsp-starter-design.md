# Entry-Owned Rust LSP Starter Design

## Goal

Ensure the browser's VS Code extension API and `MonacoLanguageClient` use one
initialized `vscode` module instance so rust-analyzer startup reaches VFS
pre-population, diagnostics, and Monaco markers.

## Root Cause

`page/src/index.tsx` starts `MonacoVscodeApiWrapper` before dynamically
importing `App`. In the failing build, the lazy App chunk imports
`rust_lsp_client` and Vite emits a second `vscode` extension API module.
Service initialization assigns `defaultApi` in the entry-owned copy, while
`MonacoLanguageClient` construction reads the uninitialized lazy-copy proxy and
throws `Default api is not ready yet`.

Waiting longer cannot initialize the second module instance. Re-importing
`vscode/localExtensionHost` from the lazy chunk is also too late because the
wrapper service lifecycle has already completed.

## Design

`page/src/index.tsx` owns an `async startLspClient(monaco)` callback. Once
`ctx` exists, it passes that callback into `App`. The callback dynamically
imports `startRustLspClient` only when `LspStartGate` calls it, which is after
`MonacoVscodeApiWrapper.start()` and both Monaco/VFS readiness gates.

The earlier static-import variant removed the duplicate default-API asset but
caused `monaco-vscode-extensions-service-override` to evaluate in both the
entry and wrapper-triggered dynamic chunks. That registered
`editor.action.measureExtHostLatency` twice. Keeping the load inside the
entry-owned callback retains one owner while preserving the wrapper's dynamic
extension-service loading boundary.

`App` removes its direct `rust_lsp_client` import. Its props accept the typed
starter callback and construct `LspStartGate` with that callback. The gate,
Monaco mount behavior, VFS readiness gate, and cleanup lifecycle remain
unchanged.

`page/vite.config.ts` uses `resolve.dedupe` for the four singleton-bearing
packages that otherwise resolve through both the root and nested Bun `.deno`
paths: `vscode`, `@codingame/monaco-vscode-api`,
`@codingame/monaco-vscode-extension-api`, and
`@codingame/monaco-vscode-extensions-service-override`. All resolve to the
project-root copy, keeping `defaultApi`, API identity, and command registration
in one module instance.

This keeps the VS Code API wrapper, the client constructor, and extension API
singleton in the entry dependency graph while retaining lazy loading of the UI
component itself.

## Preserved Invariants

- `MonacoVscodeApiWrapper.start()` completes before `App` is imported and
  rendered.
- The editor mounts before LSP startup so Monaco readiness can satisfy
  `LspStartGate`.
- `/src/main.rs` VFS pre-population happens before `client.start()`.
- The named `/src/main.rs` Monaco model is created only after `client.start()`
  resolves.
- `MonacoLanguageClient` remains the sole Monaco marker owner.
- No direct marker setting, fallback language server, VFS topology change, or
  custom Atomics synchronization is introduced.

## Verification

The change is test-first:

1. Extend `page/src/lsp_start_gate_test.ts` to require an injected App starter,
   reject every App-local `rust_lsp_client` import, reject index-level static
   imports including side-effect imports, require the index callback's dynamic
   import, and require all four Vite dedupe keys. The source contract checks
   those boundaries without fixing quote style, inline type spelling, or
   whether App props are destructured.
2. Extend `scripts/lsp_browser_diagnostics_test.mjs` to inspect built JavaScript
   assets before browser launch and require the default-API error literal in
   exactly one asset file. The current broken bundle has two such assets, so
   this test first fails against the current production code.
3. After the minimal source change, rerun the focused source test, full-VFS
   semantic publish/clear control, and exact browser semantic marker/clear
   acceptance.

Dynamic chunk-load failures reject the injected starter promise and remain
inside the existing `LspStartGate` startup error path.

## Alternatives Rejected

- Vite manual chunk configuration is fragile and treats a singleton dependency
  invariant as an output-layout preference. `resolve.dedupe` is instead used to
  enforce module identity at resolution time.
- Re-importing or waiting on `vscode/localExtensionHost` in the lazy chunk
  cannot repair a separate module singleton after service startup.
- Restoring immediate main-model creation only perturbs bundle layout and
  violates the approved post-start model ordering.
