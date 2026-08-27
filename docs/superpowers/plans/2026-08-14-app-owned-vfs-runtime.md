# App-Owned VFS Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every mounted application generation one abortable, directly owned VFS runtime whose workers, farm, callbacks, channels, startup coordinator, Run/target operations, and archive store are either safely destroyed in order or quarantined until page reload.

**Architecture:** A page-level `RuntimeSupervisor` admits one `AppRuntime` at a time while the page-level `workspaceFileSystem` remains persistent user data. Each runtime creates a fresh `Ctx`, archive store, terminal and command services, host callback owners, `WASIFarm`, direct utility worker, and independent lifecycle worker; the lifecycle worker alone holds the cloneable Animal destroyer and can tear down a blocked utility worker. `App` keeps the approved staged startup flow, immediately attaches the named plaintext model, adopts its `StartupCoordinator` into the runtime, and consumes runtime status for Run/target admission and reload-required quarantine.

**Tech Stack:** TypeScript, SolidJS, Monaco Editor, xterm.js, SharedObject, Web Workers, `@oligami/browser_wasi_shim-threads@0.4.1`, Deno tests, Bun package patching/builds, Rust/WASI, scalar-only WIT, Puppeteer browser acceptance.

## Global Constraints

- The worktree is already dirty. Preserve every unrelated staged, unstaged, and untracked change; inspect current contents before each edit and merge with them.
- Do not run `git add`, `git commit`, `git restore`, `git checkout`, `git reset`, or otherwise stage, commit, or discard any change in this plan.
- Run `bun run vfs:build` when generated VFS bindings are required. Never run `bun run vfs:truebuild`.
- Never edit generated VFS bindings manually. `page/src/worker_process/vfs_bindings/vfs.js`, `page/src/worker_process/vfs_bindings/vfs.d.ts`, and `page/src/worker_process/vfs_bindings/interfaces/vfs-host-bridge.d.ts` may change only as output of `bun run vfs:build`.
- Pin `@oligami/browser_wasi_shim-threads` to exact version `0.4.1` in all four manifests. Apply the exact Bun patch to both the root installation and the independently installed `page/src/worker_process/vfs_bindings` installation.
- Build the shim patch from exact upstream commit `af935bb5e8f480a1e370aa09899dd323d9c3350d` under `/tmp/opencode`; the published package omits required build configuration. Do not assume `npm` is installed and do not invoke a package script that runs `npm`.
- This application introduces no application-owned `Atomics` or `SharedArrayBuffer` coordination protocol. The dependency's internal thread protocol is the only permitted use.
- New WIT parameters and results are scalar-only. Do not add WIT `list` parameters or results.
- Do not call a Rust export from a JavaScript callback that Rust invoked. A Rust-called callback returns its result without Rust reentry.
- SharedObject callbacks invoked synchronously by Wasm remain synchronous and return cloneable scalar/object data, never a `Promise`.
- The synchronous cloneable rule applies to `SharedObject` callback endpoints. `WASIFarm`'s `unknown_fn` contract is `(arg: unknown) => Promise<unknown> | unknown`: the sysroot adapter and terminal/download routing remain synchronous, while HTTP and child-process responses may return tracked Promises.
- Only VFS-allocated memory may be exposed to browser callbacks.
- Preserve MonacoLanguageClient ownership of diagnostics and normal post-startup `didChange` behavior.
- Create or reuse exactly `file:///src/main.rs` as a `plaintext` Monaco model, attach it immediately, and keep it editable throughout startup and after startup failure.
- Preserve this exact startup order: create runtime; attach the named editable plaintext model; create the farm; bind its synchronous archive callback to the runtime store; start the utility worker directly; create and transfer the Animal destroyer; receive lifecycle-worker adoption acknowledgement; instantiate `vfs_root` and report VFS ready; prefetch startup archives; initialize lightweight rust-analyzer; install startup sysroots; activate the project; observe exact `rubrc-main` and `core` crate-graph nodes; await versioned diagnostics and an explicit inlay-hint response; then admit Run and additional targets.
- The `74_096_640`-byte rust-src regression archive must be served without a whole-archive copy. Host archive reads are bounded to `512 * 1024` bytes and the integration test must report a maximum guest sysroot chunk request of `8192` bytes.
- Run and Cargo operations remain disabled until staged startup phase `ready`. Additional targets execute serially. Run/target overlap and duplicate active Run calls reject immediately with a busy error.
- Worker `error`, `messageerror`, startup rejection, transport loss after acceptance, and farm failure are fatal runtime errors. An ordinary guest command failure or an additional-target guest error does not poison an otherwise healthy ready runtime.
- If an asynchronous host callback does not settle by its deadline or Animal destruction is not acknowledged by its deadline, quarantine the farm, archive store, callbacks, and reachable channels. Quarantine blocks every later runtime until page reload; never claim safe disposal.
- `workspaceFileSystem` is page-owned persistent user data. Runtime teardown must not close, replace, clear, or recreate its root directory or preopen.
- The initiating fatal/abort error remains primary. Record cleanup failures in teardown order in an `AggregateError` without replacing the primary cause.

---

## File Map

**Create:**

- `scripts/browser_wasi_shim_patch_test.ts` - verifies exact pins, both patch registrations, and patched root/nested artifacts.
- `page/src/runtime_host_callbacks.ts` - composes sysroot, HTTP, child-process, terminal, LSP, and download callbacks into one tracked generation owner.
- `page/src/runtime_host_callbacks_test.ts` - callback tracking, abort, settlement, and no-post-disposal dispatch tests.
- `page/src/runtime_terminal_service.ts` - generation/session terminal routing, bounded replay, capture, and 80x24 fallback.
- `page/src/runtime_terminal_service_test.ts` - Unicode trimming, remount replay, generation isolation, and fallback tests.
- `page/src/runtime_command_service.ts` - generation-owned parser waiter and command proxies without module globals.
- `page/src/runtime_command_service_test.ts` - synchronous waiter, proxy rejection, stale completion, and disposal tests.
- `page/src/runtime_worker_protocol.ts` - cloneable utility/lifecycle worker envelopes and guards.
- `page/src/worker_process/lifecycle_worker.ts` - reconstructs and invokes the Animal `DestroyerHandle` away from blocked guest execution.
- `page/src/runtime_worker_protocol_test.ts` - destroyer-before-guest and token guard tests.
- `page/src/app_runtime.ts` - `AppRuntime`, `RuntimeSupervisor`, ordered teardown, status, admission, and quarantine.
- `page/src/app_runtime_test.ts` - ownership, operation admission, fatal transition, ordered teardown, and quarantine tests.
- `page/src/runtime_entrypoint.ts` - catches runtime creation failures and chooses App or visible reload-required/fatal UI.
- `page/src/runtime_entrypoint_test.ts` - proves quarantine creation rejection renders instead of escaping as an unhandled rejection.
- `page/src/RuntimeCreationFailure.tsx` - accessible reload-required/fatal creation screen with reload action.

**Modify:**

- `package.json`, `page/package.json`, `lib/package.json`, `page/src/worker_process/vfs_bindings/package.json` - exact shim pins; root and nested manifests also register their local patches.
- `bun.lockb`, `page/src/worker_process/vfs_bindings/bun.lock` - lock exact patched `0.4.1` installations.
- `lib/src/http_bridge.ts`, `scripts/vfs_http_bridge_test.ts` - abortable/settleable HTTP bridge owner.
- `lib/src/child_process_bridge.ts`, `scripts/vfs_child_process_bridge_test.ts` - terminable/settleable child-process bridge owner.
- `page/src/terminal_channel_lifecycle.ts`, `page/src/terminal_channel_lifecycle_test.ts` - export the existing UTF-8 bounded-buffer primitive and keep channel disposal idempotent.
- `page/src/cmd_parser.ts`, `page/src/compile_and_run.ts` - compatibility exports become thin instance-free types/helpers; all mutable state moves to `RuntimeCommandService`.
- `page/src/worker_process/util_cmd.ts` - direct one-shot initialization, Animal destroyer handshake, one `vfs_root`, token guards, and deterministic channel disposal.
- `page/src/xterm.tsx`, `page/src/solid_xterm_lifecycle.ts`, `page/src/solid_xterm_lifecycle_test.ts` - terminal views attach to the runtime service; no farm or generation-global terminal map remains.
- `page/src/app_startup_lifecycle.ts`, `page/src/app_startup_lifecycle_test.ts` - serialize targets through runtime admission and classify accepted transport loss as fatal.
- `page/src/btn.tsx`, `page/src/btn_test.ts`, `page/src/run_after_flush_test.ts` - invoke `runtime.run()` and reflect runtime busy/disposal status.
- `page/src/TargetSelector.tsx`, `page/src/target_selector_state.ts`, `page/src/target_selector_test.ts` - invoke `runtime.loadTarget()` and show queued/active state.
- `page/src/App.tsx`, `page/src/index.tsx`, `page/src/app_startup_lifecycle.ts`, `page/src/lsp_start_gate_test.ts` - create/adopt one runtime generation while preserving the approved named-model startup.
- `page/src/lsp_bridge.ts`, `page/src/lsp_bridge_test.ts`, `page/src/rust_lsp_client.ts`, `page/src/rust_lsp_client_dispose.ts`, `page/src/rust_lsp_client_test.ts` - generation signal/token guards and bounded proxy settlement.
- `page/src/lsp_test_api.ts`, `page/src/lsp_test_api_state.ts`, `page/src/lsp_test_api_state_test.ts` - expose runtime generation/status/resources and token-owned reset.
- `scripts/vfs_lsp_diagnostics_test.ts`, `scripts/lsp_browser_diagnostics_test.mjs` - archive bounds, exact crate graph, startup ordering, disposal/remount, and quarantine acceptance.
- `crates/vfs-shell/src/startup_sysroot_bootstrap.rs`, `crates/vfs-shell/src/sysroot_extraction.rs`, `crates/vfs-shell/src/main.rs`, `crates/vfs/src/shell.rs`, `crates/vfs/src/lib.rs`, `crates/vfs/wit/vfs-host.wit`, `crates/vfs-rustc-twice/wit/vfs-host.wit` - retain the staged scalar startup protocol and bounded extraction while integrating regenerated browser bindings.

