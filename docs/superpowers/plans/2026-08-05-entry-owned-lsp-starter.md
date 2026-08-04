# Entry-Owned Rust LSP Starter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the VS Code extension API and `MonacoLanguageClient` in one
entry-owned module graph so browser rust-analyzer startup reaches semantic
Monaco diagnostics.

**Architecture:** `index.tsx` owns the runtime import of `startRustLspClient`
and injects a typed starter callback into lazy `App`. `App` retains the existing
Monaco/VFS `LspStartGate`, but no longer imports the language client itself.
Static evaluation is safe because constructing `MonacoLanguageClient` and
accessing guarded `vscode` APIs occur only when the starter is called. The
browser acceptance harness asserts that the built asset graph contains one
VS Code default-API singleton asset before launching Chromium.

**Tech Stack:** TypeScript, Solid, Vite, `monaco-languageclient`, Deno tests,
Puppeteer.

## Global Constraints

- `MonacoVscodeApiWrapper.start()` must finish before `App` is imported and
  rendered.
- Preserve editor-before-LSP gate satisfaction, VFS-before-`client.start()`,
  and post-start `/src/main.rs` model creation.
- Keep `MonacoLanguageClient` as the sole Monaco marker owner; do not call
  `monaco.editor.setModelMarkers`.
- Do not add a fallback language server, custom Atomics synchronization, Vite
  chunk configuration, or a lazy-chunk `vscode/localExtensionHost` import.
- Do not modify generated Wasm, lockfiles, VFS source/bindings, minimal/layered
  experiments, or unrelated dirty paths.
- The browser acceptance must observe a semantic `source: "rust-analyzer"`
  marker and its removal after a valid edit.

---

### Task 1: Inject The Entry-Owned LSP Starter

