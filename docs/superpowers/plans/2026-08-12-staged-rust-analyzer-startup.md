# Staged rust-analyzer Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show editable Rust code immediately, initialize rust-analyzer before project/Cargo activation, load and verify `rust-src/core` plus the target sysroot through dependency-aware parallel startup, and keep an editor overlay visible until attached semantic analysis completes.

**Architecture:** A browser `StartupCoordinator` owns one generation and coordinates an early named plaintext model, VFS runtime readiness, parallel archive prefetch, lightweight rust-analyzer initialization, explicit guest sysroot installation, project activation, and semantic warmup. Rust exposes scalar-only bootstrap state/error codes for `rust-src` and `wasm32-wasip1`; the LSP session changes `linkedProjects` only after both are verified, polls the crate graph before `didOpen`, then waits for versioned diagnostics and an explicit inlay-hint response.

**Tech Stack:** SolidJS, Monaco Editor, MonacoLanguageClient/vscode-languageclient, SharedObject channels, Deno tests, Rust/WASI, WIT scalar exports, Puppeteer browser acceptance.

## Global Constraints

- Do not use JavaScript `Atomics` or `SharedArrayBuffer`.
- Do not add WIT `list` parameters or results; new WIT APIs are scalar-only.
- Do not call Rust functions from JavaScript callbacks that Rust invoked.
- Only VFS-allocated memory may be exposed to the browser.
- Preserve MonacoLanguageClient ownership of diagnostics and normal post-startup `didChange` behavior.
- The editor is editable while startup is in progress; Run and Cargo operations stay disabled until phase `ready`.
- Preserve all unrelated dirty-worktree changes. Do not commit unless the user explicitly requests it.
- Never run `bun run vfs:truebuild`; use `bun run vfs:build` when generated VFS artifacts are required.

---

## File Structure

**Create**

- `page/src/startup_coordinator.ts`: generation-scoped phase machine and dependency barriers.
- `page/src/startup_coordinator_test.ts`: deterministic startup ordering, edit preservation, failure, and disposal tests.
- `page/src/sysroot_archive_store.ts`: keyed concurrent archive prefetch, browser `rust-src/core` verification, serialized active transport cursor, and progress subscriptions.
- `page/src/sysroot_archive_store_test.ts`: prefetch concurrency, exact archive reads, progress, and missing-core tests.
- `page/src/rust_analyzer_readiness.ts`: crate-graph polling, raw versioned diagnostics latch, quiet-window invalidation, and explicit inlay-hint probe.
- `page/src/rust_analyzer_readiness_test.ts`: detached graph rejection and latest-version semantic readiness tests.
- `page/src/StartupOverlay.tsx`: pure editor-local startup progress/error rendering.
- `crates/vfs-shell/src/startup_sysroot_bootstrap.rs`: mutex-backed state and scalar error codes for startup sysroots.

**Modify**

- `page/src/App.tsx`: create and attach the named plaintext model immediately, own the coordinator, render overlay, and gate controls.
- `page/src/index.tsx`: pass the existing named model into staged rust-analyzer startup.
- `page/src/btn.tsx`: add an explicit disabled state to Run.
- `page/src/lsp_start_gate.ts`: remove after coordinator migration.
- `page/src/lsp_start_gate_test.ts`: replace old gate/static handoff assertions with coordinator/App contracts.
- `page/src/rust_lsp_client.ts`: return a staged `RustAnalyzerSession` after lightweight initialization and activate the project later.
- `page/src/rust_lsp_config.ts`: split lightweight and full settings.
- `page/src/rust_lsp_startup.ts`: reduce to bounded lightweight client startup; model creation moves to App.
- `page/src/rust_lsp_startup_test.ts`: assert snapshot-before-start and cancellation without model creation.
- `page/src/rust_lsp_client_test.ts`: assert lightweight config, activation order, crate graph before `didOpen`, and disposal.
- `page/src/lsp_bridge.ts`: expose a non-mutating raw-message observer for versioned diagnostics.
- `page/src/rust_document_sync.ts`: expose current `didOpen` completion and change notifications needed by readiness.
- `page/src/worker_process/util_cmd.ts`: register handlers before sysroots, report runtime readiness early, and expose explicit startup-sysroot installation.
- `page/src/vfs_readiness.ts`: poll both startup sysroot states and map scalar error codes.
- `page/src/vfs_readiness_test.ts`: test dual dispatch/state/error behavior.
- `page/src/ctx.ts`: add the startup-sysroot installation SharedObject ID.
- `page/src/xterm.tsx`: use the shared archive store instead of one unkeyed archive variable.
- `page/src/sysroot_archive.ts`: accept a generation abort signal for cancellable prefetch.
- `page/src/sysroot_protocol_test.ts`: retain bounded transport assertions against the store-backed path.
- `crates/vfs-shell/src/main.rs`: remove the automatic target precommand and handle explicit rust-src/target bootstrap events.
- `crates/vfs-shell/src/rust_src_bootstrap.rs`: delete after migration to generic startup bootstrap.
- `crates/vfs/src/shell.rs`: import generic startup state/error scalar functions.
- `crates/vfs/src/lib.rs`: export generic state/error access and map outer dispatch events.
- `crates/vfs/wit/vfs-host.wit`: replace rust-src-only state export with generic scalar exports.
- `crates/vfs-rustc-twice/wit/vfs-host.wit`: mirror the WIT source contract used by that test component.
- `scripts/vfs_lsp_diagnostics_test.ts`: use explicit dual bootstrap and assert no Cargo before analyzer initialization.
- `scripts/lsp_browser_diagnostics_test.mjs`: assert visible editable code, overlay sequence, startup edit preservation, crate attachment, semantic readiness, and Run enablement.
- `page/src/lsp_test_api.ts`: expose startup phase/task snapshots and semantic readiness evidence in test builds.