**Delete:**

- `page/src/worker_process/worker.ts` - remove the forwarding-only outer worker.

**Generated only by `bun run vfs:build`:**

- `page/src/worker_process/vfs_bindings/vfs.js`
- `page/src/worker_process/vfs_bindings/vfs.d.ts`
- `page/src/worker_process/vfs_bindings/interfaces/vfs-host-bridge.d.ts`

**Generated by `bun patch --commit`:**

- `patches/@oligami%2Fbrowser_wasi_shim-threads@0.4.1.patch`
- `page/src/worker_process/vfs_bindings/patches/@oligami%2Fbrowser_wasi_shim-threads@0.4.1.patch`

## Canonical TypeScript Interfaces

Define these once in the indicated files and use these exact names and signatures in every task:

```ts
// page/src/runtime_terminal_service.ts
export const TERMINAL_BUFFER_LIMIT_BYTES = 64 * 1024;
export type RuntimeGeneration = string;
export type TerminalSize = { cols: number; rows: number };
export interface TerminalView {
  write(data: string): void;
  size(): TerminalSize;
}
export interface Disposable { dispose(): void }

export class RuntimeTerminalService {
  constructor(readonly generation: RuntimeGeneration);
  attach(sessionId: number, view: TerminalView): Disposable;
  write(sessionId: number, data: Uint8Array, error?: boolean): void;
  size(sessionId?: number): TerminalSize;
  out(sessionId?: number): string;
  error(sessionId?: number): string;
  resetOut(sessionId?: number): void;
  resetError(sessionId?: number): void;
  dispose(): void;
}

// lib/src/http_bridge.ts
export interface HttpBridgeOwner {
  handle(message: HttpBridgeMessage): Promise<unknown>;
  abort(reason?: unknown): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}
export function createHttpBridgeOwner(
  fetchImpl?: typeof fetch,
  options?: HttpBridgeOptions & { signal?: AbortSignal },
): HttpBridgeOwner;

// lib/src/child_process_bridge.ts
export interface ChildProcessBridgeOwner {
  handle(message: ChildProcessMessage): Promise<unknown>;
  abort(reason?: unknown): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}
export function createChildProcessBridgeOwner(
  options: ChildProcessBridgeOptions & { signal?: AbortSignal },
): ChildProcessBridgeOwner;

// page/src/runtime_host_callbacks.ts
export interface RuntimeHostCallbackOwner {
  handle(message: unknown): Promise<unknown> | unknown;
  abort(reason?: unknown): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

// page/src/runtime_command_service.ts
export type InputStringEndpoint = (args: {
  sessionId: number;
  data: string;
}) => Promise<void>;
export class RuntimeParserService {
  constructor(ctx: Ctx, signal: AbortSignal);
  readonly ready: Promise<void>;
  dispose(): void;
}
export class RuntimeCommandService {
  constructor(ctx: Ctx, signal: AbortSignal);
  run(triple?: string): Promise<void>;
  download(file: string): Promise<void>;
  dispose(): void;
}

// page/src/runtime_worker_protocol.ts
export type UtilityWorkerInbound =
  | { type: "initialize"; generation: RuntimeGeneration; ctx: Ctx; wasiRef: WASIFarmRefObject }
  | { type: "destroyer-adopted"; generation: RuntimeGeneration };
export type UtilityWorkerOutbound =
  | { type: "destroyer"; generation: RuntimeGeneration; handle: DestroyerHandleObject }
  | { type: "ready"; generation: RuntimeGeneration }
  | { type: "fatal"; generation: RuntimeGeneration; message: string };
export type LifecycleWorkerInbound =
  | { type: "adopt"; generation: RuntimeGeneration; handle: DestroyerHandleObject }
  | { type: "destroy"; generation: RuntimeGeneration };
export type LifecycleWorkerOutbound =
  | { type: "adopted"; generation: RuntimeGeneration }
  | { type: "destroyed"; generation: RuntimeGeneration }
  | { type: "fatal"; generation: RuntimeGeneration; message: string };

// page/src/app_runtime.ts
export type RuntimePhase =
  | "created" | "starting" | "ready" | "disposing" | "disposed"
  | "failed" | "reload-required";
export type RuntimeOperation = "idle" | "run" | "target";
export interface RuntimeState {
  generation: RuntimeGeneration;
  phase: RuntimePhase;
  operation: RuntimeOperation;
  queuedTargets: readonly string[];
  selectedTarget?: string;
  activeTarget?: string;
  completedTargets: readonly string[];
  error?: unknown;
  reloadRequired: boolean;
}
export interface CoordinatorOwner { dispose(): Promise<void> }
export class ReloadRequiredError extends Error {
  readonly name = "ReloadRequiredError";
}
export interface RuntimeQuarantine {
  generation: RuntimeGeneration;
  farm: WASIFarm;
  archiveStore: SysrootArchiveStore;
  hostCallbacks: RuntimeHostCallbackOwner;
  channels: readonly unknown[];
}
export interface AppRuntime {
  readonly ctx: Ctx;
  readonly archiveStore: SysrootArchiveStore;
  readonly signal: AbortSignal;
  start(): Promise<void>;
  attachTerminal(sessionId: number, view: TerminalView): Disposable;
  adoptCoordinator(owner: CoordinatorOwner): void;
  flush(): Promise<void>;
  run(triple?: string): Promise<void>;
  loadTarget(triple: string): Promise<void>;
  subscribe(listener: (state: RuntimeState) => void): () => void;
  reportFatal(error: unknown): void;
  dispose(): Promise<void>;
}
export class RuntimeSupervisor {
  create(): Promise<AppRuntime>;
  disposeCurrent(): Promise<void>;
  state(): RuntimeState | undefined;
  quarantine(resources: RuntimeQuarantine): void;
  readonly reloadRequired: boolean;
}
```

`RuntimeGeneration` is internal routing identity. It appears in worker envelopes, quarantine records, terminal service ownership, and the observational `RuntimeState.generation` test/status snapshot, but it is intentionally not a public property on `AppRuntime`; application code must not route work by reading a runtime token.

### Task 1: Pin and Patch the Threaded WASI Shim

**Files:**
- Create: `scripts/browser_wasi_shim_patch_test.ts`
- Modify: `package.json`
- Modify: `page/package.json`
- Modify: `lib/package.json`
- Modify: `page/src/worker_process/vfs_bindings/package.json`
- Modify: `bun.lockb`
- Modify: `page/src/worker_process/vfs_bindings/bun.lock`
- Generate: `patches/@oligami%2Fbrowser_wasi_shim-threads@0.4.1.patch`
- Generate: `page/src/worker_process/vfs_bindings/patches/@oligami%2Fbrowser_wasi_shim-threads@0.4.1.patch`
- Temporary source: `/tmp/opencode/browser_wasi_shim-af935/threads/src/destroyer_handle.ts`
- Temporary source: `/tmp/opencode/browser_wasi_shim-af935/threads/src/index.ts`
- Temporary source: `/tmp/opencode/browser_wasi_shim-af935/threads/src/shared_array_buffer/worker_background/worker_background_ref.ts`
- Temporary source: `/tmp/opencode/browser_wasi_shim-af935/threads/src/shared_array_buffer/worker_background/worker.ts`
- Temporary source: `/tmp/opencode/browser_wasi_shim-af935/threads/src/shared_array_buffer/thread_spawn.ts`
- Temporary test: `/tmp/opencode/browser_wasi_shim-af935/threads/src/destroyer_handle.test.ts`
- Temporary test: `/tmp/opencode/browser_wasi_shim-af935/threads/src/shared_array_buffer/worker_background/worker_background_destroy.test.ts`

**Interfaces:**
- Consumes: published `DestroyerHandle`, `WorkerBackgroundRef`, `ThreadSpawner`, and Bun patch support.
- Produces: exact patched `@oligami/browser_wasi_shim-threads@0.4.1` in both dependency roots; cloneable `DestroyerHandleObject`; idempotent `destroy()`; coordinator closure after managed-worker termination and before blocking acknowledgement completes.

- [ ] **Step 1: Pin all manifests and write the failing repository test**

Change every dependency value from `^0.4.1` to `0.4.1`. Add both exact patch maps:

```json
"patchedDependencies": {
  "@oligami/browser_wasi_shim-threads@0.4.1": "patches/@oligami%2Fbrowser_wasi_shim-threads@0.4.1.patch"
}
```

Add `scripts/browser_wasi_shim_patch_test.ts` assertions for all four manifests and both installed artifacts:

```ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

const root = new URL("../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("threaded WASI shim is exactly pinned and patched in both roots", async () => {
  for (const path of ["package.json", "page/package.json", "lib/package.json", "page/src/worker_process/vfs_bindings/package.json"]) {
    const manifest = JSON.parse(await read(path));
    assertEquals(manifest.dependencies["@oligami/browser_wasi_shim-threads"], "0.4.1");
  }
  for (const base of ["", "page/src/worker_process/vfs_bindings/"]) {
    const manifest = JSON.parse(await read(`${base}package.json`));
    assertEquals(manifest.patchedDependencies["@oligami/browser_wasi_shim-threads@0.4.1"], "patches/@oligami%2Fbrowser_wasi_shim-threads@0.4.1.patch");
    const source = await read(`${base}node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.ts`);
    assertStringIncludes(source, "WorkerBackgroundRef.init_self(obj.sender)");
    assertStringIncludes(source, "sender: this.sender.get_object()");
    assertStringIncludes(await read(`${base}node_modules/@oligami/browser_wasi_shim-threads/dist/index.d.ts`), "DestroyerHandleObject");
    assert(await Deno.stat(new URL(`${base}patches/@oligami%2Fbrowser_wasi_shim-threads@0.4.1.patch`, root)));
  }
});
```

- [ ] **Step 2: Run the RED test**

Run: `deno test --allow-read scripts/browser_wasi_shim_patch_test.ts`

Expected: FAIL because the manifests still resolve ranges and neither local patch file/artifact contains `WorkerBackgroundRef.init_self(obj.sender)`.

- [ ] **Step 3: Check out the exact complete upstream source and add the dependency test**

Run:

```bash
mkdir -p /tmp/opencode
if [ ! -d /tmp/opencode/browser_wasi_shim-af935/.git ]; then git clone https://github.com/oligamiq/browser_wasi_shim.git /tmp/opencode/browser_wasi_shim-af935; fi
git -C /tmp/opencode/browser_wasi_shim-af935 checkout af935bb5e8f480a1e370aa09899dd323d9c3350d
git -C /tmp/opencode/browser_wasi_shim-af935 status --short
```

Expected: detached HEAD at exactly `af935bb5e8f480a1e370aa09899dd323d9c3350d` and empty status. If the directory already exists, verify `git rev-parse HEAD` and empty status instead of deleting user files.

Add a focused Bun test that stubs `WorkerBackgroundRef.prototype.destroy`, structured-clones `get_object()`, reconstructs it, and proves sequential and concurrent `destroy()` calls invoke the sender once and do not return until the winner publishes completion state `2`. Also assert `ThreadSpawner.destroy()` terminates its directly held worker once. Add a worker-background operation-5 test whose instrumentation must record this exact order:

```ts
expect(events).toEqual([
  "managed-workers-terminated",
  "coordinator-close-issued",
  "blocking-destroy-ack-published",
]);
```

```ts
test("DestroyerHandle transfer is cloneable and destroy is idempotent", () => {
  const object = structuredClone(handle.get_object());
  const restored = DestroyerHandle.init_self(object);
  restored.destroy();
  restored.destroy();
  expect(senderDestroyCalls).toBe(1);
  expect(Atomics.load(new Int32Array(object.destroy_status), 1)).toBe(2);
});
```

- [ ] **Step 4: Apply the minimal source patch in the temporary checkout**

Use `WorkerBackgroundRefObject` in `DestroyerHandleObject`, export `type DestroyerHandleObject` from `src/index.ts`, add `WorkerBackgroundRef.get_object()`, reconstruct through `init_self`, and use notification index 1 as a permanent four-state value (`0 = live`, `1 = destroying`, `2 = destroyed`, `3 = failed`). `listen()` loops until state 2 or 3; a concurrent loser waits while state 1 rather than falsely reporting completion, and state 3 throws so the runtime quarantines:

Preserve the existing exact constructor contract; `WASIFarmAnimal.create_destroyer()` already supplies the dependency-owned shared status buffer. Do not allocate an application-owned replacement:

```ts
constructor(sender: WorkerBackgroundRef, destroy_status: SharedArrayBuffer) {
  this.sender = sender;
  this.destroy_status = destroy_status;
  this.listen_holder = this.listen();
}
```

```ts
export interface DestroyerHandleObject {
  sender: WorkerBackgroundRefObject;
  destroy_status: SharedArrayBuffer;
}
static init_self(obj: DestroyerHandleObject): DestroyerHandle {
  return new DestroyerHandle(WorkerBackgroundRef.init_self(obj.sender), obj.destroy_status);
}
get_object(): DestroyerHandleObject {
  return { sender: this.sender.get_object(), destroy_status: this.destroy_status };
}
destroy(): void {
  if (!this.destroy_status || !this.sender) return;
  const view = new Int32Array(this.destroy_status);
  const prior = Atomics.compareExchange(view, 1, 0, 1);
  if (prior === 2) { this.cleanup(); return; }
  if (prior === 3) { this.cleanup(); throw new Error("destroy previously failed"); }
  if (prior === 1) {
    while (Atomics.load(view, 1) === 1) Atomics.wait(view, 1, 1);
    const completed = Atomics.load(view, 1);
    this.cleanup();
    if (completed === 3) throw new Error("destroy failed");
    return;
  }
  try {
    this.sender.destroy();
    Atomics.store(view, 1, 2);
  } catch (error) {
    Atomics.store(view, 1, 3);
    throw error;
  } finally {
    Atomics.notify(view, 1);
    this.cleanup();
  }
}
```

In worker-background operation 5, terminate managed workers, issue `globalThis.close()` as the coordinator's final lifecycle action, and only then publish the shared blocking acknowledgement before returning from the same message task. Calling `close()` requests shutdown after the current task, so the acknowledgement statements still execute; no lifecycle work may occur after `globalThis.close()`:

```ts
case 5: {
  this.destroy(); // Terminates and clears managed/start workers.
  globalThis.close(); // Final coordinator lifecycle action in this task.
  Atomics.store(lockView, 1, 1);
  Atomics.store(lockView, 2, 0);
  Atomics.notify(lockView, 2, 1); // Complete blocking destroy ack.
  return;
}
```

In `ThreadSpawner.destroy()`, participate in the same permanent completion protocol and call `this.worker_background_worker.terminate()` before clearing the field; do not merely set the field to `undefined`.

- [ ] **Step 5: Build from the complete checkout without npm**

Run from `/tmp/opencode/browser_wasi_shim-af935/threads`:

```bash
PUPPETEER_SKIP_DOWNLOAD=true bun install
bun x spack --config ./src/shared_array_buffer/worker_background/spack.config.cjs
bun src/shared_array_buffer/worker_background/minify.js
bun x vite build
bun scripts/post_build.js
bun test src/destroyer_handle.test.ts src/shared_array_buffer/worker_background/worker_background_destroy.test.ts src/shared_array_buffer/farm_base_call.test.ts
```

Expected: PASS; `dist/browser-wasi-shim-threads.es.js`, `.cjs.js`, `.umd.js`, `dist/index.d.ts`, `dist/worker_background_worker.min.js`, and `dist/worker_background_worker.min.d.ts` exist. No command invokes `npm`.

- [ ] **Step 6: Patch the root and nested installations independently**

From repository root, run `bun install` and then `bun patch @oligami/browser_wasi_shim-threads@0.4.1` before copying any file. The first `bun patch` call is mandatory because it unlinks the installed package from Bun's global cache and makes this local package tree editable. Copy the temporary checkout's `src/` and `dist/` over `node_modules/@oligami/browser_wasi_shim-threads/`, then use Bun's officially supported installed-path commit form:

```bash
bun patch --commit node_modules/@oligami/browser_wasi_shim-threads
```

From `page/src/worker_process/vfs_bindings`, run `bun install` and then `bun patch @oligami/browser_wasi_shim-threads@0.4.1` before copying any file, again unlinking that independent installation from Bun's cache. Copy the same `src/` and `dist/` over its local `node_modules/@oligami/browser_wasi_shim-threads/`, then use the same supported installed-path form:

```bash
bun patch --commit node_modules/@oligami/browser_wasi_shim-threads
```

Expected: Bun updates each local manifest/lock and writes the two exact `%2F` patch paths listed in the file map.

The installed `node_modules/...` argument is deliberate: Bun's official `bun patch --commit` documentation supports both an installed path such as `node_modules/react` and a package name. Do not replace this workflow with an invented temporary patch-directory requirement.

- [ ] **Step 7: Run GREEN dependency verification**

Run:

```bash
deno test --allow-read scripts/browser_wasi_shim_patch_test.ts
bun install --frozen-lockfile
bun install --cwd page/src/worker_process/vfs_bindings --frozen-lockfile
```

Expected: PASS; both installations expose the rebuilt patch and all four manifests remain exactly pinned.

### Task 2: Add Abortable Host Callback Owners

**Files:**
- Create: `page/src/runtime_host_callbacks.ts`
- Create: `page/src/runtime_host_callbacks_test.ts`
- Modify: `lib/src/http_bridge.ts`
- Modify: `lib/src/child_process_bridge.ts`
- Modify: `scripts/vfs_http_bridge_test.ts`
- Modify: `scripts/vfs_child_process_bridge_test.ts`

