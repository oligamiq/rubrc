# Browser Diagnostics Final Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five blocking editor lifecycle, LSP cancellation, rust-src cache/readiness, and sysroot transport findings without changing the validated semantic diagnostics architecture.

**Architecture:** Preserve entry-owned dynamic LSP startup and the post-start named Monaco model, adding a one-shot editor handoff and an abortable startup sequencer around the existing resource owner. Keep deployment cache maintenance, readiness timing, and sysroot chunk validation in focused pure seams so unrelated cache-first fetching and diagnostic marker ownership remain unchanged.

**Tech Stack:** TypeScript, SolidJS, Monaco Editor, `solid-monaco` 0.3.0, `monaco-languageclient`, Deno tests, Bun tests, Vite, Rust/Wasm, Puppeteer browser acceptance

## Global Constraints

- Start the VS Code wrapper before importing `App`; `page/src/index.tsx` must continue to own the dynamic `import("./rust_lsp_client")` boundary.
- Wait for Monaco and successful VFS readiness, prepopulate `/src/main.rs` before `client.start()`, and create `file:///src/main.rs` only after startup succeeds.
- Let `MonacoLanguageClient` remain the sole owner of diagnostic markers; do not add manual marker publication or polling.
- Do not add editable pre-start replay, streaming tar parsing, worker restart, or unrelated bridge hardening.
- Timeout and abort must preserve the original error; cleanup failures remain observable through `console.error` without becoming unhandled rejections.
- Keep generic `fetchWithOptionalCache` query-sensitive and cache-first for every unrelated asset.
- Use `SOURCE_SHA ?? "development"` as the Vite build-time source revision and add `?v=<revision>` only to the same-origin `rust-src.tar.vfsbr` URL.
- Use a rust-src readiness production budget of `75_000` ms, longer than the archive loader's `60_000` ms timeout.
- Treat sysroot chunk reads as a custom exact-length protocol with a shared maximum of `512 * 1024` bytes; reject invalid, short, or oversized requests instead of truncating.
- Run `*_test.ts` with Deno except `page/src/lsp_bridge_test.ts`, which uses `bun:test` and must run with Bun.
- Use `bun x @biomejs/biome@1.9.4 format --write` only on the explicitly listed frontend/script files changed by the current task; do not run repository-wide formatting or the installed Biome 2.x binary.
- Do not hand-edit generated files under `page/src/worker_process/vfs_bindings`; regenerate them only through `bun run vfs:build`.
- Make exactly one commit per task and do not include unrelated working-tree changes.

---

## File Structure

- `page/src/App.tsx`: owns temporary-editor read-only state, one-shot model handoff, gate cleanup observation, and the injected abort-aware starter type.
- `page/src/lsp_test_api.ts`: exposes the mounted Monaco editor to exact browser acceptance without changing production behavior.
- `page/src/lsp_start_gate.ts`: owns the startup `AbortController` and the late-session disposal race check.
- `page/src/rust_lsp_startup.ts`: calls `startClient()` once, observes it permanently, cancels transports on timeout/abort, and boundedly waits for settlement.
- `page/src/rust_lsp_client.ts`: connects the gate signal and startup cancellation action to the existing resource owner.
- `page/src/lsp_bridge.ts`: emits one reader close event before disposing JSON-RPC emitters.
- `page/src/rust_src_cache.ts`: contains deployment-metadata-gated, same-path cache pruning with injected browser dependencies.
- `page/src/sysroot_archive.ts`: builds the revisioned rust-src URL and starts cache maintenance only after successful parsing.
- `page/vite.config.ts`: injects the running source revision.
- `scripts/publish-pages-dist.sh`: passes the already validated source SHA into `build:prod`.
- `page/src/vfs_readiness.ts`: owns the injected polling clock and the `75_000` ms outer deadline.
- `page/src/sysroot_protocol.ts`: owns the `512 KiB` host validation and exact-length byte extraction.
- `crates/vfs-shell/src/main.rs`: limits each guest sysroot request to the host protocol maximum.
- `scripts/vfs_lsp_diagnostics_test.ts`: records, validates, and asserts the maximum request made by the built full VFS.
- Existing adjacent `*_test.ts`, source-contract, and browser scripts verify each boundary without introducing a second test framework.

### Task 1: Read-Only Temporary Monaco Model And One-Shot Handoff

**Files:**
- Modify: `page/src/App.tsx:1-57,84-87,221-227`
- Modify: `page/src/lsp_test_api.ts:8-14,93-97`
- Modify: `page/src/lsp_start_gate_test.ts:74-172`
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts:5-50`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs:99-109`

**Interfaces:**
- Consumes: `solid-monaco@0.3.0` invokes `onMount(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor)`; `startRustLspClient` still creates `file:///src/main.rs` only after `client.start()` resolves.
- Produces: `isEditorReady(): boolean`, set only by the named-model switch listener; `exposeEditor(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor): void`; browser test state fields `monaco?: typeof Monaco` and `editor?: Monaco.editor.IStandaloneCodeEditor`.

- [ ] **Step 1: Add failing source-contract assertions for read-only startup and one-shot disposal**

Extend the test named `App mounts the editor before LSP startup but defers the main model` in `page/src/lsp_start_gate_test.ts` after the existing named-path assertions:

```ts
  assert(
    source.includes("const [isEditorReady, setIsEditorReady] = createSignal(false)"),
    "App lacks editor-specific readiness",
  );
  assert(
    source.includes("options={{ readOnly: !isEditorReady() }}"),
    "temporary Monaco model is not reactively read-only",
  );
  assert(
    source.includes("const temporaryModel = mountedEditor.getModel()") &&
      source.includes("mountedEditor.onDidChangeModel("),
    "App does not observe the temporary-to-named model switch",
  );
  const targetCheck = source.indexOf(
    'currentModel?.uri.toString() !== "file:///src/main.rs"',
  );
  const temporaryDispose = source.indexOf("temporaryModel.dispose()", targetCheck);
  const editorReady = source.indexOf("setIsEditorReady(true)", temporaryDispose);
  const listenerDispose = source.indexOf("modelSwitchDisposable?.dispose()", editorReady);
  assert(targetCheck >= 0, "model listener does not require the named Rust URI");
  assert(
    temporaryDispose > targetCheck && editorReady > temporaryDispose &&
      listenerDispose > editorReady,
    "model handoff must dispose temporary model, mark ready, then self-dispose",
  );
  assert(
    !source.includes("setIsEditorReady(isLspReady())"),
    "LSP readiness incorrectly controls editor mutability",
  );
```

- [ ] **Step 2: Add failing exact-browser contract assertions**

Append this test to `scripts/lsp_browser_diagnostics_contract_test.ts`:

```ts
Deno.test("browser readiness requires one named Rust model and an editable editor", async () => {
  const source = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );
  assert(
    source.includes("rustModels.length === 1") &&
      source.includes('rustModels[0].uri.toString() === "file:///src/main.rs"'),
    "browser readiness does not require exactly one named Rust model",
  );
  assert(
    source.includes("testApi.editor.getOption(") &&
      source.includes("testApi.monaco.editor.EditorOption.readOnly") &&
      source.includes("=== false"),
    "browser readiness does not require an editable mounted editor",
  );
});
```

- [ ] **Step 3: Run the focused contracts and verify RED**

Run: `deno test --no-lock -A page/src/lsp_start_gate_test.ts scripts/lsp_browser_diagnostics_contract_test.ts`

Expected: FAIL with `App lacks editor-specific readiness` and `browser readiness does not require exactly one named Rust model`.

- [ ] **Step 4: Expose the mounted editor through the existing test-only API**

Change the `TestApi` editor fields and exposure function in `page/src/lsp_test_api.ts`:

```ts
type TestApi = DiagnosticsPublicationTestState & {
  mainDidOpenComplete?: boolean;
  requestSyntaxTree?: (uri: string) => Promise<string>;
  ready: boolean;
  monaco?: typeof Monaco;
  editor?: Monaco.editor.IStandaloneCodeEditor;
  vfsWrites: Array<{ path: string; content: string }>;
};

export function exposeEditor(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.monaco = monaco;
  window.__rubrcLspTest.editor = editor;
}
```

Replace the test API import in `page/src/App.tsx` with this exact import; the `handleMount` block in the next step contains the exact replacement call:

```ts
import { exposeEditor, markLspReady } from "./lsp_test_api";
```

Retain App's existing `import * as monaco from "monaco-editor";`, which provides the `monaco.editor.IStandaloneCodeEditor` type used below. Retain `lsp_test_api.ts`'s existing `import type * as Monaco from "monaco-editor";`, which provides its capitalized type namespace.

- [ ] **Step 5: Implement the read-only temporary model and one-shot handoff**

Replace the editor readiness/mount portion of `page/src/App.tsx` with:

```tsx
  const [isLspReady, setIsLspReady] = createSignal(false);
  const [isEditorReady, setIsEditorReady] = createSignal(false);
  let temporaryModel: monaco.editor.ITextModel | null | undefined;
  let modelSwitchDisposable: { dispose(): void } | undefined;
  let lspStartObserved = false;
  const observeLspStart = () => {
    const started = lspGate.started();
    if (!started || lspStartObserved) return;
    lspStartObserved = true;
    void started.then(() => setIsLspReady(true)).catch(console.error);
  };

  const handleMount = (
    mountedMonaco: typeof import("monaco-editor"),
    mountedEditor: monaco.editor.IStandaloneCodeEditor,
  ) => {
    temporaryModel = mountedEditor.getModel();
    modelSwitchDisposable = mountedEditor.onDidChangeModel(() => {
      const currentModel = mountedEditor.getModel();
      if (currentModel?.uri.toString() !== "file:///src/main.rs") return;
      if (temporaryModel && temporaryModel !== currentModel) {
        temporaryModel.dispose();
        temporaryModel = undefined;
      }
      setIsEditorReady(true);
      modelSwitchDisposable?.dispose();
      modelSwitchDisposable = undefined;
    });
    exposeEditor(mountedMonaco, mountedEditor);
    lspGate.setMonaco(mountedMonaco);
    observeLspStart();
    markLspReady();
  };
```

Dispose the listener and any temporary model that still owns the editor at
unmount. Monaco model disposal is idempotent, so Solid Monaco's subsequent
component cleanup remains safe:

```tsx
  onCleanup(() => {
    modelSwitchDisposable?.dispose();
    modelSwitchDisposable = undefined;
    temporaryModel?.dispose();
    temporaryModel = undefined;
    sharedReady.bc.close();
    void lspGate.dispose();
  });
```

Pass reactive editor options while retaining post-start `path` and `value`:

```tsx
        <MonacoEditor
          language="rust"
          path={isLspReady() ? "file:///src/main.rs" : undefined}
          value={isLspReady() ? default_value : undefined}
          options={{ readOnly: !isEditorReady() }}
          height="30vh"
          onMount={handleMount}
        />
```

- [ ] **Step 6: Tighten browser readiness to the exact handoff result**

Replace the predicate in `scripts/lsp_browser_diagnostics_test.mjs` with:

```js
      () => {
        const testApi = window.__rubrcLspTest;
        if (!testApi?.ready || !testApi.monaco || !testApi.editor) return false;
        const rustModels = testApi.monaco.editor.getModels().filter(
          (model) => model.getLanguageId() === "rust",
        );
        return rustModels.length === 1 &&
          rustModels[0].uri.toString() === "file:///src/main.rs" &&
          testApi.editor.getOption(
              testApi.monaco.editor.EditorOption.readOnly,
            ) === false &&
          testApi.mainDidOpenComplete === true &&
          testApi.mainDiagnosticsPublicationCount > 0 &&
          testApi.vfsWrites.some((write) => write.path === "/src/main.rs");
      },
```

- [ ] **Step 7: Format only the changed frontend and contract files**

Run:

```bash
bun x @biomejs/biome@1.9.4 format --write \
  page/src/App.tsx \
  page/src/lsp_test_api.ts \
  page/src/lsp_start_gate_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts \
  scripts/lsp_browser_diagnostics_test.mjs
```

Expected: the five named files are formatted; no other file changes.

- [ ] **Step 8: Run GREEN contracts and the exact browser acceptance**

Run:

```bash
deno test --no-lock -A page/src/lsp_start_gate_test.ts scripts/lsp_browser_diagnostics_contract_test.ts
bun run --cwd page build
bun run test:lsp-browser
```

Expected: Deno tests pass, the page builds, and browser acceptance reaches readiness with exactly one editable Rust model before publishing and clearing the semantic rust-analyzer marker.

- [ ] **Step 9: Commit Task 1**

```bash
git add page/src/App.tsx page/src/lsp_test_api.ts page/src/lsp_start_gate_test.ts scripts/lsp_browser_diagnostics_contract_test.ts scripts/lsp_browser_diagnostics_test.mjs
git commit -m "fix: harden Monaco model handoff"
```

### Task 2: Bounded LSP Startup Cancellation

**Files:**
- Modify: `page/src/lsp_start_gate.ts:5-60`
- Modify: `page/src/lsp_start_gate_test.ts:7-72,107-116`
- Modify: `page/src/App.tsx:33-42,84-88`
- Modify: `page/src/index.tsx:78-81`
- Modify: `page/src/rust_lsp_startup.ts:1-27`
- Modify: `page/src/rust_lsp_startup_test.ts:1-71`
- Modify: `page/src/rust_lsp_client.ts:37-38,88-110`
- Modify: `page/src/rust_lsp_client_test.ts:87-98`
- Modify: `page/src/lsp_bridge.ts:47-54`
- Modify: `page/src/lsp_bridge_test.ts:51-75`

**Interfaces:**
- Consumes: Task 1's `App` editor handoff; existing `DisposableLspSession = { dispose(): Promise<void> }`; existing idempotent `connection.dispose()` and `RustLspResourceOwner.dispose()`.
- Produces: `LspStartGate` starter `(monaco: TMonaco, signal: AbortSignal) => Promise<DisposableLspSession>`; `startRustLspClient(ctx: Ctx, monaco: typeof Monaco, signal: AbortSignal)`; `runRustLspStartup(actions: RustLspStartupActions, timeoutMs: number, signal: AbortSignal, cancellationSettleTimeoutMs?: number): Promise<void>`; action `cancelClientStart(): void`.

- [ ] **Step 1: Add a failing gate disposal test**

Append to `page/src/lsp_start_gate_test.ts`:

```ts
Deno.test("gate disposal aborts and settles an in-progress starter", async () => {
  let starts = 0;
  let observedSignal: AbortSignal | undefined;
  const gate = new LspStartGate<object>((_monaco, signal) => {
    starts++;
    observedSignal = signal;
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  gate.setMonaco({});
  gate.setVfsResult({ ok: true });

  await gate.dispose();

  assert(starts === 1, `starter called ${starts} times`);
  assert(observedSignal?.aborted, "gate disposal did not abort startup");
});
```

In the existing App source contract, require `AbortSignal` in the injected starter and require cleanup rejection observation:

```ts
  assert(source.includes("signal: AbortSignal"), "App starter lacks AbortSignal");
  assert(
    source.includes('console.error("LSP gate cleanup failed:", error)'),
    "App does not observe asynchronous gate cleanup failures",
  );
```

- [ ] **Step 2: Add failing startup cancellation and bounded-settlement tests**

Add this helper and tests to `page/src/rust_lsp_startup_test.ts`:

```ts
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

Deno.test("abort cancels start, waits for settlement, and preserves its reason", async () => {
  const controller = new AbortController();
  const start = deferred();
  const reason = new Error("component unmounted");
  const order: string[] = [];
  let starts = 0;
  let caught: unknown;
  const startup = runRustLspStartup({
    prepopulateMain: async () => order.push("prepopulate"),
    startClient: () => {
      starts++;
      order.push("start");
      return start.promise.finally(() => order.push("start-settled"));
    },
    cancelClientStart: () => {
      order.push("cancel");
      start.reject(new Error("transport closed"));
    },
    createMainModel: () => order.push("model"),
  }, 1_000, controller.signal, 20);
  await Promise.resolve();
  controller.abort(reason);
  try {
    await startup;
  } catch (error) {
    caught = error;
    order.push("cleanup");
  }
  assert(starts === 1, `startClient called ${starts} times`);
  assert(caught === reason, "abort reason identity was replaced");
  assert(
    order.join(",") === "prepopulate,start,cancel,start-settled,cleanup",
    `wrong cancellation order: ${order}`,
  );
});

Deno.test("timeout cancellation is bounded and observes a late rejection", async () => {
  const start = deferred();
  let cancellations = 0;
  let message = "";
  try {
    await runRustLspStartup({
      prepopulateMain: async () => {},
      startClient: () => start.promise,
      cancelClientStart: () => cancellations++,
      createMainModel: () => {
        throw new Error("model must not be created");
      },
    }, 1, new AbortController().signal, 1);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  start.reject(new Error("late transport rejection"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(cancellations === 1, `cancelled ${cancellations} times`);
  assert(
    message === "rust-analyzer startup timed out",
    `wrong timeout reason: ${message}`,
  );
});
```