---

### Task 1: Generation-Scoped Startup Coordinator

**Files:**
- Create: `page/src/startup_coordinator.ts`
- Create: `page/src/startup_coordinator_test.ts`

**Interfaces:**
- Produces:

```ts
export type StartupPhase =
  | "editor-visible"
  | "vfs-starting"
  | "analyzer-initializing"
  | "sysroots-loading"
  | "project-activating"
  | "semantic-warming"
  | "ready"
  | "failed";

export type StartupTaskId =
  | "editor"
  | "analyzer"
  | "rust-src"
  | "target-sysroot"
  | "project";

export type StartupSnapshot = {
  generation: number;
  phase: StartupPhase;
  tasks: ReadonlyArray<{
    id: StartupTaskId;
    label: string;
    state: "pending" | "running" | "complete" | "failed";
    progress?: number;
  }>;
  error?: string;
};

export type StartupModel = { getValue(): string };

export type StagedAnalyzerSession = {
  activateProject(
    model: StartupModel,
    signal: AbortSignal,
    semanticWarming: () => void,
  ): Promise<void>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

export type StartupDependencies = {
  waitForVfsRuntime(signal: AbortSignal): Promise<void>;
  prefetchSysroots(
    report: (id: "rust-src" | "target-sysroot", progress?: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  initializeAnalyzer(
    model: StartupModel,
    signal: AbortSignal,
  ): Promise<StagedAnalyzerSession>;
  installSysroots(signal: AbortSignal): Promise<void>;
};

export class StartupCoordinator {
  constructor(dependencies: StartupDependencies);
  subscribe(listener: (snapshot: StartupSnapshot) => void): () => void;
  start(model: StartupModel): Promise<void>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): StartupSnapshot;
}
```

- [ ] **Step 1: Write failing ordering and parallelism tests**

Use deferred promises to assert that prefetch starts immediately, analyzer initialization starts after VFS runtime readiness but before prefetch completion, sysroot installation waits for both prefetch and analyzer initialization, and activation waits for installation.

```ts
Deno.test("coordinator overlaps prefetch with lightweight analyzer startup", async () => {
  const order: string[] = [];
  const vfs = deferred<void>();
  const archives = deferred<void>();
  const analyzer = deferred<StagedAnalyzerSession>();
  const installed = deferred<void>();
  const coordinator = new StartupCoordinator({
    waitForVfsRuntime: async () => {
      order.push("vfs:start");
      await vfs.promise;
      order.push("vfs:ready");
    },
    prefetchSysroots: async () => {
      order.push("prefetch:start");
      await archives.promise;
      order.push("prefetch:ready");
    },
    initializeAnalyzer: async () => {
      order.push("analyzer:start");
      return await analyzer.promise;
    },
    installSysroots: async () => {
      order.push("install:start");
      await installed.promise;
      order.push("install:ready");
    },
  });
  const started = coordinator.start({ getValue: () => "edited" });
  await tick();
  assertEquals(order.join(","), "vfs:start,prefetch:start");
  vfs.resolve();
  await tick();
  assert(order.includes("analyzer:start"));
  assert(!order.includes("install:start"));
  archives.resolve();
  analyzer.resolve(fakeSession(order));
  await tick();
  assert(order.includes("install:start"));
  installed.resolve();
  await started;
  assertEquals(coordinator.snapshot().phase, "ready");
});
```

- [ ] **Step 2: Run the coordinator test and confirm RED**

Run: `deno test page/src/startup_coordinator_test.ts`

Expected: FAIL because `startup_coordinator.ts` does not exist.

- [ ] **Step 3: Implement the phase machine**

Implement one internal `AbortController`, one monotonically increasing generation, immutable snapshot publication, and this dependency flow:

```ts
setPhase("vfs-starting");
const prefetch = deps.prefetchSysroots(reportProgress, signal);
void prefetch.catch(() => undefined);
await deps.waitForVfsRuntime(signal);
signal.throwIfAborted();
setPhase("analyzer-initializing");
const analyzer = await deps.initializeAnalyzer(model, signal);
signal.throwIfAborted();
await prefetch;
signal.throwIfAborted();
setPhase("sysroots-loading");
await deps.installSysroots(signal);
signal.throwIfAborted();
setPhase("project-activating");
await analyzer.activateProject(model, signal, () => setPhase("semantic-warming"));
signal.throwIfAborted();
setPhase("ready");
```

Store the analyzer session before later awaits so `dispose()` can tear it down on every failure. `flush()` must reject unless phase is `ready`, then delegate to the session.