**Interfaces:**
- Consumes: canonical `HttpBridgeOwner`, `ChildProcessBridgeOwner`, generation `AbortSignal`, synchronous `createSysrootArchiveCallbackAdapter()`, and existing bridge message guards.
- Produces: `RuntimeHostCallbackOwner` with `handle(unknown): Promise<unknown> | unknown`, `abort(reason): void`, `settle(): Promise<void>`, and `dispose(): Promise<void>`; every asynchronous callback is tracked and always settles.

- [ ] **Step 1: Write failing bridge-owner tests**

Add tests proving HTTP disposal aborts the exact signal passed to `fetch`, cancels stored readers, and rejects an active request. Add child-process tests proving disposal clears both timers, removes listeners, terminates the worker, rejects the pending Run promise, and is idempotent.

```ts
const owner = createHttpBridgeOwner(fetchImpl, { signal: generation.signal });
const pending = owner.handle(startMessage);
await owner.dispose();
assertEquals(seenSignal?.aborted, true);
await assertRejects(() => pending, DOMException, "runtime disposed");
```

- [ ] **Step 2: Run RED bridge tests**

Run:

```bash
deno test -A scripts/vfs_http_bridge_test.ts scripts/vfs_child_process_bridge_test.ts
```

Expected: type/runtime FAIL because `createHttpBridgeOwner`, `createChildProcessBridgeOwner`, and `dispose()` do not exist.

- [ ] **Step 3: Implement tracked abort and settlement in both bridge owners**

Use one private controller linked to the generation signal, a `Set<Promise<unknown>>`, and a tracking helper that removes itself in `finally` and installs a rejection observer immediately:

```ts
const active = new Set<Promise<unknown>>();
const track = <T>(operation: Promise<T>): Promise<T> => {
  active.add(operation);
  void operation.catch(() => undefined).finally(() => active.delete(operation));
  return operation;
};
const settle = async () => {
  await Promise.allSettled([...active]);
};
```

Merge the owner signal into each fetch `RequestInit`; retain response readers and child request cleanup records until each operation settles. Implement teardown with concrete owner-local cleanup records:

```ts
const controller = new AbortController();
options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();

function abort(reason = new DOMException("runtime disposed", "AbortError")): void {
  if (controller.signal.aborted) return;
  controller.abort(reason);
  for (const reader of readers) void reader.cancel(reason).catch(() => undefined);
  for (const request of childRequests.values()) {
    request.clearTimers();
    request.removeListeners();
    request.worker.terminate();
    request.rejectRun(reason);
  }
}
async function dispose(): Promise<void> {
  abort();
  await settle();
  readers.clear();
  responses.clear();
  childRequests.clear();
}
```

Pass `controller.signal` to `fetchImpl`; delete a reader/request only in its operation's `finally`. `dispose()` calls `abort()` then `settle()` and is idempotent, so every dependency remains reachable until its callback has resolved or rejected.

- [ ] **Step 4: Compose the runtime callback owner without Rust reentry**

`RuntimeHostCallbackOwner.handle()` is installed only as `WASIFarm`'s `unknown_fn`, whose dependency contract permits `Promise<unknown> | unknown`. It first checks the internal generation token/signal, then dispatches: sysroot synchronously; terminal/LSP/download synchronously; HTTP/child messages through tracked owner Promises. It never calls a Rust export or resumes a disposed generation. Do not install this function as a `SharedObject` endpoint; every separately registered `SharedObject` callback remains synchronous and cloneable.

```ts
handle(message: unknown): Promise<unknown> | unknown {
  this.signal.throwIfAborted();
  const sysroot = this.sysroot(message);
  if (sysroot !== undefined) return sysroot;
  if (isHttpBridgeMessage(message)) return this.track(this.http.handle(message));
  if (isChildProcessMessage(message)) return this.track(this.child.handle(message));
  return this.handleSynchronousMessage(message);
}
```

- [ ] **Step 5: Run GREEN host callback tests**

Run:

```bash
deno test -A scripts/vfs_http_bridge_test.ts scripts/vfs_child_process_bridge_test.ts page/src/runtime_host_callbacks_test.ts
```

Expected: PASS with zero pending promises after disposal and no callback dispatch after generation abort.

### Task 3: Add the Runtime Terminal Service

**Files:**
- Create: `page/src/runtime_terminal_service.ts`
- Create: `page/src/runtime_terminal_service_test.ts`
- Modify: `page/src/terminal_channel_lifecycle.ts`
- Modify: `page/src/terminal_channel_lifecycle_test.ts`

**Interfaces:**
- Consumes: canonical `RuntimeGeneration`, `TerminalView`, `Disposable`, existing UTF-8 capture behavior.
- Produces: canonical `RuntimeTerminalService`; one exact chronological per-session `64 * 1024`-byte decoded replay buffer, separate bounded stdout/stderr capture queries, streaming UTF-8 decoding, and generation-owned view registrations.

- [ ] **Step 1: Write failing terminal ownership tests**

Cover interleaved stdout/stderr before mount, atomic remount, old-disposer safety, complete-code-point trimming, independent stdout/stderr capture queries, generation isolation, exact ANSI replay, split multi-byte Unicode input, no replacement characters, no duplicate/gap at replay-to-live handoff, and exact detached fallback:

```ts
service.write(7, new TextEncoder().encode("before"));
const first = service.attach(7, firstView);
assertEquals(firstWrites, ["before"]);
const second = service.attach(7, secondView);
first.dispose();
service.write(7, new TextEncoder().encode("after"));
assertEquals(secondWrites, ["before", "after"]);
assertEquals(secondWrites.join(""), "beforeafter");
assertEquals(service.size(7), { cols: 80, rows: 24 });

const exact = "\x1b[31m赤🙂\x1b[0m";
const bytes = new TextEncoder().encode(exact);
service.write(9, bytes.subarray(0, 7), true);
service.write(9, bytes.subarray(7, 10), true);
service.write(9, bytes.subarray(10), true);
const replayed: string[] = [];
service.attach(9, { write: (value) => replayed.push(value), size: () => ({ cols: 80, rows: 24 }) });
assertEquals(replayed.join(""), exact);
assertEquals(replayed.join("").includes("�"), false);

const red = new TextEncoder().encode("赤");
service.write(10, red.subarray(0, 1), false);
service.write(10, new TextEncoder().encode("ERR"), true);
service.write(10, red.subarray(1), false);
const interleaved: string[] = [];
service.attach(10, { write: (value) => interleaved.push(value), size: () => ({ cols: 80, rows: 24 }) });
assertEquals(interleaved.join(""), "ERR赤");
assertEquals(interleaved.join("").includes("�"), false);
```

- [ ] **Step 2: Run RED terminal tests**

Run: `deno test page/src/runtime_terminal_service_test.ts page/src/terminal_channel_lifecycle_test.ts`

Expected: FAIL because `RuntimeTerminalService` is absent.

- [ ] **Step 3: Implement byte-safe buffering and token-owned attachment**

Move/export the existing string-based `appendBounded(current: string, currentBytes: number, value: string, limit: number)` from `terminal_channel_lifecycle.ts`. Store `{ outDecoder: TextDecoder, errorDecoder: TextDecoder, history: string, historyBytes: number, out: string, outBytes: number, error: string, errorBytes: number, view, attachment }` by session; each `*Bytes` field is only an encoded-length counter, never a raw byte buffer. Decode each byte chunk with `(error ? session.errorDecoder : session.outDecoder).decode(data, { stream: true })`, retaining every decoded character exactly, including ESC bytes and existing ANSI sequences. Independent decoders prevent an incomplete stdout code point from being corrupted by an intervening stderr chunk. Feed only completed decoded strings into `appendBounded`, which measures UTF-8 with `TextEncoder` and trims complete code points. Do not synthesize stderr color, strip ANSI, normalize newlines, or decode each chunk with a fresh decoder. Append the exact decoded text to the chronological history and to the selected stdout/stderr capture. Replay the retained history exactly once before publishing a newly attached view, then route each later decoded string exactly once to that view. Unregister only when the disposer still owns the current attachment token.

```ts
attach(sessionId: number, view: TerminalView): Disposable {
  this.assertActive();
  const session = this.session(sessionId);
  const attachment = Symbol(`${this.generation}:${sessionId}`);
  view.write(session.history);
  session.view = { attachment, view };
  return { dispose: () => {
    if (session.view?.attachment === attachment) session.view = undefined;
  }};
}
```

- [ ] **Step 4: Run GREEN terminal tests**

Run:

```bash
deno test page/src/runtime_terminal_service_test.ts page/src/terminal_channel_lifecycle_test.ts
```

Expected: PASS; retained UTF-8 byte lengths never exceed `65_536`, stale disposers cannot detach a remounted view, and detached size is exactly 80x24.

### Task 4: Replace Module Globals with Generation Parser and Command Services

**Files:**
- Create: `page/src/runtime_command_service.ts`
- Create: `page/src/runtime_command_service_test.ts`
- Modify: `page/src/cmd_parser.ts`
- Modify: `page/src/compile_and_run.ts`

**Interfaces:**
- Consumes: canonical `RuntimeParserService`, `RuntimeCommandService`, fresh `Ctx`, generation signal, `SharedObject`, and `SharedObjectRef`.
- Produces: one synchronous waiter owner and one command proxy owner per generation; no mutable module state.

- [ ] **Step 1: Write failing generation-service tests**