Make these exact additions to the three existing `runRustLspStartup` calls. The successful-order call becomes:

```ts
  await runRustLspStartup({
    prepopulateMain: async () => {
      order.push("prepopulate");
    },
    startClient: async () => {
      order.push("start");
    },
    cancelClientStart: () => {},
    createMainModel: () => {
      order.push("model");
    },
  }, 100, new AbortController().signal);
```

The timeout call becomes:

```ts
    await runRustLspStartup({
      prepopulateMain: async () => {},
      startClient: () => new Promise<void>(() => {}),
      cancelClientStart: () => {},
      createMainModel: () => {
        modelCreated = true;
      },
    }, 1, new AbortController().signal, 1);
```

The pre-population failure call becomes:

```ts
    await runRustLspStartup({
      prepopulateMain: async () => {
        throw new Error("VFS write failed");
      },
      startClient: async () => {
        started = true;
      },
      cancelClientStart: () => {},
      createMainModel: () => {},
    }, 100, new AbortController().signal);
```

- [ ] **Step 3: Add failing client wiring and one-close-event contracts**

Append to `page/src/rust_lsp_client_test.ts`:

```ts
Deno.test("browser client wires abort and transport cancellation into startup", async () => {
  const source = await Deno.readTextFile("page/src/rust_lsp_client.ts");
  assert(
    /startRustLspClient\([\s\S]*signal:\s*AbortSignal/.test(source),
    "browser client does not accept AbortSignal",
  );
  assert(
    source.includes("cancelClientStart: () => connection.dispose()"),
    "startup cancellation does not close message transports",
  );
  assert(
    /runRustLspStartup\([\s\S]*300_000,\s*signal\s*\)/.test(source),
    "browser client does not pass AbortSignal to startup",
  );
});
```

Append to `page/src/lsp_bridge_test.ts`:

```ts
test("lsp_bridge: reader disposal emits close exactly once", () => {
  const ctx = { ls_id: "ls-close", input_string_id: "in-close" } as Ctx;
  const connection = createLspConnection(ctx);
  let closes = 0;
  connection.reader.onClose(() => closes++);
  connection.reader.listen(() => {});

  connection.reader.dispose();
  connection.reader.dispose();

  expect(closes).toBe(1);
});
```

- [ ] **Step 4: Run all three cancellation boundaries and verify RED**

Run:

```bash
deno test --no-lock -A page/src/lsp_start_gate_test.ts page/src/rust_lsp_startup_test.ts page/src/rust_lsp_client_test.ts
bun test page/src/lsp_bridge_test.ts
```

Expected: Deno type-checking/tests fail because the signal and cancellation action are absent; Bun fails with `Expected: 1, Received: 0` for the reader close count.

- [ ] **Step 5: Give the gate ownership of one abort controller**

Change `page/src/lsp_start_gate.ts` to retain the late-session check while aborting before awaiting startup:

```ts
export class LspStartGate<TMonaco> {
  private monaco: TMonaco | undefined;
  private vfsResult: VfsReadyResult | undefined;
  private startPromise: Promise<DisposableLspSession> | undefined;
  private session: DisposableLspSession | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly abortController = new AbortController();

  constructor(
    private readonly start: (
      monaco: TMonaco,
      signal: AbortSignal,
    ) => Promise<DisposableLspSession>,
  ) {}

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.abortController.abort(
      new DOMException("LSP startup disposed", "AbortError"),
    );
    this.disposePromise = (async () => {
      let session: DisposableLspSession | undefined;
      try {
        session = await this.startPromise;
      } catch {
        return;
      }
      if (this.session === session) {
        this.session = undefined;
        await session?.dispose();
      }
    })();
    return this.disposePromise;
  }

  private tryStart(): void {
    if (
      this.disposed || this.startPromise || this.vfsResult?.ok !== true ||
      !this.monaco
    ) return;
    this.startPromise = this.start(
      this.monaco,
      this.abortController.signal,
    ).then(async (session) => {
      if (this.disposed) await session.dispose();
      else this.session = session;
      return session;
    });
  }
}
```

Keep the existing `setMonaco`, `setVfsResult`, and `started` methods unchanged.

- [ ] **Step 6: Implement one-call startup with permanent observation and bounded cancellation settlement**

Replace `page/src/rust_lsp_startup.ts` with:

```ts
export type RustLspStartupActions = {
  prepopulateMain(): Promise<void>;
  startClient(): Promise<void>;
  cancelClientStart(): void;
  createMainModel(): void;
};

export async function runRustLspStartup(
  actions: RustLspStartupActions,
  timeoutMs: number,
  signal: AbortSignal,
  cancellationSettleTimeoutMs = 1_000,
): Promise<void> {
  await actions.prepopulateMain();
  signal.throwIfAborted();

  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  const timeoutError = new Error("rust-analyzer startup timed out");
  const startupTimeout = new Promise<never>((_, reject) => {
    startupTimer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  let startPromise: Promise<void> | undefined;
  try {
    startPromise = Promise.resolve().then(() => actions.startClient());
    void startPromise.catch(() => undefined);
    await Promise.race([startPromise, startupTimeout, aborted]);
  } catch (error) {
    const activelyCancelled = error === timeoutError ||
      (signal.aborted && error === signal.reason);
    if (activelyCancelled && startPromise) {
      try {
        actions.cancelClientStart();
      } catch (cleanupError) {
        console.error("Failed to cancel LSP startup:", cleanupError);
      }
      await Promise.race([
        startPromise.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(resolve, cancellationSettleTimeoutMs);
        }),
      ]);
    }
    throw error;
  } finally {
    if (startupTimer !== undefined) clearTimeout(startupTimer);
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    removeAbortListener();
  }

  actions.createMainModel();
}
```

Wrapping `startClient()` in `Promise.resolve().then(...)` converts a synchronous
throw into the retained rejection without bypassing the `finally` cleanup. This
ordering removes timeout/abort listeners before `createMainModel`, and the
detached `catch` remains attached even if the bounded settlement wait expires.

- [ ] **Step 7: Wire the signal and transport cancellation through entry, App, and client**

Change the `App` prop in `page/src/App.tsx`:

```ts
  startLspClient: (
    monaco: typeof import("monaco-editor"),
    signal: AbortSignal,
  ) => Promise<DisposableLspSession>;
```

Observe gate cleanup in `App`:

```ts
    void lspGate.dispose().catch((error) =>
      console.error("LSP gate cleanup failed:", error)
    );
```

Change the injected callback in `page/src/index.tsx`:

```tsx
      startLspClient={async (monaco, signal) => {
        const { startRustLspClient } = await import("./rust_lsp_client");
        return startRustLspClient(ctx, monaco, signal);
      }}
```

Change `page/src/rust_lsp_client.ts`:

```ts
export async function startRustLspClient(
  ctx: Ctx,
  monaco: typeof Monaco,
  signal: AbortSignal,
) {
```

Add the cancellation action and signal to its startup call:

```ts
    await runRustLspStartup({
      prepopulateMain: () =>
        writeAndRecordWorkspace("/src/main.rs", default_value),
      startClient: () => client.start(),
      cancelClientStart: () => connection.dispose(),
      createMainModel: () => {
        const uri = monaco.Uri.parse("file:///src/main.rs");
        if (!monaco.editor.getModel(uri)) {
          monaco.editor.createModel(default_value, "rust", uri);
        }
      },
    }, 300_000, signal);
```

Retain this exact error block after the changed startup call so owner cleanup cannot replace the original startup reason:

```ts
  } catch (error) {
    try {
      await owner.dispose();
    } catch (cleanupError) {
      console.error("Cleanup failed after startup error:", cleanupError);
    }
    throw error;
  }
```

- [ ] **Step 8: Emit one reader close event before emitter destruction**

Change only `MyMessageReader.dispose()` in `page/src/lsp_bridge.ts`:

```ts
  override dispose(): void {
    if (!this.closed) {
      this.closed = true;
      this.fireClose();
      closeUnderlyingChannel(this.shared);
      this.shared = undefined;
    }
    super.dispose();
  }
```

The existing malformed-input path already sets `closed` and fires close, so the guard prevents a second event during owner cleanup.

- [ ] **Step 9: Format only Task 2 TypeScript files**

Run:

```bash
bun x @biomejs/biome@1.9.4 format --write \
  page/src/lsp_start_gate.ts \
  page/src/lsp_start_gate_test.ts \
  page/src/App.tsx \
  page/src/index.tsx \
  page/src/rust_lsp_startup.ts \
  page/src/rust_lsp_startup_test.ts \
  page/src/rust_lsp_client.ts \
  page/src/rust_lsp_client_test.ts \
  page/src/lsp_bridge.ts \
  page/src/lsp_bridge_test.ts
```

Expected: only the ten listed files are formatted.

- [ ] **Step 10: Run focused cancellation verification**

Run:

```bash
deno test --no-lock -A page/src/lsp_start_gate_test.ts page/src/rust_lsp_startup_test.ts page/src/rust_lsp_client_test.ts
bun test page/src/lsp_bridge_test.ts
bun run --cwd page build
```

Expected: all Deno and Bun tests pass; the late rejection test produces no unhandled rejection; the page build type-checks the signal through every layer.

- [ ] **Step 11: Commit Task 2**

```bash
git add page/src/lsp_start_gate.ts page/src/lsp_start_gate_test.ts page/src/App.tsx page/src/index.tsx page/src/rust_lsp_startup.ts page/src/rust_lsp_startup_test.ts page/src/rust_lsp_client.ts page/src/rust_lsp_client_test.ts page/src/lsp_bridge.ts page/src/lsp_bridge_test.ts
git commit -m "fix: bound LSP startup cancellation"
```

### Task 3: Deployment-Revision Rust-Source Cache

**Files:**
- Create: `page/src/rust_src_cache.ts`
- Create: `page/src/rust_src_cache_test.ts`
- Modify: `page/src/sysroot_archive.ts:7-31,51-117`
- Modify: `page/src/sysroot_archive_test.ts:1-53,78-93`
- Modify: `page/vite.config.ts:12-54`
- Modify: `scripts/publish-pages-dist.sh:27-33`
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts:140-164`

**Interfaces:**
- Consumes: cache name `rubrc-assets-v1`; deployment metadata `{ version: 1, sourceSha: string }`; same-origin rust-src archive URL; existing query-sensitive `fetchWithOptionalCache` unchanged.
- Produces: `pruneRustSrcCacheVariants(archiveUrl: string, sourceRevision: string, dependencies: RustSrcCacheDependencies): Promise<void>`; `sysrootArchiveUrl(triple: string, pageUrl?: string, sourceRevision?: string): string`; successful-parse callback `maintainRustSrcCache?: (archiveUrl: string) => void`.

- [ ] **Step 1: Add failing URL and successful-parse contracts**

Replace the URL test's local function type in `page/src/sysroot_archive_test.ts` with this exact block, then use the assertions below:

```ts
  const sysrootArchiveUrl = (
    sysrootArchive as unknown as {
      sysrootArchiveUrl: (
        triple: string,
        pageUrl?: string,
        sourceRevision?: string,
      ) => string;
    }
  ).sysrootArchiveUrl;
```

```ts
  assert(
    sysrootArchiveUrl(
      "rust-src",
      "https://example.test/rubrc/index.html",
      "abc123",
    ) === "https://example.test/rubrc/rust-src.tar.vfsbr?v=abc123",
    "rust-src did not include the running source revision",
  );
  assert(
    sysrootArchiveUrl(
      "wasm32-wasip1",
      "https://example.test/rubrc/index.html",
      "abc123",
    ) === "https://oligamiq.github.io/rust_wasm/v0.2.0/wasm32-wasip1.tar.br",
    "target sysroot URL changed",
  );
```

Append these tests:

```ts
Deno.test("rust-src cache maintenance starts only after a successful parse", async () => {
  const maintained: string[] = [];
  await loadSysrootArchive("rust-src", {
    fetchStream: async () => new ReadableStream<Uint8Array>(),
    parse: async () => {},
    maintainRustSrcCache: (url) => maintained.push(url),
  });
  assert(maintained.length === 1, `maintained ${maintained.length} times`);
});

Deno.test("rust-src parse failure does not prune cache variants", async () => {
  let maintenanceCalls = 0;
  await loadSysrootArchive("rust-src", {
    fetchStream: async () => new ReadableStream<Uint8Array>(),
    parse: async () => {
      throw new Error("partial archive");
    },
    maintainRustSrcCache: () => maintenanceCalls++,
  }).catch(() => undefined);
  assert(maintenanceCalls === 0, "failed parse started cache pruning");
});
```

- [ ] **Step 2: Add failing pure cache-maintenance tests**

Create `page/src/rust_src_cache_test.ts`:

```ts
import { pruneRustSrcCacheVariants } from "./rust_src_cache.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const archiveUrl = "https://example.test/rubrc/rust-src.tar.vfsbr?v=new";

function dependencies(sourceSha: string | Error) {
  const deleted: string[] = [];
  const requests = [
    new Request("https://example.test/rubrc/rust-src.tar.vfsbr"),
    new Request("https://example.test/rubrc/rust-src.tar.vfsbr?v=old"),
    new Request(archiveUrl),
    new Request("https://example.test/rubrc/other.wasm?v=old"),
    new Request("https://other.test/rubrc/rust-src.tar.vfsbr?v=old"),
  ];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    deleted,
    fetchCalls,
    value: {
      cacheStorage: {
        open: async (name: string) => {
          assert(name === "rubrc-assets-v1", `wrong cache: ${name}`);
          return {
            keys: async () => requests,
            delete: async (request: Request) => {
              deleted.push(request.url);
              return true;
            },
          };
        },
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        if (sourceSha instanceof Error) throw sourceSha;
        return new Response(JSON.stringify({ version: 1, sourceSha }), {
          status: 200,
        });
      },
      reportError: (_error: unknown) => {},
    },
  };
}

Deno.test("matching deployment prunes only older same-path variants", async () => {
  const test = dependencies("new");
  await pruneRustSrcCacheVariants(archiveUrl, "new", test.value);
  assert(test.fetchCalls.length === 1, "metadata was not fetched once");
  assert(
    test.fetchCalls[0].url ===
      "https://example.test/rubrc/.rubrc-pages-build.json",
    `wrong metadata URL: ${test.fetchCalls[0].url}`,
  );
  assert(
    test.fetchCalls[0].init?.cache === "no-store",
    "metadata fetch did not bypass the HTTP cache",
  );
  assert(
    test.deleted.join(",") ===
      "https://example.test/rubrc/rust-src.tar.vfsbr,https://example.test/rubrc/rust-src.tar.vfsbr?v=old",
    `wrong cache entries deleted: ${test.deleted}`,
  );
});

Deno.test("stale tabs and metadata failures retain every cache entry", async () => {
  for (const sourceSha of ["newer-deployment", new Error("offline")]) {
    const test = dependencies(sourceSha);
    await pruneRustSrcCacheVariants(archiveUrl, "old", test.value);
    assert(test.deleted.length === 0, "non-current bundle pruned cache entries");
  }
});