- [ ] **Step 4: Add failure, stale-generation, and disposal tests**

Assert that the originating error is retained, late progress after disposal is ignored, `flush()` rejects before ready, and `dispose()` awaits session disposal before a replacement coordinator can start.

- [ ] **Step 5: Run Task 1 tests**

Run: `deno test page/src/startup_coordinator_test.ts`

Expected: PASS with no leaked timers or unhandled rejections.

---

### Task 2: Concurrent Sysroot Archive Store and Browser Core Verification

**Files:**
- Create: `page/src/sysroot_archive_store.ts`
- Create: `page/src/sysroot_archive_store_test.ts`
- Modify: `page/src/xterm.tsx:360-454`
- Modify: `page/src/sysroot_archive.ts:22-160`
- Modify: `page/src/sysroot_archive_test.ts`
- Modify: `page/src/sysroot_protocol_test.ts`

**Interfaces:**
- Consumes: `loadSysrootArchiveBytes`, `parseSysrootArchiveEntriesFromBytes`, `populateWebRustSrc`, and `takeExactSysrootChunk`.
- Produces:

```ts
export type SysrootArchiveProgress = {
  triple: string;
  state: "fetching" | "ready" | "reading" | "complete" | "failed";
  loaded?: number;
  total?: number;
  error?: string;
};

export class SysrootArchiveStore {
  prefetch(triples: readonly string[], signal: AbortSignal): Promise<void>;
  beginRead(triple: string): void;
  archiveLength(): number | null;
  readChunk(length: number): Uint8Array;
  subscribe(listener: (progress: SysrootArchiveProgress) => void): () => void;
  dispose(): void;
}
```

The main terminal receives the generation-owned store explicitly:

```ts
type SetupMyTerminalProps = {
  // existing props remain unchanged
  archiveStore?: SysrootArchiveStore;
};
```

Session 0 must receive the store; additional terminal sessions do not own or dispose it.

`loadSysrootArchiveBytes` gains `signal?: AbortSignal` in `ArchiveBytesOptions`. Aborting a startup generation must abort its in-flight fetch/stream read and reject with `signal.reason`.

- [ ] **Step 1: Write failing concurrent prefetch tests**

Inject a byte loader and parser into the store constructor for tests. Start `prefetch(["rust-src", "wasm32-wasip1"])`, verify both loader calls occur before either deferred fetch resolves, verify duplicate prefetch calls reuse the same in-flight promise, and assert `beginRead` throws synchronously before prefetch completion.

- [ ] **Step 2: Write the missing-core RED test**

Return a parsed rust-src archive without `core/src/lib.rs` and assert rejection contains:

```text
rust-src archive is missing core/src/lib.rs
```

- [ ] **Step 3: Run and confirm RED**

Run: `deno test page/src/sysroot_archive_store_test.ts`

Expected: FAIL because the store is not implemented.

- [ ] **Step 4: Implement keyed prefetch and active transport**

Use a generation-owned `Map<string, Promise<Uint8Array<ArrayBuffer>>>` so fetch/decompression runs once per triple. Do not export a process-global singleton. Parse rust-src once, verify a normalized exact `core/src/lib.rs` entry with non-empty data, populate `workspaceFileSystem.sysrootContents`, and retain exactly one archive byte array per triple for Rust extraction. Do not create another store-level archive copy. Keep only one active read cursor because guest extraction remains serialized.

Pass the coordinator's abort signal through `loadSysrootArchiveBytes`. Add archive-loader tests proving an external abort cancels the stream and does not invoke cache maintenance.

`beginRead` is synchronous and throws unless prefetch already completed. Rust-invoked WIT callbacks must never return a Promise. Evict rejected fetch promises immediately, and `dispose()` clears retained archives so an aborted generation cannot poison its replacement.

`readChunk` must clear the active backing buffer after the final chunk and emit exact byte progress. It must use `takeExactSysrootChunk`; do not recreate unbounded slicing logic.

- [ ] **Step 5: Replace xterm's unkeyed archive state**

Map callbacks as follows:

```ts
sysrootStartFetch -> archiveStore.beginRead(triple)
sysrootArchiveGetMeta -> archiveStore.archiveLength()
sysrootReadArchiveChunk -> archiveStore.readChunk(chunk_len)
```

Keep `sysroot_error` only as a transport of the store's specific error message. Do not call back into Rust from these JavaScript callbacks.

- [ ] **Step 6: Run archive/store/protocol tests**

Run: `deno test --allow-read page/src/sysroot_archive_store_test.ts page/src/sysroot_archive_test.ts page/src/sysroot_protocol_test.ts page/src/web_sysroot_test.ts`

Expected: PASS.

---

### Task 3: Explicit Rust-Side Startup Sysroot State Machine

**Files:**
- Create: `crates/vfs-shell/src/startup_sysroot_bootstrap.rs`
- Delete: `crates/vfs-shell/src/rust_src_bootstrap.rs`
- Modify: `crates/vfs-shell/src/main.rs:1-25,500-580,751-870`
- Modify: `crates/vfs/src/shell.rs:9-29`
- Modify: `crates/vfs/src/lib.rs:650-780`
- Modify: `crates/vfs/wit/vfs-host.wit:45-50`
- Modify: `crates/vfs-rustc-twice/wit/vfs-host.wit:45-50`