**Files:**
- Modify: `page/src/index.tsx:5-8, 69-79`
- Modify: `page/src/App.tsx:1-14, 34-40`
- Modify: `page/src/lsp_start_gate_test.ts:74-118`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs:1-20` and its post-build,
  pre-browser-launch setup

**Interfaces:**
- Consumes: `startRustLspClient(ctx, monaco)` from
  `page/src/rust_lsp_client.ts`, which returns a promise compatible with
  `DisposableLspSession`.
- Consumes: `LspStartGate<TMonaco>` from `page/src/lsp_start_gate.ts`.
- Produces: an App prop
  `startLspClient(monaco: typeof import("monaco-editor")): Promise<DisposableLspSession>`
  and one built-asset copy of the VS Code default-API singleton error literal.

- [ ] **Step 1: Add the failing source-contract regression test**

  In the existing `App mounts the editor before LSP startup but defers the main
  model` test, retain its existing `source` read for `App.tsx`, then read
  `page/src/index.tsx` and assert:

  ```ts
  const indexSource = await Deno.readTextFile("page/src/index.tsx");
  const rustLspImport =
    /import\s*\{\s*startRustLspClient\s*\}\s*from\s*["']\.\/rust_lsp_client(?:\.(?:ts|js))?["']/;

  assert(
    rustLspImport.test(indexSource),
    "index.tsx must statically import startRustLspClient",
  );
  assert(
    /startLspClient=\{\s*\(\s*monaco\s*\)\s*=>\s*startRustLspClient\(\s*ctx\s*,\s*monaco\s*\)\s*\}/s.test(
      indexSource,
    ),
    "index.tsx must inject the entry-owned LSP starter",
  );
  assert(
    !rustLspImport.test(source),
    "App must not own a runtime rust_lsp_client import",
  );
  assert(
    /startLspClient:\s*\(\s*monaco:\s*typeof import\(["']monaco-editor["']\),?\s*\)\s*=>\s*Promise<DisposableLspSession>/s.test(
      source,
    ),
    "App must accept the typed injected LSP starter",
  );
  assert(
    /new LspStartGate<typeof import\(["']monaco-editor["']\)>\(\s*props\.startLspClient,?\s*\)/s.test(
      source,
    ),
    "App must give the injected starter to LspStartGate",
  );
  ```

- [ ] **Step 2: Run the source-contract test and verify RED**

  Run:

  ```bash
  deno test --no-lock --allow-read page/src/lsp_start_gate_test.ts
  ```

  Expected: FAIL because `index.tsx` does not yet statically import and inject
  `startRustLspClient`, and `App.tsx` still imports it directly.

- [ ] **Step 3: Add the failing built-asset singleton regression check**

  In `scripts/lsp_browser_diagnostics_test.mjs`, add this import; do not spawn
  `grep` or a shell:

  ```js
  import { readdir, readFile } from "node:fs/promises";
  ```

  Add this helper near the other top-level helpers:

  ```js
  const DEFAULT_API_NOT_READY = "Default api is not ready yet";

  async function assertSingleDefaultApiBundle() {
    const assets = new URL("../page/dist/assets/", import.meta.url);
    const entries = await readdir(assets, { withFileTypes: true });
    const matchingAssets = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const asset = await readFile(new URL(entry.name, assets), "utf8");
      if (asset.includes(DEFAULT_API_NOT_READY)) matchingAssets.push(entry.name);
    }

    if (matchingAssets.length !== 1) {
      throw new Error(
        `expected one VS Code default API asset, found ${matchingAssets.length}: ${matchingAssets.join(", ")}`,
      );
    }
  }
  ```

  Call `await assertSingleDefaultApiBundle()` after the package script has
  built `page/dist` and before Puppeteer launches Chromium.

- [ ] **Step 4: Run browser acceptance and verify RED**

  Run:

  ```bash
  bun run test:lsp-browser
  ```

  Expected: FAIL before Chromium launch with
  `expected one VS Code default API asset, found 2`.

- [ ] **Step 5: Implement the minimum entry-owned dependency boundary**

  In `page/src/index.tsx`, add the runtime entry import:

  ```ts
  import { startRustLspClient } from "./rust_lsp_client";
  ```

  Pass the callback when rendering `App`:

  ```tsx
  startLspClient={(monaco) => startRustLspClient(ctx, monaco)}
  ```

  In `page/src/App.tsx`, remove the runtime `startRustLspClient` import. Import
  `DisposableLspSession` as a type alongside `LspStartGate`, then declare the
  complete component prop shape and pass the prop unchanged into the gate:

  ```ts
  import {
    type DisposableLspSession,
    LspStartGate,
  } from "./lsp_start_gate";

  const App = (props: {
    ctx: Ctx;
    callback: (wasi_ref: WASIFarmRef) => void;
    startLspClient: (
      monaco: typeof import("monaco-editor"),
    ) => Promise<DisposableLspSession>;
  }) => {
    const lspGate = new LspStartGate<typeof import("monaco-editor")>(
      props.startLspClient,
    );
    // Existing App body remains unchanged.
  };
  ```

  Do not change `handleMount`, `observeLspStart`, the anonymous editor model,
  the VFS readiness callback, or any LSP resource lifecycle code.

- [ ] **Step 6: Run focused GREEN tests**

  Run:

  ```bash
  deno test --no-lock --allow-read page/src/lsp_start_gate_test.ts page/src/rust_lsp_startup_test.ts page/src/rust_lsp_client_test.ts page/src/rust_document_sync_test.ts
  bun run test:lsp-browser
  deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts
  ```

  Expected:

  - focused tests pass with zero failures;
  - browser assets contain one default-API literal, then Puppeteer observes and
    clears the semantic `rust-analyzer` Monaco marker;
  - full-VFS publishes and clears the semantic diagnostic.

- [ ] **Step 7: Check formatting, build topology, and diff scope**

  Run:

  ```bash
  bun x biome format --check page/src/index.tsx page/src/App.tsx page/src/lsp_start_gate_test.ts scripts/lsp_browser_diagnostics_test.mjs
  bun run --cwd page build
  git diff --check
  git status --short
  ```

  Expected: formatting and diff checks exit 0; page build succeeds; the only
  tracked changes are the four task paths.

- [ ] **Step 8: Commit the fix**

  ```bash
  git add page/src/index.tsx page/src/App.tsx page/src/lsp_start_gate_test.ts scripts/lsp_browser_diagnostics_test.mjs
  git commit -m "fix(lsp): keep VS Code API singleton entry-owned"
  ```

  Expected: one commit containing only the four paths above.