Deno.test("bad deployment metadata never prunes cache entries", async () => {
  for (const response of [
    new Response("not-json", { status: 200 }),
    new Response("unavailable", { status: 503 }),
  ]) {
    const test = dependencies("new");
    test.value.fetch = async () => response;
    await pruneRustSrcCacheVariants(archiveUrl, "new", test.value);
    assert(test.deleted.length === 0, "invalid metadata pruned cache entries");
  }
});
```

- [ ] **Step 3: Add failing Vite and publish source contracts**

Append to `scripts/lsp_browser_diagnostics_contract_test.ts`:

```ts
Deno.test("Pages build injects its validated source SHA", async () => {
  const vite = await Deno.readTextFile("page/vite.config.ts");
  const publish = await Deno.readTextFile("scripts/publish-pages-dist.sh");
  assert(
    vite.includes('process.env.SOURCE_SHA ?? "development"'),
    "Vite source revision lacks the explicit development fallback",
  );
  assert(
    publish.includes('SOURCE_SHA="$SOURCE_SHA" bun run build:prod'),
    "Pages publisher does not pass its validated SHA into build:prod",
  );
});
```

- [ ] **Step 4: Run cache and publishing tests and verify RED**

Run:

```bash
deno test --no-lock -A page/src/sysroot_archive_test.ts page/src/rust_src_cache_test.ts scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: FAIL because `rust_src_cache.ts` and the revisioned URL/define/publish contracts do not exist.

- [ ] **Step 5: Implement metadata-gated same-path pruning in a pure seam**

Create `page/src/rust_src_cache.ts`:

```ts
type FetchInput = string | URL | Request;

type RustSrcCache = {
  keys(): Promise<readonly Request[]>;
  delete(request: Request): Promise<boolean>;
};

export type RustSrcCacheDependencies = {
  cacheStorage?: { open(name: string): Promise<RustSrcCache> };
  fetch(input: FetchInput, init?: RequestInit): Promise<Response>;
  reportError(error: unknown): void;
};

export async function pruneRustSrcCacheVariants(
  archiveUrl: string,
  sourceRevision: string,
  dependencies: RustSrcCacheDependencies,
): Promise<void> {
  if (!dependencies.cacheStorage) return;
  try {
    const current = new URL(
      archiveUrl,
      typeof location === "undefined"
        ? "https://development.invalid/"
        : location.href,
    );
    const metadataUrl = new URL(".rubrc-pages-build.json", current);
    const response = await dependencies.fetch(metadataUrl, { cache: "no-store" });
    if (!response.ok) return;
    const metadata: unknown = await response.json();
    if (
      typeof metadata !== "object" || metadata === null ||
      !("sourceSha" in metadata) || metadata.sourceSha !== sourceRevision
    ) return;

    const cache = await dependencies.cacheStorage.open("rubrc-assets-v1");
    for (const request of await cache.keys()) {
      const candidate = new URL(request.url);
      if (
        candidate.origin === current.origin &&
        candidate.pathname === current.pathname &&
        candidate.href !== current.href
      ) {
        await cache.delete(request);
      }
    }
  } catch (error) {
    dependencies.reportError(error);
  }
}
```

This intentionally does not import or modify `lib/src/fetch_with_optional_cache.ts`.

- [ ] **Step 6: Revision the rust-src URL and invoke maintenance after parse success**

Add the import, source constant, option, and URL parameter in `page/src/sysroot_archive.ts`:

```ts
import { pruneRustSrcCacheVariants } from "./rust_src_cache.ts";

declare const __RUBRC_SOURCE_REVISION__: string;
const SOURCE_REVISION = typeof __RUBRC_SOURCE_REVISION__ === "undefined"
  ? "development"
  : __RUBRC_SOURCE_REVISION__;

type ArchiveOptions = {
  timeoutMs?: number;
  fetchStream?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>;
  parse?: (
    stream: ReadableStream<Uint8Array>,
    visit: (file: ArchiveFile) => void,
  ) => Promise<void>;
  maintainRustSrcCache?: (archiveUrl: string) => void;
};

export function sysrootArchiveUrl(
  triple: string,
  pageUrl = typeof location === "undefined" ? undefined : location.href,
  sourceRevision = SOURCE_REVISION,
): string {
  if (triple !== "rust-src") return `${BASE_URL}/${triple}.tar.br`;
  const url = pageUrl === undefined
    ? new URL(`./${RUST_SRC_ASSET}`, "https://development.invalid/")
    : new URL(RUST_SRC_ASSET, pageUrl);
  url.searchParams.set("v", sourceRevision);
  return pageUrl === undefined ? `./${RUST_SRC_ASSET}${url.search}` : url.href;
}
```

Resolve the URL once before fetching, then start maintenance only after `parse` and the final deadline check succeed:

```ts
    const archiveUrl = sysrootArchiveUrl(triple);
    const stream = await fetchStream(archiveUrl, controller.signal);
```

```ts
    checkDeadline();
    if (triple === "rust-src") {
      const maintainRustSrcCache = options.maintainRustSrcCache ?? ((url) => {
        void pruneRustSrcCacheVariants(url, SOURCE_REVISION, {
          cacheStorage: "caches" in globalThis ? caches : undefined,
          fetch: (input, init) => fetch(input, init),
          reportError: (error) =>
            console.warn("Failed to maintain rust-src cache", error),
        });
      });
      maintainRustSrcCache(archiveUrl);
    }
    return entries;
```

- [ ] **Step 7: Inject the revision and pass the validated publishing SHA**

Add this property to the top level of `defineConfig` in `page/vite.config.ts`:

```ts
  define: {
    __RUBRC_SOURCE_REVISION__: JSON.stringify(
      process.env.SOURCE_SHA ?? "development",
    ),
  },
```

Change only the production build line in `scripts/publish-pages-dist.sh`:

```bash
SOURCE_SHA="$SOURCE_SHA" bun run build:prod
```

- [ ] **Step 8: Format only Task 3 TypeScript files**

Run:

```bash
bun x @biomejs/biome@1.9.4 format --write \
  page/src/rust_src_cache.ts \
  page/src/rust_src_cache_test.ts \
  page/src/sysroot_archive.ts \
  page/src/sysroot_archive_test.ts \
  page/vite.config.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: only the six listed files are formatted; the shell script remains byte-for-byte except for its build line.

- [ ] **Step 9: Run focused cache verification and a revisioned page build**

Run:

```bash
deno test --no-lock -A page/src/sysroot_archive_test.ts page/src/rust_src_cache_test.ts scripts/lsp_browser_diagnostics_contract_test.ts lib/src/fetch_with_optional_cache_test.ts
SOURCE_SHA=0123456789abcdef bun run --cwd page build
```

Expected: all tests pass, including unchanged generic cache-first tests; the page build succeeds with the injected revision.

- [ ] **Step 10: Commit Task 3**

```bash
git add page/src/rust_src_cache.ts page/src/rust_src_cache_test.ts page/src/sysroot_archive.ts page/src/sysroot_archive_test.ts page/vite.config.ts scripts/publish-pages-dist.sh scripts/lsp_browser_diagnostics_contract_test.ts
git commit -m "fix: revision rust-src deployment cache"
```

### Task 4: Rust-Source Readiness Outer Deadline

**Files:**
- Modify: `page/src/vfs_readiness.ts:1-39`
- Modify: `page/src/vfs_readiness_test.ts:10-45`
- Modify: `page/src/worker_process/util_cmd.ts:473`
- Modify: `scripts/vfs_lsp_diagnostics_worker.ts:13,113-115`

**Interfaces:**
- Consumes: `VfsReadyResult = { ok: true } | { ok: false; error: string }`; guest states `0 = NotStarted`, `1 = Loading`, `2 = Ready`, `3 = Failed`.
- Produces: `RUST_SRC_BOOTSTRAP_TIMEOUT_MS = 75_000`; `RustSrcBootstrapTiming = { timeoutMs?: number; now?: () => number; sleep?: () => Promise<void> }`; `waitForRustSrcBootstrap(root, timing?): Promise<VfsReadyResult>`.

- [ ] **Step 1: Convert existing tests to the timing object**

Replace each existing second callback argument in `page/src/vfs_readiness_test.ts` with:

```ts
  }, { sleep: async () => {} });