**Interfaces:**
- Produces scalar-only component exports:

```wit
export startup-sysroot-load-state: func(kind: u32) -> u32;
export startup-sysroot-error-code: func(kind: u32) -> u32;
```

- Kind `0` is `rust-src`; kind `1` is startup target `wasm32-wasip1`.
- State codes: `0 NotStarted`, `1 Loading`, `2 Ready`, `3 Failed`.
- Error codes: `0 None`, `1 Fetch`, `2 Extract`, `3 MissingSentinel`, `4 InvalidKind`.
- Outer VFS dispatch event `8` starts rust-src; event `9` starts the target sysroot.

The state remains in the `vfs-shell` Wasm target. The outer `vfs` crate accesses it through the existing scalar `extern "C"` target-import pattern in `crates/vfs/src/shell.rs`; this is not a Rust crate dependency from `vfs` to the `vfs-shell` binary.

- [ ] **Step 1: Write failing mutex state tests**

The test must prove each kind transitions independently, `begin` is one-shot while loading/ready, and failure retains its scalar error code. Use `Mutex`; do not introduce an atomic state.

```rust
#[test]
fn startup_sysroots_have_independent_state_and_error_codes() {
    let bootstraps = StartupSysrootBootstraps::new();
    assert!(bootstraps.begin(StartupSysroot::RustSrc));
    bootstraps.finish(StartupSysroot::RustSrc, Err(StartupSysrootError::MissingSentinel));
    assert_eq!(bootstraps.state(StartupSysroot::RustSrc), LoadState::Failed);
    assert_eq!(bootstraps.state(StartupSysroot::Target), LoadState::NotStarted);
}
```

- [ ] **Step 2: Run the focused Rust test and confirm RED**

Run: `cargo test -p vfs-shell startup_sysroot_bootstrap`

Expected: compilation failure because the module does not exist. If the pre-existing stale tests in `main.rs` still prevent all bin tests from compiling, first move only the stale tests behind their valid current session APIs; do not alter production behavior to satisfy old tests.

The two obsolete tests `test_cd_parallel_execution` and `test_shell_full_interaction_simulation` still reference removed globals (`REGISTRY`, `CANCELLATION_TOKEN.reset`, and `vfs_shell_input_char`). Delete those two tests rather than recreating removed production APIs. Keep `test_normalize_path_logical`.

- [ ] **Step 3: Implement the mutex-backed state module**

Use `std::sync::Mutex` around a two-element state array. Export typed conversion methods and scalar wrappers; invalid kinds return `InvalidKind` without indexing.

- [ ] **Step 4: Remove the automatic target precommand**

Delete only this entry from session 0 `pre_lines`:

```rust
"load_sysroot wasm32-wasip1",
```

Keep harmless demonstration commands unchanged.

- [ ] **Step 5: Handle explicit bootstrap events**

Add `SessionEvent::BootstrapTarget`. Both bootstrap handlers execute the existing `load_sysroot` command under the existing transaction lock. Completion requires both command success and a sentinel:

```rust
const RUST_SRC_CORE: &str =
    "/sysroot/lib/rustlib/src/rust/library/core/src/lib.rs";
const STARTUP_TARGET_LIB: &str =
    "/sysroot/lib/rustlib/wasm32-wasip1/lib";

fn target_core_exists() -> bool {
    std::fs::read_dir(STARTUP_TARGET_LIB).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("libcore-") && name.ends_with(".rlib")
        })
    })
}

fn rust_src_core_exists() -> bool {
    std::fs::metadata(RUST_SRC_CORE)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}
```

Invoke `rust_src_core_exists()` only after the complete rust-src command returns and `target_core_exists()` only after the complete target command returns. Classify host unavailable/fetch as `Fetch`, command/extraction failure as `Extract`, and a successful command lacking its sentinel as `MissingSentinel`. Emit the detailed terminal message once; UI consumes the scalar code and known path.

- [ ] **Step 6: Wire scalar imports/exports and WIT**

Map outer dispatch event `8 -> shell BootstrapRustSrc` and `9 -> shell BootstrapTarget`. Replace the rust-src-only exported state with generic state/error exports. Apply identical WIT declarations to both source WIT files, then regenerate bindings only through `bun run vfs:build` in Task 9.

- [ ] **Step 7: Run Rust checks**

Run: `cargo test -p vfs-shell startup_sysroot_bootstrap`

Run: `cargo check -p vfs-shell --target wasm32-wasip1`

Expected: PASS without new warnings from the startup state module.

---

### Task 4: Early VFS Runtime Readiness and Explicit Dual Installation

**Files:**
- Modify: `page/src/ctx.ts`
- Modify: `page/src/vfs_readiness.ts`
- Modify: `page/src/vfs_readiness_test.ts`
- Modify: `page/src/worker_process/util_cmd.ts:464-585`
- Modify: `page/src/worker_process/worker.ts:16-80`

**Interfaces:**
- Adds `install_startup_sysroots_id: string` to `Ctx` and `gen_ctx()`.
- Produces:

```ts
export type StartupSysrootKind = 0 | 1;

export type StartupSysrootRoot = {
  dispatch(sessionId: number, eventType: number, arg1: number, arg2: number): void;
  startupSysrootLoadState(kind: number): number;
  startupSysrootErrorCode(kind: number): number;
};

export async function waitForStartupSysroots(
  root: StartupSysrootRoot,
  timing?: StartupSysrootTiming,
): Promise<VfsReadyResult>;
```

- [ ] **Step 1: Replace rust-src-only tests with dual-state RED tests**

Assert events `8` and `9` are dispatched once, polling does not resolve when only one state is ready, and each scalar error code maps to a message containing the triple and failed stage/path.

- [ ] **Step 2: Run and confirm RED**

Run: `deno test page/src/vfs_readiness_test.ts`

Expected: FAIL because generic root methods are missing.

- [ ] **Step 3: Implement dual polling and specific errors**

Preserve the 300-second overall bound. Error examples must be exact and actionable:

```text
rust-src fetch failed before core installation
rust-src extraction failed
rust-src extraction completed without /sysroot/lib/rustlib/src/rust/library/core/src/lib.rs
wasm32-wasip1 extraction completed without a libcore-*.rlib
```

- [ ] **Step 4: Move util worker handlers before sysroot installation**

After `animal.start`, session creation, and initial resize:

1. Register create/input/interrupt/resize/close SharedObjects.
2. Register `install_startup_sysroots_id` as an async SharedObject that calls `waitForStartupSysroots` and returns its result.
3. Notify `vfs_ready_id` with `{ ok: true }` immediately after these runtime handlers exist.
4. Remove the eager `waitForRustSrcBootstrap` call from util startup.

This runtime-ready notification is the barrier that permits lightweight LSP initialization and workspace writes.

- [ ] **Step 5: Remove the obsolete worker-side fire-and-forget startup path**

Keep `load_additional_sysroot_id` for later user-selected targets, but do not use it for startup. Ensure its callback returns/awaits its command promise rather than discarding completion errors.

- [ ] **Step 6: Run readiness and worker contract tests**

Run: `deno test page/src/vfs_readiness_test.ts page/src/worker_process/lsp_dispatch_test.ts`

Expected: PASS.

---

### Task 5: Lightweight and Full rust-analyzer Configuration

**Files:**
- Modify: `page/src/rust_lsp_config.ts`
- Modify: `page/src/rust_lsp_config_test.ts`

**Interfaces:**
- Produces:

```ts
export function createRustAnalyzerLightweightOptions(): {
  linkedProjects: [];
  cargo: { buildScripts: { enable: false }; autoreload: false };
  procMacro: { enable: false };
  checkOnSave: { enable: false };
  cachePriming: { enable: false };
};

export function createRustAnalyzerProjectSettings(): {
  linkedProjects: Array<{
    sysroot: "/sysroot";
    sysroot_src: "/sysroot/lib/rustlib/src/rust/library";
    sysroot_project: { crates: [] };
    crates: Array<{
      display_name: "rubrc-main";
      root_module: "/src/main.rs";
      edition: "2021";
      deps: [];
    }>;
  }>;
  cargo: {
    sysroot: "/sysroot";
    buildScripts: { enable: false };
    autoreload: true;
  };
  procMacro: { enable: false };
  checkOnSave: { enable: false };
  cachePriming: { enable: false };
};
```

- [ ] **Step 1: Write failing exact-shape tests**

Assert lightweight options have an explicit empty `linkedProjects` list and no sysroot paths. Assert full settings preserve the validated current project JSON and restore Cargo autoreload so later `Cargo.toml` dependency edits continue to refresh the workspace.

- [ ] **Step 2: Run RED**

Run: `deno test page/src/rust_lsp_config_test.ts`

Expected: FAIL because the split functions do not exist.

- [ ] **Step 3: Split the configuration functions**

Return fresh objects on every call. Do not retain the old ambiguous `createRustAnalyzerInitializationOptions` alias; update all consumers in Task 7.

- [ ] **Step 4: Run GREEN**

Run: `deno test page/src/rust_lsp_config_test.ts`

Expected: PASS.

---

### Task 6: Observable Crate Attachment and Versioned Semantic Readiness

**Files:**
- Create: `page/src/rust_analyzer_readiness.ts`
- Create: `page/src/rust_analyzer_readiness_test.ts`
- Modify: `page/src/lsp_bridge.ts`
- Modify: `page/src/lsp_protocol_test.ts`

**Interfaces:**
- `createLspConnection(ctx, observeMessage?)`, where observer receives decoded messages before the language client callback but never consumes or mutates them.
- Produces:

```ts
export type AnalyzerRequestClient = {
  sendRequest<R>(method: string, params: unknown): Promise<R>;
};

export type MonacoRangeLike = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export class RustAnalyzerReadiness {
  constructor(
    client: AnalyzerRequestClient,
    uri: string,
    timing?: { now?: () => number; sleep?: () => Promise<void>; timeoutMs?: number },
  );
  observeMessage(message: unknown): void;
  noteDocumentChanged(version: number): void;
  waitForCrateGraph(signal: AbortSignal): Promise<void>;
  waitForSemanticReadiness(
    model: { getVersionId(): number; getFullModelRange(): MonacoRangeLike },
    signal: AbortSignal,
  ): Promise<void>;
  dispose(): void;
}
```