Inject channel factories and assert distinct generations never share waiter flags/proxies, waiter methods are synchronous and cloneable, abort rejects a pending command, late old-generation rejection is observed but cannot update the new service, and disposal closes every owned channel once.

```ts
const methods = fakeSharedObject.calls[0].value;
assertEquals(methods.is_all_done(), false);
methods.set_end_of_exec(true);
assertEquals(methods.is_cmd_run_end(), true);
assert(!(methods.is_all_done() instanceof Promise));
```

- [ ] **Step 2: Run RED service tests**

Run: `deno test page/src/runtime_command_service_test.ts`

Expected: FAIL because the instance services are not defined and existing state is module-global.

- [ ] **Step 3: Implement parser and command owners**

Create the waiter synchronously in the parser constructor, expose `ready` for setup completion, and close it in `dispose()`. In `RuntimeCommandService`, construct and retain `inputString` with the canonical `InputStringEndpoint` type; close that ref in `dispose()`. Race every proxy operation against generation abort while observing the losing proxy rejection.

```ts
private readonly inputString: (args: {
  sessionId: number;
  data: string;
}) => Promise<void>;

constructor(ctx: Ctx, readonly signal: AbortSignal) {
  this.inputStringRef = new SharedObjectRef(ctx.input_string_id);
  this.inputString = this.inputStringRef.proxy<InputStringEndpoint>();
}
private command(args: readonly string[]): Promise<void> {
  this.signal.throwIfAborted();
  const proxy = this.inputString({ sessionId: 0, data: `${args.join(" ")}\r` });
  void proxy.catch(() => undefined);
  return Promise.race([proxy, abortPromise(this.signal)]);
}
run(triple?: string): Promise<void> {
  return this.command(triple === undefined
    ? ["cargo", "run"]
    : ["cargo", "run", "--target", triple]);
}
```

The proxy call cannot be cooperatively canceled after the utility worker accepts it. Abort stops waiting, retains a rejection observer, and `AppRuntime.dispose()` terminates the utility worker before releasing command dependencies.

Keep `cmd_parser.ts` and `compile_and_run.ts` free of owners or setup flags; export only shared message types/helpers required by existing non-page consumers.

- [ ] **Step 4: Run GREEN generation-service tests**

Run:

```bash
deno test page/src/runtime_command_service_test.ts page/src/lsp_bridge_test.ts
```

Expected: PASS with no module-global `ctx`, proxy, waiter, readiness, or command state.

### Task 5: Start the Utility Worker Directly and Add the Lifecycle Handshake

**Files:**
- Create: `page/src/runtime_worker_protocol.ts`
- Create: `page/src/runtime_worker_protocol_test.ts`
- Create: `page/src/worker_process/lifecycle_worker.ts`
- Modify: `page/src/worker_process/util_cmd.ts`
- Delete: `page/src/worker_process/worker.ts`

**Interfaces:**
- Consumes: canonical worker envelopes, patched `DestroyerHandle.init_self()`, `WASIFarmAnimal.create_destroyer()`, and one `WASIFarmRefObject`.
- Produces: one direct utility worker owning exactly one Animal and one `vfs_root`; one lifecycle worker owning the transferable destroyer; adoption acknowledgement before guest construction.

- [ ] **Step 1: Write failing protocol and source-topology tests**

Test strict message guards, mismatched-token rejection, duplicate initialize/adopt rejection, and handshake ordering. Inject an Animal whose `start(vfsRoot)` throws and assert `destroy()` runs exactly once and the worker emits one fatal envelope. Add a source assertion that `index.tsx`/runtime imports `util_cmd.ts?worker` directly and no source imports `worker_process/worker.ts`.

```ts
assertEquals(events, [
  "animal-created",
  "destroyer-posted",
  "lifecycle-adopted",
  "vfs-instantiated",
  "ready",
]);

await assertRejects(() => initializeWith({
  start() { throw new Error("start failed"); },
  destroy() { events.push("animal-destroyed"); },
}), Error, "start failed");
assertEquals(events.filter((event) => event === "animal-destroyed").length, 1);
assertEquals(outbound.filter((message) => message.type === "fatal").length, 1);
```

- [ ] **Step 2: Run RED worker tests**

Run: `deno test --allow-read page/src/runtime_worker_protocol_test.ts page/src/worker_process/lsp_dispatch_test.ts`

Expected: FAIL because direct handshake envelopes/lifecycle worker do not exist and the forwarding worker is still referenced.

- [ ] **Step 3: Implement utility one-shot initialization**

Reject a second `initialize`. Construct one thread-enabled Animal, immediately post its cloneable destroyer, and await the matching `destroyer-adopted` envelope before fetching/instantiating/starting `vfs_root` or registering SharedObjects.

```ts
const animal = new WASIFarmAnimal(message.wasiRef, [], [], threadOptions);
let guestStarted = false;
try {
  postMessage({
    type: "destroyer",
    generation,
    handle: animal.create_destroyer().get_object(),
  } satisfies UtilityWorkerOutbound);
  await destroyerAdopted.promise;
  signalGenerationGuard(generation);
  const vfsRoot = await instantiateVfsRoot(animal, ctx);
  registerHandlers(vfsRoot, ctx);
  postMessage({ type: "ready", generation } satisfies UtilityWorkerOutbound);
  animal.start(vfsRoot);
  guestStarted = true;
} catch (error) {
  postMessage({ type: "fatal", generation, message: toErrorMessage(error) } satisfies UtilityWorkerOutbound);
  throw error;
} finally {
  if (!guestStarted) animal.destroy();
}
```

Keep every SharedObject callback synchronous and cloneable. Dispose its local `shared` array only during worker failure/normal exit; the main safety boundary is worker termination, not a cancellation message to blocked Wasm.

- [ ] **Step 4: Implement the independent lifecycle worker**

On `adopt`, reconstruct once and acknowledge. On `destroy`, synchronously invoke the patched handle, then acknowledge. Reject wrong generations and duplicate adoption without replacing the first handle.

```ts
if (message.type === "adopt") {
  if (destroyer !== undefined) throw new Error("destroyer already adopted");
  generation = message.generation;
  destroyer = DestroyerHandle.init_self(message.handle);
  postMessage({ type: "adopted", generation } satisfies LifecycleWorkerOutbound);
} else if (message.type === "destroy" && message.generation === generation) {
  try {
    destroyer?.destroy();
    postMessage({ type: "destroyed", generation } satisfies LifecycleWorkerOutbound);
  } catch (error) {
    postMessage({ type: "fatal", generation, message: toErrorMessage(error) } satisfies LifecycleWorkerOutbound);
  }
}
```

- [ ] **Step 5: Run GREEN worker tests**

Run:

```bash
deno test --allow-read page/src/runtime_worker_protocol_test.ts page/src/worker_process/lsp_dispatch_test.ts
```

Expected: PASS; there is no forwarding worker, no Worker object is transferred, guest startup is impossible before adoption, and exactly one Animal/`vfs_root` can exist per utility worker.

### Task 6: Implement RuntimeSupervisor and AppRuntime Teardown Core

**Files:**
- Create: `page/src/app_runtime.ts`
- Create: `page/src/app_runtime_test.ts`
- Modify: `page/src/xterm.tsx`
- Modify: `page/src/terminal_channel_lifecycle.ts`
- Modify: `page/src/lsp_bridge.ts`
- Modify: `page/src/rust_lsp_client_dispose.ts`

**Interfaces:**
- Consumes: all canonical interfaces, direct workers from Task 5, callback/terminal/command owners, fresh `createCtx()`, `SysrootArchiveStore`, persistent `workspaceFileSystem` preopen/root.
- Produces: canonical `AppRuntime` and `RuntimeSupervisor`; sole `dispose()` cleanup entrypoint; 5-second callback and destroy acknowledgements; reload-required quarantine.

- [ ] **Step 1: Write failing runtime ownership and teardown tests**

Use injected fake resource factories. Cover fresh resources per generation, duplicate `start`, duplicate coordinator adoption, terminal remount without runtime recreation, startup failure/error/messageerror single fatal transition, new-operation rejection after disposal starts, and exact teardown event order:

```ts
assertEquals(events, [
  "data-plane-detached",
  "generation-aborted",
  "host-producers-aborted",
  "host-callbacks-settled",
  "animal-destroy-requested",
  "animal-destroyed",
  "utility-worker-terminated",
  "lifecycle-worker-terminated",
  "operations-settled",
  "farm-destroyed",
  "channels-disposed",
  "store-disposed",
  "registrations-cleared",
]);
```

Also test disposal before Animal construction cleans normally, disposal after destroyer receipt but before lifecycle adoption quarantines, a hung callback quarantines, and supervisor creation rejects with `reload required` after quarantine. Start a target whose accepted `state` proxy never resolves, call `dispose()`, and assert generation abort, destroy request, utility termination, and lifecycle termination all occur without releasing that proxy; only the abort-raced target wrapper settles afterward.

```ts
const neverSettles = new Promise<number>(() => {});
const target = runtime.loadTarget("wasm32-wasip2");
fakeTargetEndpoint.resolveStart(41);
fakeTargetEndpoint.returnState(neverSettles);
await fakeTargetEndpoint.stateRequested;
await runtime.dispose();
await assertRejects(() => target, DOMException, "runtime disposed");
assertEquals(events.indexOf("utility-worker-terminated") < events.indexOf("operations-settled"), true);
assertEquals(events.indexOf("lifecycle-worker-terminated") < events.indexOf("operations-settled"), true);
```