```

This makes the new interface explicit before adding deadline behavior.

- [ ] **Step 2: Add the persistent-Loading failing test**

Append to `page/src/vfs_readiness_test.ts`:

```ts
Deno.test("rust-src bootstrap Loading state times out once", async () => {
  let now = 0;
  let dispatches = 0;
  let reads = 0;
  let state = 1;
  const result = await waitForRustSrcBootstrap({
    dispatch() {
      dispatches++;
    },
    rustSrcLoadState() {
      reads++;
      return state;
    },
  }, {
    timeoutMs: 100,
    now: () => now,
    sleep: async () => {
      now += 25;
    },
  });
  assert(
    !result.ok && result.error ===
      "rust-src bootstrap timed out after 100ms while guest state remained Loading",
    `wrong timeout result: ${JSON.stringify(result)}`,
  );
  const readsAtSettlement = reads;
  state = 2;
  await Promise.resolve();
  assert(dispatches === 1, `bootstrap dispatched ${dispatches} times`);
  assert(reads === readsAtSettlement, "waiter polled after timeout settlement");
});
```

- [ ] **Step 3: Run the readiness test and verify RED**

Run: `deno test --no-lock -A page/src/vfs_readiness_test.ts`

Expected: FAIL during type-checking because the existing second parameter is a function and no outer timeout exists.

- [ ] **Step 4: Implement the injected clock and one-shot timeout result**

Replace `page/src/vfs_readiness.ts` with:

```ts
export type VfsReadyResult = { ok: true } | { ok: false; error: string };

type BootstrapRoot = {
  dispatch(
    sessionId: number,
    eventType: number,
    arg1: number,
    arg2: number,
  ): void;
  rustSrcLoadState(): number;
};

export type RustSrcBootstrapTiming = {
  timeoutMs?: number;
  now?: () => number;
  sleep?: () => Promise<void>;
};

const BOOTSTRAP_EVENT = 8;
export const RUST_SRC_BOOTSTRAP_TIMEOUT_MS = 75_000;

export async function waitForRustSrcBootstrap(
  root: BootstrapRoot,
  timing: RustSrcBootstrapTiming = {},
): Promise<VfsReadyResult> {
  const timeoutMs = timing.timeoutMs ?? RUST_SRC_BOOTSTRAP_TIMEOUT_MS;
  const now = timing.now ?? performance.now.bind(performance);
  const sleep = timing.sleep ?? (() =>
    new Promise<void>((resolve) => setTimeout(resolve, 50)));
  const deadline = now() + timeoutMs;
  root.dispatch(0, BOOTSTRAP_EVENT, 0, 0);
  while (true) {
    const state = root.rustSrcLoadState();
    if (state === 2) return { ok: true };
    if (state === 3) {
      return {
        ok: false,
        error:
          "rust-src bootstrap failed: missing /sysroot/lib/rustlib/src/rust/library/core/src/lib.rs",
      };
    }
    if (state !== 0 && state !== 1) {
      return {
        ok: false,
        error: `rust-src bootstrap returned invalid state ${state}`,
      };
    }
    if (now() >= deadline) {
      const stateName = state === 0 ? "NotStarted" : "Loading";
      return {
        ok: false,
        error:
          `rust-src bootstrap timed out after ${timeoutMs}ms while guest state remained ${stateName}`,
      };
    }
    await sleep();
  }
}
```

- [ ] **Step 5: Update both real call sites to the timing interface**

Replace the readiness import in `page/src/worker_process/util_cmd.ts` and change its call to the blocks below:

```ts
import {
  RUST_SRC_BOOTSTRAP_TIMEOUT_MS,
  type VfsReadyResult,
  waitForRustSrcBootstrap,
} from "../vfs_readiness.ts";
```

```ts
  const rustSrcResult = await waitForRustSrcBootstrap(vfs_root, {
    timeoutMs: RUST_SRC_BOOTSTRAP_TIMEOUT_MS,
  });
```

Replace the readiness import in `scripts/vfs_lsp_diagnostics_worker.ts` and change its call to the blocks below:

```ts
import {
  RUST_SRC_BOOTSTRAP_TIMEOUT_MS,
  waitForRustSrcBootstrap,
} from "../page/src/vfs_readiness.ts";
```

```ts
    const rustSrcResult = await waitForRustSrcBootstrap(root, {
      timeoutMs: RUST_SRC_BOOTSTRAP_TIMEOUT_MS,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });
```

- [ ] **Step 6: Format only Task 4 TypeScript files**

Run:

```bash
bun x @biomejs/biome@1.9.4 format --write \
  page/src/vfs_readiness.ts \
  page/src/vfs_readiness_test.ts \
  page/src/worker_process/util_cmd.ts \
  scripts/vfs_lsp_diagnostics_worker.ts
```

Expected: only the four listed files are formatted.

- [ ] **Step 7: Run focused deadline and call-site verification**

Run:

```bash
deno test --no-lock -A page/src/vfs_readiness_test.ts
bun run --cwd page build
```

Expected: readiness tests pass with one dispatch and one timeout result; the page build type-checks the production call site and preserves the existing degraded UI path.

- [ ] **Step 8: Commit Task 4**

```bash
git add page/src/vfs_readiness.ts page/src/vfs_readiness_test.ts page/src/worker_process/util_cmd.ts scripts/vfs_lsp_diagnostics_worker.ts
git commit -m "fix: bound rust-src bootstrap readiness"
```

### Task 5: 512 KiB Exact-Length Sysroot Transport

**Files:**
- Modify: `page/src/sysroot_protocol.ts:1-14`
- Modify: `page/src/sysroot_protocol_test.ts:1-14`
- Modify: `page/src/xterm.tsx:1-15,454-463`
- Modify: `scripts/vfs_lsp_diagnostics_test.ts:1-10,86-104,166-178,224-231`
- Modify: `crates/vfs-shell/src/main.rs:330-417`

**Interfaces:**
- Consumes: the existing custom `sysrootReadFileChunk` request `{ chunk_len?: unknown }` and exact guest-side whole-file assembly loop.
- Produces: `MAX_SYSROOT_CHUNK_LENGTH = 512 * 1024`; `validateSysrootChunkLength(value: unknown): number`; `takeExactSysrootChunk(data: Uint8Array, requestedLength: unknown): { chunk: Uint8Array; remaining: Uint8Array }`; guest constant `SYSROOT_FILE_CHUNK_SIZE: usize = 512 * 1024`.

- [ ] **Step 1: Add failing host protocol tests for valid, invalid, oversized, and short reads**

Replace `page/src/sysroot_protocol_test.ts` with:

```ts
import {
  MAX_SYSROOT_CHUNK_LENGTH,
  sysrootMetaStatus,
  takeExactSysrootChunk,
  validateSysrootChunkLength,
} from "./sysroot_protocol.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
};

const assertThrows = (fn: () => unknown, expected: string) => {
  let message = "";
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes(expected)) {
    throw new Error(`expected error containing ${expected}, got ${message}`);
  }
};

Deno.test("sysroot meta protocol preserves host failure status", () => {
  assertEquals(sysrootMetaStatus(undefined), 0);
  assertEquals(sysrootMetaStatus({ has_file: false }), 0);
  assertEquals(sysrootMetaStatus({ has_file: true }), 1);
  assertEquals(sysrootMetaStatus({ has_file: -1 }), -1);
});

Deno.test("sysroot chunk protocol accepts only positive lengths through 512 KiB", () => {
  assertEquals(validateSysrootChunkLength(1), 1);
  assertEquals(
    validateSysrootChunkLength(MAX_SYSROOT_CHUNK_LENGTH),
    512 * 1024,
  );
  for (const invalid of [0, -1, 1.5, Number.NaN, "1", 512 * 1024 + 1]) {
    assertThrows(() => validateSysrootChunkLength(invalid), "sysroot chunk length");
  }
});

Deno.test("sysroot chunk protocol never silently truncates", () => {
  const result = takeExactSysrootChunk(new Uint8Array([1, 2, 3]), 2);
  assertEquals(Array.from(result.chunk).join(","), "1,2");
  assertEquals(Array.from(result.remaining).join(","), "3");
  assertThrows(
    () => takeExactSysrootChunk(new Uint8Array([1]), 2),
    "requested 2 bytes with only 1 available",
  );
});
```

- [ ] **Step 2: Run the protocol tests and verify RED**

Run: `deno test --no-lock -A page/src/sysroot_protocol_test.ts`

Expected: FAIL during module loading because `MAX_SYSROOT_CHUNK_LENGTH`, `validateSysrootChunkLength`, and `takeExactSysrootChunk` are not exported.

- [ ] **Step 3: Implement the exact host protocol seam**

Append to `page/src/sysroot_protocol.ts`:

```ts
export const MAX_SYSROOT_CHUNK_LENGTH = 512 * 1024;