- [ ] **Step 1: Write crate-graph polling RED tests**

Return real-format DOT fixtures in order: empty graph, graph containing only the exact `rubrc-main` node label, graph containing only the exact `core` node label, then graph containing both. Assert polling resolves only on the fourth response and always calls `rust-analyzer/viewCrateGraph` with `{ full: true }`. Add near-match fixtures (`rubrc-main-old`, `core-extra`, edge attributes) that must not pass.

- [ ] **Step 2: Write versioned semantic RED tests**

Assert diagnostics received before crate-graph completion cannot satisfy readiness. After graph completion, require `textDocument/publishDiagnostics` with matching URI and `version`, then explicitly issue `textDocument/inlayHint` with the current full range converted from Monaco's 1-based coordinates to LSP's 0-based coordinates. A document change clears the diagnostics latch, restarts the quiet-window timeout, and causes a new inlay-hint request for the new version after that quiet window.

- [ ] **Step 3: Run RED**

Run: `deno test page/src/rust_analyzer_readiness_test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 4: Add the raw-message observer**

In `MyMessageReader.listen`, call `observeMessage(message)` before `callback(message)`. Observer exceptions must be reported through its owner but must not close or consume the LSP stream. Keep frame decoding behavior unchanged.

- [ ] **Step 5: Implement bounded polling and semantic readiness**

Poll every 250 ms by default. Use a 300-second phase timeout. Parse DOT node declarations and require exact node labels `rubrc-main` and `core`; do not match arbitrary substrings or edge attributes. Register diagnostics observation before the model becomes Rust. Race every request and sleep against abort plus the remaining deadline, then re-check deadline/abort after settlement. Directly send and re-send the inlay-hint request for the current version after each quiet window; do not wait for Monaco viewport behavior. Convert the model range with `line - 1` and `column - 1` for both endpoints. Catch JSON-RPC error code `-32801` (`ContentModified`) and treat it as an invalidated probe that must be retried after the next quiet window; other request errors fail the phase.

- [ ] **Step 6: Advertise diagnostic versions**

In the language client subclass's `fillInitializeParams`, set:

```ts
params.capabilities.textDocument ??= {};
params.capabilities.textDocument.publishDiagnostics = {
  relatedInformation: true,
  versionSupport: true,
};
```

Retain the existing deletion of pull-diagnostic capabilities.

- [ ] **Step 7: Run readiness and protocol tests**

Run: `deno test page/src/rust_analyzer_readiness_test.ts page/src/lsp_protocol_test.ts`

Expected: PASS.

---

### Task 7: Staged RustAnalyzerSession

**Files:**
- Modify: `page/src/rust_lsp_client.ts`
- Modify: `page/src/rust_lsp_startup.ts`
- Modify: `page/src/rust_lsp_startup_test.ts`
- Modify: `page/src/rust_lsp_client_test.ts`
- Modify: `page/src/rust_document_sync.ts`
- Modify: `page/src/rust_lsp_client_dispose.ts`

**Interfaces:**
- Consumes: split config from Task 5 and `RustAnalyzerReadiness` from Task 6.
- Produces the `StagedAnalyzerSession` contract from Task 1.

- [ ] **Step 1: Rewrite startup tests for lightweight initialization**

The expected order is:

```text
snapshot current model -> VFS write complete -> client.start resolved
```

There is no model creation in `runRustLspStartup`. Cancellation still disposes transports and settles boundedly.

- [ ] **Step 2: Write activation RED tests**

Use fake Monaco/client/sync/readiness objects and assert this exact order:

```text
latest snapshot
VFS write complete
didChangeConfiguration(full settings)
crate graph ready
diagnostics listener armed
setModelLanguage(rust)
didOpen complete
latest diagnostics
explicit inlayHint complete
```

Assert the browser unit sends neither full configuration nor `reloadWorkspace` during lightweight startup. The real `hostRunCargo` boundary exists only inside the embedded VFS; Task 9's integration trace must assert zero host Cargo/rustc calls before `didChangeConfiguration`.

- [ ] **Step 3: Run RED**

Run: `deno test --allow-read page/src/rust_lsp_startup_test.ts page/src/rust_lsp_client_test.ts`

Expected: FAIL against the current one-stage client.

- [ ] **Step 4: Start the client with lightweight options**

Change the function signature to:

```ts
export async function startRustLspClient(
  ctx: Ctx,
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  signal: AbortSignal,
): Promise<StagedAnalyzerSession>;
```

It receives the existing named model rather than creating one. It writes `model.getValue()` to `/src/main.rs` and awaits Rust VFS completion before starting the client with `createRustAnalyzerLightweightOptions()`. It returns a session after `client.start()` resolves. The Task 4 runtime-ready promise guarantees that the initial browser filesystem import, including Cargo and rust-project files, completed before this write.

Keep `documentSelector` restricted to `{ scheme: "file", language: "rust" }`; explicit `client.start()` performs initialization while the plaintext model remains unsynchronized.

- [ ] **Step 5: Implement project activation**

`activateProject` must:

1. Write the latest `model.getValue()` and await Rust VFS completion.
2. Send `workspace/didChangeConfiguration` with `{ settings: createRustAnalyzerProjectSettings() }`.
3. Await `readiness.waitForCrateGraph()`.
4. Arm version-scoped diagnostics readiness.
5. Create the `RustDocumentSync.waitForDidOpen(uri)` promise before changing the language.
6. Call `monaco.editor.setModelLanguage(model, "rust")`.
7. Await the previously created `didOpen` promise. The existing `RustDocumentSync` middleware must snapshot the latest document text and await its VFS write before forwarding `didOpen`, closing edits made between Step 1 and language activation.
8. Invoke the `semanticWarming()` callback so the coordinator publishes phase `semantic-warming`.
9. Await `readiness.waitForSemanticReadiness(model)`.

Do not send `rust-analyzer/reloadWorkspace`.

- [ ] **Step 6: Preserve edit synchronization**

Expose a document-change callback from `RustDocumentSync` or the Monaco model subscription so each version calls `readiness.noteDocumentChanged(version)`. After `didOpen`, keep immediate LSP `didChange` and the existing 300 ms VFS debounce unchanged.

- [ ] **Step 7: Complete generation teardown**

Extend `RustLspResourceOwner` to own readiness observers, Monaco model listeners, and any generation worker termination callback. Disposal order is listener/readiness -> sync -> language client -> transports/SharedObject refs -> worker termination. Preserve aggregate cleanup errors.

- [ ] **Step 8: Run staged-client tests**

Run: `deno test --allow-read page/src/rust_lsp_startup_test.ts page/src/rust_lsp_client_test.ts page/src/rust_document_sync_test.ts`

Expected: PASS.

---

### Task 8: Immediate Editable Model, Startup Overlay, and Run Gate

**Files:**
- Create: `page/src/StartupOverlay.tsx`
- Modify: `page/src/App.tsx`
- Modify: `page/src/index.tsx`
- Modify: `page/src/btn.tsx`
- Delete: `page/src/lsp_start_gate.ts`
- Modify: `page/src/lsp_start_gate_test.ts`
- Modify: `page/src/lsp_test_api.ts`

**Interfaces:**
- Consumes: `StartupCoordinator`, a generation-owned `SysrootArchiveStore`, `install_startup_sysroots_id`, and staged `startLspClient`.
- `App` changes its `startLspClient` prop to `(monaco, model, signal) => Promise<StagedAnalyzerSession>`; `index.tsx` forwards those arguments to `startRustLspClient(ctx, monaco, model, signal)`.
- `StartupOverlay` props:

```ts
type StartupOverlayProps = { state: StartupSnapshot };
```

- `RunButton` gains `disabled: boolean`.

- [ ] **Step 1: Write failing App source/model tests**

Replace temporary-model assertions with these contracts:

- `file:///src/main.rs` is created in `handleMount` with `default_value` and language `plaintext` if absent.
- The named model is attached immediately.
- `readOnly` is false from first attachment.
- No later code recreates or disposes the named model during language activation.
- Run receives `disabled={startup.phase !== "ready"}`.