- [ ] **Step 2: Run RED runtime tests**

Run: `deno test page/src/app_runtime_test.ts page/src/app_startup_lifecycle_test.ts`

Expected: FAIL because runtime/supervisor ownership and quarantine do not exist.

- [ ] **Step 3: Construct each runtime in approved startup order**

`RuntimeSupervisor.create()` waits for ordinary prior disposal, rejects if quarantined, then constructs but does not start a runtime. `AppRuntime.start()` creates farm/callbacks independent of terminal mount, starts the utility and lifecycle workers, completes destroyer adoption, and resolves only on matching utility `ready`.

```ts
async start(): Promise<void> {
  if (this.state.phase !== "created") throw new Error("runtime already started");
  this.transition({ phase: "starting" });
  this.createFarmAndCallbacks();
  this.startWorkers();
  await raceAbort(this.vfsReady.promise, this.signal);
  this.transition({ phase: "ready" });
}
```

- [ ] **Step 4: Implement idempotent ordered disposal and primary-error preservation**

Set `disposing` before removing data-plane listeners. Detach utility/data-plane listeners but retain the lifecycle worker's token-guarded teardown-control `message`, `error`, and `messageerror` listeners until destroy acknowledgement or timeout. Abort generation and explicit host producers. Bound callback settlement to `5_000` ms. Invoke the lifecycle destroyer and use an explicit `Promise.race` against a `5_000` ms acknowledgement deadline, then terminate both directly owned workers regardless of acknowledgement. Only after those hard-stop actions await coordinator/LSP/Run/target wrappers. Every target proxy/status call is raced against the generation signal and has a rejection observer, so disposal never waits for cooperative `runAcceptedTargetExtraction` polling or a blocked guest response.

```ts
async dispose(): Promise<void> {
  if (this.disposePromise !== undefined) return this.disposePromise;
  this.disposePromise = this.disposeInner();
  return this.disposePromise;
}

private async disposeInner(): Promise<void> {
  const cleanupErrors: unknown[] = [];
  let callbacksSafe = false;
  let animalSafe = false;
  this.transition({ phase: "disposing", operation: "idle", queuedTargets: [] });
  this.detachDataPlane();
  this.abortController.abort(this.primaryError ?? new DOMException("runtime disposed", "AbortError"));
  try { await withTimeout(this.hostCallbacks.dispose(), 5_000); callbacksSafe = true; }
  catch (error) { cleanupErrors.push(error); }
  const destroyAttempt = this.destroyAnimal().then(
    () => ({ kind: "ack" } as const),
    (error) => ({ kind: "error", error } as const),
  );
  let destroyDeadline: ReturnType<typeof setTimeout> | undefined;
  const destroyOutcome = await Promise.race([
    destroyAttempt,
    new Promise<{ kind: "timeout" }>((resolve) => {
      destroyDeadline = setTimeout(() => resolve({ kind: "timeout" }), 5_000);
    }),
  ]).finally(() => {
    if (destroyDeadline !== undefined) clearTimeout(destroyDeadline);
  });
  if (destroyOutcome.kind === "ack") animalSafe = true;
  else cleanupErrors.push(destroyOutcome.kind === "error"
    ? destroyOutcome.error
    : new Error("Animal destroy acknowledgement timed out after 5000ms"));
  this.utilityWorker?.terminate();
  this.lifecycleWorker?.terminate();
  await this.settleOperations().catch((error) => cleanupErrors.push(error));
  if (!callbacksSafe || !animalSafe) {
    this.enterQuarantine(cleanupErrors);
    this.throwDisposalError(cleanupErrors);
    return;
  }
  try { this.farm?.destroy(); } catch (error) { cleanupErrors.push(error); }
  try { this.disposeChannels(); } catch (error) { cleanupErrors.push(error); }
  try { this.archiveStore.dispose(); } catch (error) { cleanupErrors.push(error); }
  this.clearOwnedRegistrations();
  this.finishDisposal(cleanupErrors);
}
```

`throwDisposalError()` throws the primary error when it is the sole failure, otherwise throws one `AggregateError(cleanupErrors, "runtime cleanup failed", { cause: this.primaryError })`. `finishDisposal()` uses the same rule after releasing an ordinarily disposed supervisor slot. Neither helper replaces `primaryError`, and quarantine never resolves disposal successfully. If both safety confirmations succeed: synchronously `farm.destroy()`, close channels/services, dispose store/progress, clear token-owned registrations, release supervisor slot.

- [ ] **Step 5: Implement quarantine as retained ownership, not cleanup**

If callback settlement or Animal destruction is unconfirmed, terminate both workers, then transfer one object containing farm, store, callback owners, channels, and generation token to supervisor. Do not destroy/close/dispose those retained dependencies. Set `reload-required`, clear only token-owned UI state, and make every later `RuntimeSupervisor.create()` reject with `new ReloadRequiredError("reload required")` for this page.

```ts
this.supervisor.quarantine({
  generation: this.generation,
  farm: this.farm,
  archiveStore: this.archiveStore,
  hostCallbacks: this.hostCallbacks,
  channels: this.channels,
});
```

- [ ] **Step 6: Run GREEN teardown tests**

Run:

```bash
deno test page/src/app_runtime_test.ts page/src/app_startup_lifecycle_test.ts page/src/lsp_bridge_test.ts page/src/rust_lsp_client_test.ts
```

Expected: PASS; worker termination precedes farm destruction, ordinary cleanup releases the slot only after quiescence, and quarantine never starts a later runtime against `workspaceFileSystem`.

### Task 7: Integrate Run and Target Admission with Runtime Status

**Files:**
- Modify: `page/src/app_runtime.ts`
- Modify: `page/src/app_runtime_test.ts`
- Modify: `page/src/app_startup_lifecycle.ts`
- Modify: `page/src/app_startup_lifecycle_test.ts`
- Modify: `page/src/btn.tsx`
- Modify: `page/src/btn_test.ts`
- Modify: `page/src/run_after_flush_test.ts`
- Modify: `page/src/TargetSelector.tsx`
- Modify: `page/src/target_selector_state.ts`
- Modify: `page/src/target_selector_test.ts`

**Interfaces:**
- Consumes: canonical `AppRuntime.run()`, `loadTarget()`, `subscribe()`, command service, startup `flush()`, and existing additional-target prefetch/extraction.
- Produces: serialized target queue; immediate busy rejection for Run/target overlap and duplicate Run; status-driven native disabled controls; fatal accepted-transport classification.

- [ ] **Step 1: Write failing admission/status tests**

Assert Run calls `flush()` before command dispatch, a second Run rejects `runtime busy: run`, Run during queued/active target rejects, target during Run rejects, and two targets execute serially. Assert the same in-flight triple returns the identical Promise, a completed triple resolves without another prefetch/extraction, completed entries remain in `completedTargets`, queued targets abort on disposal, and normal guest target failure returns state to `ready/idle`. Assert `selectedTarget` follows the latest user choice while `activeTarget` remains the triple actually extracting until it settles.

```ts
const first = runtime.loadTarget("wasm32-wasip2");
assertStrictEquals(runtime.loadTarget("wasm32-wasip2"), first);
const second = runtime.loadTarget("wasm32-unknown-unknown");
await Promise.resolve(); // Allow the first queued target to become active.
await assertRejects(() => runtime.run(), Error, "runtime busy: target");
assertEquals(state.selectedTarget, "wasm32-unknown-unknown");
assertEquals(state.activeTarget, "wasm32-wasip2");
assertEquals(state.queuedTargets, ["wasm32-wasip2", "wasm32-unknown-unknown"]);
assertEquals(events, ["prefetch:wasip2", "extract:wasip2"]);
releaseFirst();
await Promise.all([first, second]);
assertEquals(state.completedTargets, ["wasm32-wasip2", "wasm32-unknown-unknown"]);
await runtime.loadTarget("wasm32-wasip2");
assertEquals(events.filter((event) => event === "extract:wasip2").length, 1);
```

- [ ] **Step 2: Run RED admission tests**

Run:

```bash
deno test page/src/app_runtime_test.ts page/src/app_startup_lifecycle_test.ts page/src/run_after_flush_test.ts page/src/target_selector_test.ts page/src/btn_test.ts
```

Expected: FAIL because controls still call module globals and the runtime does not arbitrate operations.

- [ ] **Step 3: Implement exact admission rules**

`run()` requires runtime `ready`, operation `idle`, and `queuedTargets.length === 0`; it sets `run`, awaits `flush()` then command, and restores `idle` in `finally`. `loadTarget()` rejects while Run is active, updates persistent `selectedTarget`, returns immediately for a completed triple, returns the identical Promise for the same in-flight triple, appends the exact triple to `queuedTargets` before enqueueing, and chains prefetch plus accepted extraction on one tail. `activeTarget` changes only when that triple begins extraction. Keep operation `target` continuously while any queued target remains, so there is no idle admission gap. Once guest extraction is accepted, transport timeout/loss calls `reportFatal`; a reported guest state/error leaves runtime healthy.