export function validateSysrootChunkLength(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 ||
    value > MAX_SYSROOT_CHUNK_LENGTH
  ) {
    throw new Error(
      `invalid sysroot chunk length ${String(value)}; expected 1..${MAX_SYSROOT_CHUNK_LENGTH}`,
    );
  }
  return value;
}

export function takeExactSysrootChunk(
  data: Uint8Array,
  requestedLength: unknown,
): { chunk: Uint8Array; remaining: Uint8Array } {
  const length = validateSysrootChunkLength(requestedLength);
  if (data.length < length) {
    throw new Error(
      `sysroot chunk requested ${length} bytes with only ${data.length} available`,
    );
  }
  return {
    chunk: data.subarray(0, length),
    remaining: data.subarray(length),
  };
}
```

- [ ] **Step 4: Use exact extraction at the browser host boundary**

Import `takeExactSysrootChunk` in `page/src/xterm.tsx`, then replace the chunk branch with:

```ts
      } else if (unknown.name === "sysrootReadFileChunk") {
        if (!current_sysroot_file) {
          throw new Error("No current sysroot file to read data from");
        }
        const { chunk, remaining } = takeExactSysrootChunk(
          current_sysroot_file.data,
          unknown.args.chunk_len,
        );
        current_sysroot_file.data = remaining;
        return { chunk: Array.from(chunk) };
```

- [ ] **Step 5: Instrument the full-VFS host and make the old 50 MiB guest fail**

Import the shared constant and validator in `scripts/vfs_lsp_diagnostics_test.ts`:

```ts
import {
  MAX_SYSROOT_CHUNK_LENGTH,
  validateSysrootChunkLength,
} from "../page/src/sysroot_protocol.ts";
```

Add `let maxSysrootChunkLength = 0;` beside `currentSysrootFile`, then replace the harness chunk branch with:

```ts
      if (name === "sysrootReadFileChunk") {
        const requested = unknown.args?.chunk_len;
        if (typeof requested === "number") {
          maxSysrootChunkLength = Math.max(maxSysrootChunkLength, requested);
        }
        const chunkLength = validateSysrootChunkLength(requested);
        if (!currentSysrootFile) {
          throw new Error("No current sysroot file to read data from");
        }
        const start = currentSysrootFile.offset;
        const end = start + chunkLength;
        if (end > currentSysrootFile.entry.data.length) {
          throw new Error(
            `sysroot chunk requested ${chunkLength} bytes with only ${currentSysrootFile.entry.data.length - start} available`,
          );
        }
        const chunk = currentSysrootFile.entry.data.slice(start, end);
        currentSysrootFile.offset = end;
        return { chunk: Array.from(chunk) };
      }
```

Add this final assertion before the existing `if (!result.ok) Deno.exit(1)`:

```ts
console.log(`maximum sysroot chunk request: ${maxSysrootChunkLength}`);
if (
  maxSysrootChunkLength <= 0 ||
  maxSysrootChunkLength > MAX_SYSROOT_CHUNK_LENGTH
) {
  throw new Error(
    `maximum sysroot chunk request ${maxSysrootChunkLength} is outside 1..${MAX_SYSROOT_CHUNK_LENGTH}`,
  );
}
```

Run against the currently built old guest before changing Rust:

Run: `deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts`

Expected: FAIL at the host boundary with `invalid sysroot chunk length 52428800; expected 1..524288`, proving the harness catches the old 50 MiB request instead of truncating it.

- [ ] **Step 6: Reduce the guest request constant to 512 KiB**

Add the module-level constant immediately after the `unsafe extern "C"` block that ends with `vfs_set_current_session_id` in `crates/vfs-shell/src/main.rs`:

```rust
const SYSROOT_FILE_CHUNK_SIZE: usize = 512 * 1024;
```

Delete the exact local declaration `let chunk_size = 50 * 1024 * 1024;`, then replace the `to_read` line with:

```rust
                        let to_read =
                            std::cmp::min(remaining, SYSROOT_FILE_CHUNK_SIZE);
```

Keep the existing `sysroot_read_file_chunk` call, `offset`/`remaining` updates, progress reporting, and whole-file assembly unchanged.

- [ ] **Step 7: Format targeted sources and run Rust regressions**

Run:

```bash
bun x @biomejs/biome@1.9.4 format --write \
  page/src/sysroot_protocol.ts \
  page/src/sysroot_protocol_test.ts \
  page/src/xterm.tsx \
  scripts/vfs_lsp_diagnostics_test.ts
rustfmt crates/vfs-shell/src/main.rs
deno test --no-lock -A page/src/sysroot_protocol_test.ts
cargo test -p vfs
cargo test -p vfs-shell
```

Expected: protocol tests pass, all `vfs` Rust tests pass, and `vfs-shell`
compiles and passes its tests; only the five named source files are formatted.

- [ ] **Step 8: Rebuild VFS and validate both Wasm artifacts**

Run:

```bash
bun run vfs:build
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
```

Expected: the VFS build succeeds and both `wasm-tools validate` commands exit zero.

- [ ] **Step 9: Gate the exact 14 required core exports**

Run:

```bash
deno eval 'const bytes=await Deno.readFile("page/src/worker_process/vfs_bindings/vfs.core.wasm"); const module=await WebAssembly.compile(bytes); const required=["memory","flush-to-vfs","flush-from-vfs","rust-src-load-state","dispatch","alloc-buf","free-buf","debug-set-terminal-capture","debug-terminal-output-len","debug-read-terminal-output","debug-capture-wait-snapshot","init","main","wasip1-vfs:host/virtual-file-system-wasip1-threads-export#wasi-thread-start"]; if(required.length!==14) throw new Error(`required export list has ${required.length} entries`); const names=new Set(WebAssembly.Module.exports(module).map(({name})=>name)); const missing=required.filter((name)=>!names.has(name)); if(missing.length) throw new Error(`missing VFS exports: ${missing.join(",")}`); console.log("all 14 required VFS exports are present");'
```

Expected: prints `all 14 required VFS exports are present`.

- [ ] **Step 10: Run full-VFS and exact browser regressions**

Run:

```bash
deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts
bun run --cwd page build
bun run test:lsp-browser
```

Expected: full VFS prints `maximum sysroot chunk request: 524288` and `rust-analyzer published and cleared diagnostics`; browser acceptance again requires one editable named Rust model and publishes then clears the exact semantic `i32`/`str` rust-analyzer marker.

- [ ] **Step 11: Commit Task 5 without generated artifacts**

The build may rewrite generated bindings or Wasm. Restore none of the user's unrelated changes, and stage only the five source/test files listed here:

```bash
git add page/src/sysroot_protocol.ts page/src/sysroot_protocol_test.ts page/src/xterm.tsx scripts/vfs_lsp_diagnostics_test.ts crates/vfs-shell/src/main.rs
git commit -m "fix: cap sysroot transport chunks"
```

## Final Verification

- [ ] Run the complete focused suite from the worktree root:

```bash
deno test --no-lock -A \
  page/src/lsp_start_gate_test.ts \
  page/src/rust_lsp_startup_test.ts \
  page/src/rust_lsp_client_test.ts \
  page/src/sysroot_archive_test.ts \
  page/src/rust_src_cache_test.ts \
  page/src/vfs_readiness_test.ts \
  page/src/sysroot_protocol_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts \
  lib/src/fetch_with_optional_cache_test.ts
bun test page/src/lsp_bridge_test.ts
cargo test -p vfs
cargo test -p vfs-shell
```

Expected: every Deno, Bun, and Rust test passes with no unhandled rejection report.

- [ ] Rebuild and rerun integration gates from fresh artifacts:

```bash
bun run vfs:build
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts
bun run test:lsp-browser
deno test --no-lock -A scripts/rust_analyzer_minimal/smoke_test.ts
```

Expected: both semantic paths publish and clear diagnostics, browser handoff remains exact, the direct minimal control still passes, and the Wasm gate reports all 14 required exports.

- [ ] Check formatting scope, whitespace, commits, and generated-file staging:

```bash
git diff --check HEAD~5..HEAD
git status --short
git log --oneline -5
```

Expected: no whitespace errors; exactly five task commits are present; no generated Wasm/binding changes or unrelated files are staged.

The external rust-analyzer source fixture mismatch in the boundary-trace contract remains a known baseline limitation, not a blocker for these changes. A clean layered experiment is absent from this worktree; use the already validated read-only reference worktree as the layered control when available, and record that external result separately rather than changing this implementation.

## Review Fix: Guest-Owned Sysroot Chunk Size (2026-08-10)

This addendum supersedes only Task 5's 512 KiB cap. The original steps remain
above as implementation history.

**Goal:** Restore browser startup within the existing 75-second readiness
budget while preserving exact host reads and one configurable guest batching
parameter.

**Architecture:** Rust owns `SYSROOT_FILE_CHUNK_SIZE`, defaulting to
`50 * 1024 * 1024`, and the whole-file loop refers only to that constant. The
TypeScript host validates positive safe integers and available bytes without a
second maximum. Full-VFS records the observed maximum without enforcing it.

**Files:**

- Modify: `page/src/sysroot_protocol_test.ts`
- Modify: `page/src/sysroot_protocol.ts`
- Modify: `scripts/vfs_lsp_diagnostics_test.ts`
- Modify: `crates/vfs-shell/src/main.rs`
- Modify: `docs/superpowers/specs/2026-08-09-browser-diagnostics-final-hardening-design.md`
- Modify: `docs/superpowers/plans/2026-08-09-browser-diagnostics-final-hardening.md`
- Append: worktree report `sdd/hardening-task-5-report.md` outside the commit

- [ ] **Step 1: Write host and Rust source-contract tests**

Remove `MAX_SYSROOT_CHUNK_LENGTH` from the protocol test import. Require
`validateSysrootChunkLength(50 * 1024 * 1024)` and
`validateSysrootChunkLength(Number.MAX_SAFE_INTEGER)` to succeed; reject zero,
negative, fractional, non-number, non-finite, and unsafe-integer inputs. Keep
the excess-available test and assert both returned subarrays share the source
buffer. Read `crates/vfs-shell/src/main.rs` and require:

```text
const SYSROOT_FILE_CHUNK_SIZE: usize = 50 * 1024 * 1024;
std::cmp::min(remaining, SYSROOT_FILE_CHUNK_SIZE)
```

Also require exactly two occurrences of `SYSROOT_FILE_CHUNK_SIZE`, no local
`let chunk_size`, and no `512 * 1024` literal.

- [ ] **Step 2: Verify RED**

Run: `deno test --no-lock -A page/src/sysroot_protocol_test.ts`

Expected: FAIL because the TypeScript validator rejects 50 MiB and the Rust
constant still defaults to 512 KiB.

- [ ] **Step 3: Implement the minimal review fix**

Delete the TypeScript maximum export and maximum comparison. Keep only the
positive-safe-integer validator and exact `subarray` extraction. Set:

```rust
const SYSROOT_FILE_CHUNK_SIZE: usize = 50 * 1024 * 1024;
```

Keep the loop expression as:

```rust
let to_read = std::cmp::min(remaining, SYSROOT_FILE_CHUNK_SIZE);
```

Remove the full-VFS maximum import and final cap assertion, retaining the
existing maximum-request console output.

- [ ] **Step 4: Verify GREEN and focused regressions**

Run the protocol test, focused Deno/Bun suite, `cargo test -p vfs`, and
`cargo test -p vfs-shell`. Record any failure that reproduces at the parent
commit as a baseline rather than expanding this review fix.

- [ ] **Step 5: Rebuild and run integration gates**

Run `bun run vfs:build`, validate both Wasm artifacts, check the 14 required
exports, run full-VFS diagnostics, build the page, and run
`bun run test:lsp-browser` without changing the 75-second readiness timeout.

Expected: full-VFS reports its observed maximum without a 524288 assertion,
and the browser publishes then clears the exact rust-analyzer markers.

- [ ] **Step 6: Review, commit, and report**

Stage only the four code/test files and these two documentation files. Do not
stage generated Wasm, bindings, lockfiles, or unrelated untracked files. Commit
with `fix: restore configurable sysroot chunks`, then append the results and
commit hash to the existing worktree Task 5 report.

## Review Fix: Bounded 300-Second Rust-Source Readiness (2026-08-10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Raise only the production rust-src bootstrap readiness deadline from
75 seconds to a bounded 300 seconds.

**Architecture:** `page/src/vfs_readiness.ts` continues to own and export the
single readiness constant. Existing worker and full-VFS callers consume that
constant unchanged; the browser acceptance harness already has a matching
300-second outer startup budget.

**Tech Stack:** TypeScript, Deno tests, Bun/Vite browser acceptance, Rust/Wasm
full-VFS integration.

### Global Constraints

- Keep `SYSROOT_FILE_CHUNK_SIZE: usize = 50 * 1024 * 1024` unchanged.
- Do not introduce a TypeScript sysroot chunk cap.
- Keep exact zero-copy `Uint8Array.subarray` host extraction.
- Set only `RUST_SRC_BOOTSTRAP_TIMEOUT_MS` to `300_000`.
- Do not stage generated Wasm, bindings, lockfiles, reports, or unrelated files.

### Task 1: Raise the Bounded Readiness Deadline

**Files:**

- Modify: `page/src/vfs_readiness_test.ts`
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts`
- Modify: `page/src/vfs_readiness.ts`
- Modify: `docs/superpowers/specs/2026-08-09-browser-diagnostics-final-hardening-design.md`
- Modify: `docs/superpowers/plans/2026-08-09-browser-diagnostics-final-hardening.md`
- Append after commit: worktree report `sdd/hardening-task-5-report.md`

**Interfaces:**

- Consumes: `RUST_SRC_BOOTSTRAP_TIMEOUT_MS` from `page/src/vfs_readiness.ts`.
- Produces: the same exported number constant with value `300_000`.

- [ ] **Step 1: Write failing readiness and source-contract tests**

Import `RUST_SRC_BOOTSTRAP_TIMEOUT_MS` in `page/src/vfs_readiness_test.ts` and
assert that it equals `300_000`. Extend the browser startup budget contract to
read `page/src/vfs_readiness.ts` and require the exact exported declaration
`RUST_SRC_BOOTSTRAP_TIMEOUT_MS = 300_000`.

- [ ] **Step 2: Verify RED**

Run:

```bash
deno test --no-lock -A page/src/vfs_readiness_test.ts scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: both new assertions fail against the committed `75_000` value.

- [ ] **Step 3: Implement the minimal production change**

Set:

```typescript
export const RUST_SRC_BOOTSTRAP_TIMEOUT_MS = 300_000;
```

Do not change any chunk-size or host-protocol code.

- [ ] **Step 4: Verify GREEN and focused protocol constraints**

Run:

```bash
deno test --no-lock -A page/src/vfs_readiness_test.ts scripts/lsp_browser_diagnostics_contract_test.ts page/src/sysroot_protocol_test.ts
```

Expected: all readiness, browser contract, and uncapped exact-protocol tests
pass.

- [ ] **Step 5: Format, verify scope, and commit**

Run:

```bash
bunx @biomejs/biome@1.9.4 format page/src/vfs_readiness.ts page/src/vfs_readiness_test.ts scripts/lsp_browser_diagnostics_contract_test.ts
git diff --check
git diff -- crates/vfs-shell/src/main.rs page/src/sysroot_protocol.ts
git status --short
git add page/src/vfs_readiness.ts page/src/vfs_readiness_test.ts scripts/lsp_browser_diagnostics_contract_test.ts docs/superpowers/specs/2026-08-09-browser-diagnostics-final-hardening-design.md docs/superpowers/plans/2026-08-09-browser-diagnostics-final-hardening.md
git commit -m "fix: extend rust-src readiness budget"
```

Expected: formatting and whitespace checks pass; the Rust chunk constant and
TypeScript exact-read protocol have no diff; only the five approved paths enter
the commit.

- [ ] **Step 6: Run committed-code acceptance and append the report**

Run from the new commit:

```bash
bun run test:lsp-browser
deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts
git status --short
```

The browser command builds the page before launching acceptance. Expected: the
browser and full-VFS paths publish then clear exact rust-analyzer diagnostics,
and full-VFS retains the uncapped observed maximum. Append RED/GREEN evidence,
acceptance results, commit hash, and remaining concerns to the existing
worktree Task 5 report outside the commit.
