# Opt-in RA single-project initialization implementation

Date: 2026-11-26 JST. Base HEAD: `1a06207659f0677c4f61d21b736738c08d1a83e9` (uncommitted implementation). Workspace: `/home/oligami/projects/rubrc`. Deno 2.9.7, V8 15.0.245.2-rusty, TypeScript 6.0.3; Bun 1.4.2 (744846f84), Linux x86_64. Read [startup-path audit](<startup-path-audit.md>) before implementation. Environment/status evidence: [provenance log](<single-project-init-provenance.log>).

## Objective and design

Implement only the full-inline initialization experiment on the existing cache/sysroot-first startup path, without changing the document lifecycle, graph proof, semantic readiness, configured thread count, cancellation or ownership/cleanup behavior.

- The coordinator now supplies `AnalyzerInitializationContext { sysrootsReady }`. It passes **true only after successful prefetch and sysroot installation plus the existing abort check** on the cache/sysroot-first branch. It passes false on the analyzer-first branch. Installation failure, cache-preparation exception, or abort does not advertise successful initialization. Cache-preparation returning false keeps the existing fallback order.
- App carries this capability through its existing session wrapper to the runtime entrypoint caller. The caller selects the experiment only when `import.meta.env.VITE_RUBRC_RA_SINGLE_PROJECT_INIT === "1"` **and** `context.sysrootsReady`. No low-level configuration/client code reads the flag. The flag alone does not change coordinator ordering. As with other Vite environment flags, set it when building/serving the application; this is not a query parameter or a post-build mutable browser environment variable.
- Each client configuration state constructs one deeply frozen full settings snapshot with the browser-selected RA main-loop thread count. Experiment mode uses it for initialization options and all workspace/configuration responses from the beginning. Activation returns null (no configuration update/state transition). Legacy mode retains lightweight initialization, switches to the full snapshot at activation, and sends exactly one configuration notification. Its notification now uses the same selected-thread snapshot as its response instead of reconstructing a default-thread payload (RA previously ignored the payload and queried the response).
- Activation skips **only** `workspace/didChangeConfiguration` when the state says full settings were supplied at initialization. Graph polling, activation snapshot write, readiness diagnostic reset, plaintext/didClose, Rust/strict didOpen with latest-content mirror, semantic provider opening, fresh versioned diagnostics and explicit inlayHint proof are unchanged. No reloadWorkspace request was added.
- Existing test activation scenarios run in both legacy and single-init mode: order, model identity, abort during snapshot, edits during activation, every remaining abort barrier, pending mutation settlement, observation cancellation, late rejection handling, and post-semantic abort. Additional real readiness test confirms diagnostics produced before the activation reset cannot satisfy readiness, even when the graph was already complete. Mocked production client tests verify initial configuration identity, activation notification count, selected-thread settings, channel cleanup and startup cancellation in both modes.

## Exact edited source/test files

Production:

- [startup_coordinator.ts](</home/oligami/projects/rubrc/page/src/startup_coordinator.ts>)
- [rust_lsp_config.ts](</home/oligami/projects/rubrc/page/src/rust_lsp_config.ts>)
- [rust_lsp_startup.ts](</home/oligami/projects/rubrc/page/src/rust_lsp_startup.ts>)
- [rust_lsp_client.ts](</home/oligami/projects/rubrc/page/src/rust_lsp_client.ts>)
- [app_startup_lifecycle.ts](</home/oligami/projects/rubrc/page/src/app_startup_lifecycle.ts>)
- [App.tsx](</home/oligami/projects/rubrc/page/src/App.tsx>) — minimal context plumbing
- [index.tsx](</home/oligami/projects/rubrc/page/src/index.tsx>) — runtime caller gate

Tests:

- [startup_coordinator_test.ts](</home/oligami/projects/rubrc/page/src/startup_coordinator_test.ts>)
- [rust_lsp_config_test.ts](</home/oligami/projects/rubrc/page/src/rust_lsp_config_test.ts>)
- [rust_lsp_client_test.ts](</home/oligami/projects/rubrc/page/src/rust_lsp_client_test.ts>)
- [rust_lsp_client_runtime_test.ts](</home/oligami/projects/rubrc/page/src/rust_lsp_client_runtime_test.ts>)
- [app_startup_lifecycle_test.ts](</home/oligami/projects/rubrc/page/src/app_startup_lifecycle_test.ts>)
- [lsp_start_gate_test.ts](</home/oligami/projects/rubrc/page/src/lsp_start_gate_test.ts>) — source wiring assertions

No production_runtime change was needed; its existing tests were run. No scripts/ci, generated binding, Wasm, WVL, Rust analyzer source or readiness/document-sync production files were edited by this implementation. Existing unrelated dirty files were preserved. No commit, push, deployment or production/browser build was performed by this agent.