- [ ] **Step 2: Write failing overlay rendering tests**

Render or source-check task labels and states. Verify failures preserve the code container and show the exact originating message. Verify a task without byte totals renders an indeterminate marker rather than `0%`.

- [ ] **Step 3: Run RED**

Run: `deno test --allow-read page/src/lsp_start_gate_test.ts`

Expected: FAIL because App still uses a blank temporary model and old gate.

- [ ] **Step 4: Create and attach the named model immediately**

In `handleMount`:

```ts
const uri = mountedMonaco.Uri.parse("file:///src/main.rs");
const model =
  mountedMonaco.editor.getModel(uri) ??
  mountedMonaco.editor.createModel(default_value, "plaintext", uri);
mountedEditor.setModel(model);
mountedEditor.updateOptions({ readOnly: false });
```

Do not retain or dispose an unnamed temporary model after this point. Expose the named model through the test API immediately.

- [ ] **Step 5: Wire coordinator dependencies**

Construct deferred VFS runtime readiness from `vfs_ready_id`. Start archive prefetch and coordinator after model mount. `installSysroots` calls the `install_startup_sysroots_id` proxy and throws its specific failed result. `initializeAnalyzer` calls the staged `startLspClient`.

Create one `SysrootArchiveStore` per App/coordinator generation and pass that exact instance as a prop to the main `SetupMyTerminal`/`get_ref` path. Dispose it with the coordinator. Do not access a module-global store.

Subscribe a Solid signal to coordinator snapshots and unsubscribe on cleanup. Cleanup awaits coordinator disposal and closes all SharedObject channels.

- [ ] **Step 6: Render the editor-local overlay**

Wrap Monaco in a `relative` 30vh container and render `StartupOverlay` absolutely over it until ready. Use existing neutral/green terminal visual language, retain visible code, set overlay pointer events to none so editing remains possible, and yield one animation frame after phase changes before starting known long synchronous work.