```ts
private readonly completedTargets = new Set<string>(["wasm32-wasip1"]);
private readonly targetOperations = new Map<string, Promise<void>>();
private targetQueue: string[] = [];

async run(triple?: string): Promise<void> {
  this.assertReady();
  if (this.state.operation !== "idle" || this.state.queuedTargets.length !== 0) {
    throw new Error(`runtime busy: ${this.state.operation === "idle" ? "target" : this.state.operation}`);
  }
  this.transition({ operation: "run" });
  try {
    await this.flush();
    await this.commands.run(triple);
  } finally {
    if (this.state.phase === "ready") this.transition({ operation: "idle" });
  }
}

loadTarget(triple: string): Promise<void> {
  this.assertReady();
  if (this.state.operation === "run") return Promise.reject(new Error("runtime busy: run"));
  this.transition({ selectedTarget: triple });
  if (this.completedTargets.has(triple)) return Promise.resolve();
  const duplicate = this.targetOperations.get(triple);
  if (duplicate !== undefined) return duplicate;
  this.targetQueue.push(triple);
  this.transition({
    operation: "target",
    queuedTargets: [...this.targetQueue],
    completedTargets: [...this.completedTargets],
  });
  const operation = this.targetTail.then(async () => {
    this.signal.throwIfAborted();
    this.transition({ activeTarget: triple });
    await this.archiveStore.prefetch([triple], this.signal);
    await runAcceptedTargetExtraction(this.targetDependencies(triple));
    this.completedTargets.add(triple);
  }).finally(() => {
    this.targetOperations.delete(triple);
    if (this.state.phase !== "ready") return;
    this.targetQueue = this.targetQueue.filter((queued) => queued !== triple);
    const queuedTargets = [...this.targetQueue];
    this.transition({
      queuedTargets,
      operation: queuedTargets.length === 0 ? "idle" : "target",
      activeTarget: undefined,
      completedTargets: [...this.completedTargets],
    });
  });
  this.targetTail = operation.catch(() => undefined);
  this.targetOperations.set(triple, operation);
  return operation;
}
```

Only `targetOperations` and `targetQueue` entries are removed in `finally`; never delete from `completedTargets`. Initialize the completed set with the startup-installed `wasm32-wasip1` target and publish a fresh readonly array in each state snapshot.

Wrap every accepted extraction endpoint call, including `state`, `error`, and `release`, with an abort race that immediately observes the losing transport Promise. On generation abort, exit without issuing `cancel`, `state`, `error`, or `release`; teardown is already hard-stopping the Animal and utility worker:

```ts
function raceGenerationTransport<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  void operation.catch(() => undefined);
  return Promise.race([operation, abortPromise(signal)]);
}
const callEndpoint = (request: AdditionalSysrootRequest) => {
  signal.throwIfAborted();
  return raceGenerationTransport(endpoint(request), signal);
};
```

- [ ] **Step 4: Migrate Run and target controls**

Change props to concrete callbacks and state, removing imports of module-global `compile_and_run`:

```ts
export const RunButton = (props: {
  triple?: string;
  disabled: boolean;
  run(triple?: string): Promise<void>;
}) => <button disabled={props.disabled} onClick={() => {
  if (!props.disabled) void props.run(props.triple).catch(console.error);
}}>Compile and Run</button>;
```

`TargetSelector` receives `loadTarget(triple): Promise<void>`. Its selected value comes from persistent `selectedTarget`; its loading label/spinner comes only from transient `activeTarget`/`operation`; completed choices come from `completedTargets`. Preserve native `disabled` behavior and do not replace the user's selection when a queued target becomes active.

- [ ] **Step 5: Run GREEN admission/status tests**

Run the Step 2 command again.

Expected: PASS; operation transitions are observable through `subscribe()`, no Run/target overlap occurs, and controls remain disabled until both staged startup and runtime are ready.

### Task 8: Migrate App, Entrypoint, Terminal UI, and Test API

**Files:**
- Modify: `page/src/index.tsx`
- Modify: `page/src/App.tsx`
- Create: `page/src/runtime_entrypoint.ts`
- Create: `page/src/runtime_entrypoint_test.ts`
- Create: `page/src/RuntimeCreationFailure.tsx`
- Modify: `page/src/xterm.tsx`
- Modify: `page/src/solid_xterm_lifecycle.ts`
- Modify: `page/src/solid_xterm_lifecycle_test.ts`
- Modify: `page/src/lsp_start_gate_test.ts`
- Modify: `page/src/lsp_test_api.ts`
- Modify: `page/src/lsp_test_api_state.ts`
- Modify: `page/src/lsp_test_api_state_test.ts`
- Modify: `page/src/rust_lsp_client.ts`
- Modify: `page/src/rust_lsp_client_dispose.ts`
- Modify: `page/src/rust_lsp_client_test.ts`

**Interfaces:**
- Consumes: canonical runtime/supervisor/terminal APIs and existing `StartupCoordinator`/`StartupOverlay`/rust-analyzer startup APIs.
- Produces: one runtime per App generation, visible reload-required/fatal creation fallback, immediate named editable model, coordinator adoption, runtime-backed UI, generation-qualified test state, and no farm creation in terminal components.

- [ ] **Step 1: Extend failing App/UI/test API assertions**

Keep the exact named-model source assertion and add checks that `index.tsx` creates a `RuntimeSupervisor`, obtains one runtime, passes it to `App`, imports no forwarding worker, and leaves `workspaceFileSystem` outside runtime ownership. Add a behavioral `runtime_entrypoint_test.ts` in which `supervisor.create()` rejects with `ReloadRequiredError`: await the entrypoint, assert App was never rendered, assert a visible failure model with `reloadRequired: true` was rendered exactly once, and assert the Promise resolves rather than becoming an unhandled rejection. Assert `SetupMyTerminal` takes `runtime`/`sessionId`, never `archiveStore` or a farm callback, and remount does not create runtime resources. Preserve `StartupOverlay` inside the editor container with click-through behavior, indeterminate progress for tasks without byte totals, and the originating failure message while code remains visible.

```ts
// page/src/runtime_entrypoint.ts
export type RuntimeCreationFailureModel = {
  message: string;
  reloadRequired: boolean;
};

export async function mountRuntimeApplication(dependencies: {
  createRuntime(): Promise<AppRuntime>;
  renderApp(runtime: AppRuntime): void;
  renderFailure(failure: RuntimeCreationFailureModel): void;
}): Promise<void> {
  try {
    dependencies.renderApp(await dependencies.createRuntime());
  } catch (error) {
    dependencies.renderFailure({
      message: error instanceof Error ? error.message : String(error),
      reloadRequired: error instanceof ReloadRequiredError,
    });
  }
}

// page/src/RuntimeCreationFailure.tsx
export function RuntimeCreationFailure(props: {
  failure: RuntimeCreationFailureModel;
  onReload(): void;
}) {
  return <main role="alert" id="runtime-creation-failure">
    <h1>{props.failure.reloadRequired ? "Reload required" : "Runtime failed to start"}</h1>
    <p>{props.failure.message}</p>
    {props.failure.reloadRequired && <button type="button" onClick={props.onReload}>Reload page</button>}
  </main>;
}

// page/src/index.tsx
await mountRuntimeApplication({
  createRuntime: () => Promise.reject(new ReloadRequiredError("reload required")),
  renderApp: () => appRenders++,
  renderFailure: (failure) => failures.push(failure),
});
assertEquals(appRenders, 0);
assertEquals(failures, [{ message: "reload required", reloadRequired: true }]);
```

```ts
const uri = mountedMonaco.Uri.parse("file:///src/main.rs");
const model = mountedMonaco.editor.getModel(uri) ??
  mountedMonaco.editor.createModel(default_value, "plaintext", uri);
mountedEditor.setModel(model);
mountedEditor.updateOptions({ readOnly: false });
```

- [ ] **Step 2: Run RED migration tests**

Run:

```bash
deno test --allow-read page/src/runtime_entrypoint_test.ts page/src/lsp_start_gate_test.ts page/src/solid_xterm_lifecycle_test.ts page/src/lsp_test_api_state_test.ts page/src/run_after_flush_test.ts
```

Expected: FAIL because App still receives `ctx`/farm callback/worker terminator and terminal mount creates the farm.

- [ ] **Step 3: Migrate entrypoint and preserve exact startup order**

Create one page-level supervisor beside persistent `workspaceFileSystem`. `index.tsx` delegates creation to `mountRuntimeApplication()`, which catches every creation rejection and renders `RuntimeCreationFailure`; quarantine/`ReloadRequiredError` selects reload-required copy and a button whose action calls `globalThis.location.reload()`. It never rethrows after rendering, so initial quarantine cannot leave a blank root or unhandled Promise. On success render `App`; in `App`, attach the model synchronously before calling `runtime.start()`. Create `StartupCoordinator` with `runtime.archiveStore`, immediately call `runtime.adoptCoordinator(coordinator)`, then run existing staged phases unchanged.

```ts
await mountRuntimeApplication({
  createRuntime: () => runtimeSupervisor.create(),
  renderApp: (runtime) => render(() =>
    <App runtime={runtime} startLspClient={(monaco, model, signal) =>
      startRustLspClient(runtime.ctx, monaco, model, signal)
    } />, root),
  renderFailure: (failure) => render(() =>
    <RuntimeCreationFailure failure={failure} onReload={() => globalThis.location.reload()} />, root),
});
```

- [ ] **Step 4: Migrate terminal mounts and generation cleanup**