## Validation commands and exact results

All commands run from `/home/oligami/projects/rubrc`. Test output captured with `2>&1 | tee <log>` and the Deno/Bun process exit captured via `PIPESTATUS[0]` (not merely tee's exit). Commands below omit only that logging wrapper.

### Final expanded Deno suite — PASS, 279 passed / 0 failed, exit 0

[Raw final Deno log](<single-project-init-deno-final.log>)

```sh
/home/oligami/.deno/bin/deno test --no-lock --allow-read --allow-env --unstable-sloppy-imports \
  page/src/startup_coordinator_test.ts \
  page/src/rust_lsp_config_test.ts \
  page/src/rust_lsp_startup_test.ts \
  page/src/rust_lsp_client_test.ts \
  page/src/app_startup_lifecycle_test.ts \
  page/src/lsp_start_gate_test.ts \
  page/src/rust_analyzer_readiness_test.ts \
  page/src/rust_document_sync_test.ts \
  page/src/stdlib_cache_test.ts \
  page/src/worker_process/lsp_dispatch_test.ts \
  page/src/semantic_provider_gate_test.ts \
  page/src/runtime_parallelism_test.ts \
  page/src/vfs_readiness_test.ts \
  page/src/app_runtime_test.ts
```

Per-file counts: coordinator 23; config 7; startup 9; client 48; lifecycle 17; start-gate wiring 12; analyzer readiness 21; document sync 20; cache 4; dispatch 8; semantic provider gate 2; parallelism 4; VFS readiness 27; app runtime 77. Total 279. Deno type checking enabled (no `--no-check`).

### Final mocked runtime client + production runtime Bun suite — PASS, 10 passed / 0 failed, exit 0

[Raw final Bun log](<single-project-init-bun-final.log>)

```sh
/home/oligami/.bun/bin/bun test page/src/rust_lsp_client_runtime_test.ts page/src/production_runtime_test.ts
```

Client runtime: 6 tests (3 per initialization mode); production runtime: 4 tests. 30 expect calls. These exercise the actual production client using mocked Monaco/LSP/browser transport interfaces, not real RA Wasm.

### Intermediate runs retained for reproducibility

1. [First Deno log](<single-project-init-deno.log>): same first 10 Deno files as final command, without `--allow-env`. **146 passed / 2 failed, exit 1**. One stale App wiring regex did not accept the newly passed context; updated. Readiness test dependency (`vscode-jsonrpc`) required `XDG_RUNTIME_DIR` environment access; rerun with `--allow-env`.
2. [Deno rerun log](<single-project-init-deno-rerun.log>): first 10 final Deno files with `--allow-env`, before additional early-diagnostic test. **168 passed / 0 failed, exit 0**.
3. [First Bun log](<single-project-init-bun.log>): same two Bun files, before adding two activation integration tests. **8 passed / 0 failed, exit 0**.
4. Scoped `deno fmt` run on edited TS tests/modules (not App/index); final formatting of the two client test files also succeeded. `git diff --check` passed (exit 0), recorded in [provenance](<single-project-init-provenance.log>).

## Design limitations / remaining acceptance work

- These results prove TS configuration selection, plumbing, protocol sequencing and lifecycle regression behavior under mocks; they do **not** establish one completed RA graph build, cache adoption, Salsa query reuse, browser correctness/performance, or any milliseconds saved. No real RA/Wasm benchmark or browser acceptance was run by this agent.
- `sysrootsReady` means successful prerequisite installation, **not** semantic-cache acceptance. If RA rejects an installed cache, the full initialization mode must still work by cold analysis. This is architecturally supported by installed sysroots but requires real integration acceptance.
- Existing `VITE_RUBRC_STD_CACHE_COMPARE=1` can force sysroot-first order even without cache bytes; that already-existing branch also qualifies after successful install. Ordinary cache miss/install-cache failure returning false remains analyzer-first/legacy even when the new flag is 1. A thrown cache-preparation exception still fails startup, as before; it is not silently converted to fallback.
- The optional client mode argument is trusted internal wiring. The production runtime caller performs prerequisite + exact-flag checks; callers bypassing that boundary can explicitly request the mode and are responsible for installed sysroots.
- Deliberately preserve repeated writes, activation's captured snapshot, didClose/didOpen and strict latest-write synchronization. No write deduplication, reopen avoidance, timeout/poll optimization, or readiness relaxation is bundled here.
- Before promotion: paired identical-artifact cold/reload browser runs, trace actual workspace load/graph/cache generations, current-document completion/diagnostics, edit-during-load, cache absent/corrupt/rejected, remount/cancel and post-ready edits. Compare end-to-end timings because initialization may absorb work previously attributed to activation. Parent agent owns separate instrumentation/benchmark work; its results are not claimed by this implementation report.