- [ ] **Step 7: Gate Run and startup target changes**

Add native `disabled`, disabled styling, and click suppression to `RunButton`. Keep target selector changes queued or disabled while coordinator owns startup target installation; they may call `load_additional_sysroot` only after ready.

- [ ] **Step 8: Remove the old LspStartGate**

Delete the gate after App and tests no longer import it. Coordinator `flush()` replaces `lspGate.flush()`.

- [ ] **Step 9: Run UI contracts**

Run: `deno test --allow-read page/src/lsp_start_gate_test.ts page/src/startup_coordinator_test.ts page/src/run_after_flush_test.ts`

Run: `bun run --cwd page build`

Expected: tests and build PASS.

---

### Task 9: Generated Bindings and Full Integration Verification

**Files:**
- Modify: `scripts/vfs_lsp_diagnostics_test.ts`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs`
- Modify: `page/src/lsp_test_api.ts`
- Generated by build: `page/src/worker_process/vfs_bindings/vfs.js`
- Generated by build: `page/src/worker_process/vfs_bindings/interfaces/vfs-host-bridge.d.ts`

**Interfaces:**
- Test API exposes:

```ts
startup: {
  phase: StartupPhase;
  history: StartupPhase[];
  overlayVisible: boolean;
  crateGraphReady: boolean;
  diagnosticsVersion?: number;
  inlayHintVersion?: number;
  cargoCallsBeforeProjectActivation: number;
}
```

- [ ] **Step 1: Strengthen the Deno VFS integration test**

Make the test perform lightweight LSP initialization first, explicitly dispatch both startup sysroot events, then activate the project. Continue padding the valid archive to exactly `74_096_640` bytes and assert maximum archive read request is at most `512 * 1024`.

Record host Cargo/rustc calls and assert zero occur before full project configuration. Assert both Rust sentinels exist before activation.

- [ ] **Step 2: Strengthen browser acceptance before implementation verification**

Immediately after Monaco mounts, assert:

- URI is `file:///src/main.rs`.
- Code is non-empty and equals the default source before test editing.
- Editor is editable.
- Overlay is visible.
- Run is disabled.

Type a unique edit while startup is still in progress. At final readiness assert rust-analyzer diagnostics and inlay response correspond to that model version, overlay is absent, Run is enabled, and the Rust VFS contains the edited text.

- [ ] **Step 3: Run the focused TypeScript suites**

Run:

```bash
deno test --allow-read \
  page/src/startup_coordinator_test.ts \
  page/src/sysroot_archive_store_test.ts \
  page/src/vfs_readiness_test.ts \
  page/src/rust_lsp_config_test.ts \
  page/src/rust_analyzer_readiness_test.ts \
  page/src/rust_lsp_startup_test.ts \
  page/src/rust_lsp_client_test.ts \
  page/src/rust_document_sync_test.ts \
  page/src/lsp_start_gate_test.ts \
  page/src/sysroot_protocol_test.ts \
  page/src/web_sysroot_test.ts
```

Expected: all tests PASS.

- [ ] **Step 4: Build VFS and regenerate bindings**

Run: `bun run vfs:build`

Expected: build completes and generated JS/declarations expose `startupSysrootLoadState(kind)` and `startupSysrootErrorCode(kind)`.

- [ ] **Step 5: Run real VFS integration**

Run: `deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts`

Expected output includes:

```text
served rust-src archive: 74096640 bytes
maximum sysroot chunk request: 8192
```

It must also report zero Cargo calls before project activation and successful `core` verification.

- [ ] **Step 6: Build browser assets through the supported path**

Run:

```bash
bun run --cwd page build
bun run vfs:prepare:prod
bun run rust-src:prepare-asset
```

Assert `page/dist/rust-src.tar.vfsbr` exists before launching acceptance. A missing asset must fail with the specific asset message, never a rustup suggestion.

- [ ] **Step 7: Run browser acceptance**

Run: `bun scripts/lsp_browser_diagnostics_test.mjs`

Expected: PASS with the approved phase history and startup edit preserved.

- [ ] **Step 8: Run final static checks**

Run: `cargo check -p vfs-shell --target wasm32-wasip1`

Run: `git diff --check`

Run scoped format checks only on files changed by this implementation; do not bulk-format unrelated dirty files.

Expected: no errors, no whitespace failures, and no new warnings from changed code.

---

## Final Review Checklist

- The named model is visible and editable before any backend readiness.
- VFS runtime readiness no longer waits for rust-src.
- Archive fetch/decompression overlaps VFS and lightweight analyzer work.
- rust-analyzer starts with no linked project and produces no early host Cargo/rustc calls.
- Both complete extraction tasks and both sentinels are verified before full configuration.
- Full workspace import and latest model snapshot reach Rust VFS before project configuration.
- Crate graph contains exact `rubrc-main` and `core` nodes before the model changes to Rust.
- Only post-attachment, version-matching diagnostics and explicit inlay hints satisfy readiness.
- Continuous editing resets semantic readiness without producing a false timeout.
- Run and Cargo remain disabled until ready.
- Disposal terminates all generation-owned resources before replacement.
- The exact 74,096,640-byte regression archive remains bounded and passes integration.
