# Entry-Owned Rust LSP Starter Design

## Goal

Ensure the browser's VS Code extension API and `MonacoLanguageClient` use one
initialized `vscode` module instance so rust-analyzer startup reaches VFS
pre-population, diagnostics, and Monaco markers.

## Root Cause

`page/src/index.tsx` starts `MonacoVscodeApiWrapper` before dynamically
importing `App`. The lazy App chunk currently imports `rust_lsp_client`, which
causes Vite to emit a second `vscode` extension API module. Service
initialization assigns `defaultApi` in the entry-owned copy, while
`MonacoLanguageClient` construction reads the uninitialized lazy-copy proxy and
throws `Default api is not ready yet`.

Waiting longer cannot initialize the second module instance. Re-importing
`vscode/localExtensionHost` from the lazy chunk is also too late because the
wrapper service lifecycle has already completed.

## Design

`page/src/index.tsx` statically imports `startRustLspClient` before it lazily
imports `App`. Once `ctx` exists, it passes an `startLsp(monaco)` callback that
closes over `ctx` into `App`.

`App` removes its direct `rust_lsp_client` import. Its props accept the typed
starter callback and construct `LspStartGate` with that callback. The gate,
Monaco mount behavior, VFS readiness gate, and cleanup lifecycle remain
unchanged.

This keeps the VS Code API wrapper, the client constructor, and extension API
singleton in the entry dependency graph while retaining lazy loading of the UI
component itself.

## Preserved Invariants

- `MonacoVscodeApiWrapper.start()` completes before `App` is imported and
  rendered.
- The editor mounts before LSP startup so Monaco readiness can satisfy
  `LspStartGate`.
- `/src/main.rs` is only named and populated after `client.start()` resolves.
- VFS pre-population happens before `client.start()`.
- `MonacoLanguageClient` remains the sole Monaco marker owner.
- No direct marker setting, fallback language server, VFS topology change, or
  custom Atomics synchronization is introduced.

## Verification

The change is test-first:

1. Extend `page/src/lsp_start_gate_test.ts` to require an injected App starter
   and reject an App-local `rust_lsp_client` import.
2. Extend `scripts/lsp_browser_diagnostics_test.mjs` to inspect built assets
   before browser launch and require exactly one copy of the default-API error
   literal. The current broken bundle contains two copies, so this test first
   fails against the current production code.
3. After the minimal source change, rerun the focused source test, full-VFS
   semantic publish/clear control, and exact browser semantic marker/clear
   acceptance.

## Alternatives Rejected

- Vite chunk configuration is fragile and treats a singleton dependency
  invariant as an output-layout preference.
- Re-importing or waiting on `vscode/localExtensionHost` in the lazy chunk
  cannot repair a separate module singleton after service startup.
- Restoring immediate main-model creation only perturbs bundle layout and
  violates the approved post-start model ordering.