`SetupMyTerminal` adapts xterm to canonical `TerminalView`, calls `runtime.attachTerminal(sessionId, view)` on mount, and disposes only that attachment on unmount. Input/resize SharedObjectRef channels are runtime-owned; terminal cleanup cannot close a remounted or later-generation channel. Remove `terminals`, `terminalRouter`, `get_ref`, farm, HTTP/child bridges, and archive store from `xterm.tsx`.

- [ ] **Step 5: Migrate LSP/test registrations with token ownership**

Pass `runtime.signal` and generation through LSP bridges. Every late completion checks both signal and generation owner before updating UI/test state. Extend the test API without replacing staged fields:

```ts
runtime: {
  generation: string;
  phase: RuntimePhase;
  operation: RuntimeOperation;
  queuedTargets: readonly string[];
  selectedTarget?: string;
  activeTarget?: string;
  completedTargets: readonly string[];
  reloadRequired: boolean;
  utilityWorkers: number;
  lifecycleWorkers: number;
  farmCallbacks: number;
};
startup: {
  phase: StartupPhase;
  history: StartupPhase[];
  overlayVisible: boolean;
  crateGraphReady: boolean;
  diagnosticsVersion?: number;
  inlayHintVersion?: number;
  cargoCallsBeforeProjectActivation: number;
};
```

- [ ] **Step 6: Run GREEN migration tests and page build**

Run:

```bash
deno test --allow-read page/src/runtime_entrypoint_test.ts page/src/lsp_start_gate_test.ts page/src/solid_xterm_lifecycle_test.ts page/src/lsp_test_api_state_test.ts page/src/run_after_flush_test.ts page/src/rust_lsp_client_test.ts
bun run --cwd page build
```

Expected: PASS; page builds, model remains editable, startup failure preserves source and original error, and no terminal mount owns runtime resources.

### Task 9: Integrate Staged VFS Lifecycle and Run Final Verification

**Files:**
- Modify: `scripts/vfs_lsp_diagnostics_test.ts`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs`
- Modify: `page/src/lsp_test_api.ts`
- Modify: `page/src/lsp_test_api_state.ts`
- Modify: `crates/vfs-shell/src/startup_sysroot_bootstrap.rs`
- Modify: `crates/vfs-shell/src/sysroot_extraction.rs`
- Modify: `crates/vfs-shell/src/main.rs`
- Modify: `crates/vfs/src/shell.rs`
- Modify: `crates/vfs/src/lib.rs`
- Modify: `crates/vfs/wit/vfs-host.wit`
- Modify: `crates/vfs-rustc-twice/wit/vfs-host.wit`
- Generate via `bun run vfs:build`: `page/src/worker_process/vfs_bindings/vfs.js`
- Generate via `bun run vfs:build`: `page/src/worker_process/vfs_bindings/vfs.d.ts`
- Generate via `bun run vfs:build`: `page/src/worker_process/vfs_bindings/interfaces/vfs-host-bridge.d.ts`

**Interfaces:**
- Consumes: completed runtime ownership, staged scalar exports `startup-sysroot-load-state(kind: u32) -> u32` and `startup-sysroot-error-code(kind: u32) -> u32`, approved coordinator phases, browser test API.
- Produces: lifecycle acceptance covering startup/remount/disposal/quarantine while preserving archive bounds, exact crate graph, diagnostics, and inlay readiness.

- [ ] **Step 1: Add failing VFS/browser lifecycle assertions**

In the Deno integration, preserve lightweight initialization before explicit startup sysroot events and project activation. Pad the valid archive to exactly `74_096_640`, track every host read, assert maximum host read `<= 512 * 1024`, print maximum guest request `8192`, and assert zero Cargo/rustc host calls before full project configuration. Add a store regression that `beginRead(triple)` always resets that triple's cursor to byte zero and switching from `rust-src` to a target cannot inherit the prior archive offset.

In browser acceptance, assert: immediate named editable model and overlay; startup edit survives; exact phase history; exact `rubrc-main` and `core`; matching diagnostics/inlay model version; post-ready additional target; disposal during active startup/target read destroys Animal and terminates utility worker before farm/store; remount has no old events/resources; in-flight HTTP/child operations settle; target serialization/busy rejection; forced destroy timeout produces reload-required and blocks remount.

- [ ] **Step 2: Run RED integration subsets before generated changes**

Run:

```bash
deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts
bun scripts/lsp_browser_diagnostics_test.mjs
```

Expected: FAIL on absent runtime lifecycle/test API assertions; existing staged archive/startup assertions must remain green up to that point.

- [ ] **Step 3: Retain scalar-only WIT and bounded Rust extraction**

Verify both WIT copies remain identical and scalar-only:

```wit
export startup-sysroot-load-state: func(kind: u32) -> u32;
export startup-sysroot-error-code: func(kind: u32) -> u32;
```

Keep `MAX_SYSROOT_ARCHIVE_READ_LEN: usize = 512 * 1024`, avoid whole-archive copies, and do not add cancellation/status work as a safety mechanism for synchronous extraction. Lifecycle safety comes from Animal destruction plus utility-worker termination.

- [ ] **Step 4: Generate bindings exactly once with the approved build**

Run: `bun run vfs:build`

Expected: PASS; generated JS/declarations expose `startupSysrootLoadState(kind)` and `startupSysrootErrorCode(kind)`. Do not hand-edit generated output and do not run `bun run vfs:truebuild`.

- [ ] **Step 5: Run Rust and complete Deno unit verification**

Run:

```bash
cargo test -p vfs-shell startup_sysroot_bootstrap
cargo check -p vfs-shell --target wasm32-wasip1
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
  page/src/web_sysroot_test.ts \
  page/src/runtime_host_callbacks_test.ts \
  page/src/runtime_terminal_service_test.ts \
  page/src/runtime_command_service_test.ts \
  page/src/runtime_worker_protocol_test.ts \
  page/src/app_runtime_test.ts \
  page/src/runtime_entrypoint_test.ts
```

Expected: all PASS with no leaked timers, workers, channels, or unhandled rejections.

- [ ] **Step 6: Run VFS integration and verify exact bounded output**

Run: `deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts`

Expected output includes:

```text
served rust-src archive: 74096640 bytes
maximum sysroot chunk request: 8192
```

Expected assertions: maximum host archive read is at most `524288`, zero Cargo/rustc host calls occur before activation, and `core` verification succeeds.

- [ ] **Step 7: Build assets and run browser lifecycle acceptance**

Run:

```bash
bun run --cwd page build
bun run vfs:prepare:prod
bun run rust-src:prepare-asset
bun scripts/lsp_browser_diagnostics_test.mjs
```

Expected: `page/dist/rust-src.tar.vfsbr` exists; browser test PASS confirms approved phase history, startup edit preservation, exact `rubrc-main` plus `core`, post-ready target install, teardown ordering, clean remount, and reload-required quarantine.

- [ ] **Step 8: Inspect the dirty worktree without staging or committing**

Run:

```bash
git status --short
git diff --check
```

Expected: no whitespace errors; only planned files plus pre-existing dirty files are present. Do not stage or commit anything.

## Implementation Notes

- Each task is an independent review gate. Run its GREEN commands before moving to the next task.
- Before editing a dirty file, inspect its current diff and preserve concurrent work. Generated binding diffs are accepted only when produced by Task 9's `bun run vfs:build`.
- A normal disposal may reclaim resources only after both callback settlement and Animal-destroy acknowledgement. Timeout behavior is intentionally conservative: retain unsafe dependencies in quarantine and require reload.
- Do not split safety across `App`, terminal mounts, and worker callbacks. `AppRuntime.dispose()` is the only generation cleanup entrypoint; `RuntimeSupervisor` is the only admission/quarantine owner.

## Plan Self-Review

- [ ] **Check spec coverage:** map dependency patching, direct worker startup, lifecycle adoption, hard-stop teardown, quarantine, terminal fidelity, Run/target admission, named-model startup, exact crate graph, archive bounds, and persistent workspace ownership to Tasks 1-9; add a concrete step before implementation if any requirement lacks an owner.
- [ ] **Scan for placeholders:** run `rg -n 'TB[D]|TO[D]O|implement[[:space:]]+later|fill[[:space:]]+in[[:space:]]+details|similar[[:space:]]+to[[:space:]]+Task|appropriate[[:space:]]+error[[:space:]]+handling' docs/superpowers/plans/2026-08-14-app-owned-vfs-runtime.md`. Expected: no output and exit status 1.
- [ ] **Check task structure:** run `test "$(rg -c '^### Task [0-9]+:' docs/superpowers/plans/2026-08-14-app-owned-vfs-runtime.md)" -eq 9`. Expected: exit status 0.
- [ ] **Check type consistency after implementation:** run `deno check page/src/app_runtime.ts page/src/runtime_host_callbacks.ts page/src/runtime_terminal_service.ts page/src/runtime_command_service.ts page/src/runtime_worker_protocol.ts page/src/runtime_entrypoint.ts`. Expected: no errors; `RuntimeState`, `InputStringEndpoint`, worker envelopes, target fields, and internal generation names match the canonical interfaces.
- [ ] **Check the final plan/worktree diff:** run `git diff --check -- docs/superpowers/plans/2026-08-14-app-owned-vfs-runtime.md` and inspect `git status --short` without staging. Expected: no whitespace errors and no staged files created by this plan.
