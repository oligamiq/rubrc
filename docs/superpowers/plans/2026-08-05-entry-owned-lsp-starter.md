# Entry-Owned Rust LSP Starter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the VS Code extension API and `MonacoLanguageClient` in one
entry-owned module graph so browser rust-analyzer startup reaches semantic
Monaco diagnostics.

**Architecture:** `index.tsx` owns an async dynamic import of
`startRustLspClient` inside a typed starter callback injected into lazy `App`.
`App` retains the existing Monaco/VFS `LspStartGate`, but no longer imports the
language client itself. The callback executes only after wrapper startup and
both readiness gates, preserving the wrapper's extension-service loading
boundary. The browser acceptance harness asserts that the built asset graph
contains one VS Code default-API singleton asset before launching Chromium.

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
  manual chunk configuration, or a lazy-chunk `vscode/localExtensionHost`
  import.
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
- Modify: `page/vite.config.ts:12-17`
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
  const viteSource = await Deno.readTextFile("page/vite.config.ts");
  const rustLspStaticImport =
    /(?:\bimport\s*|\bfrom\s*)["']\.\/rust_lsp_client(?:\.(?:ts|js))?["']/;
  const rustLspDynamicImport =
    /\bimport\s*\(\s*["']\.\/rust_lsp_client(?:\.(?:ts|js))?["']\s*\)/;

  assert(
    rustLspStaticImport.test('import "./rust_lsp_client";'),
    "static-import matcher must reject side-effect imports",
  );
  assert(
    rustLspDynamicImport.test('await import("./rust_lsp_client")'),
    "dynamic-import matcher must detect direct module ownership",
  );

  assert(
    !rustLspStaticImport.test(indexSource),
    "index.tsx must not statically import rust_lsp_client",
  );
  assert(
    /startLspClient\s*=/.test(indexSource) &&
      rustLspDynamicImport.test(indexSource),
    "index.tsx must inject an entry-owned dynamic LSP starter",
  );
  assert(
    !rustLspStaticImport.test(source) &&
      !rustLspDynamicImport.test(source),
    "App must not import rust_lsp_client",
  );
  assert(
    /startLspClient\s*:/.test(source) &&
      source.includes("Promise<DisposableLspSession>"),
    "App must accept the typed injected LSP starter",
  );
  assert(
    /new\s+LspStartGate[\s\S]*?\(\s*(?:props\.)?startLspClient\s*,?\s*\)/.test(
      source,
    ),
    "App must give the injected starter to LspStartGate",
  );
  const dedupeBlock = viteSource.match(/dedupe\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  for (const dependency of [
    "vscode",
    "@codingame/monaco-vscode-api",
    "@codingame/monaco-vscode-extension-api",
    "@codingame/monaco-vscode-extensions-service-override",
  ]) {
    assert(
      dedupeBlock.includes(`"${dependency}"`) ||
        dedupeBlock.includes(`'${dependency}'`),
      `Vite does not dedupe ${dependency}`,
    );
  }
  ```

- [ ] **Step 2: Run the source-contract test and verify RED**

  Run:

  ```bash
  deno test --no-lock --allow-read page/src/lsp_start_gate_test.ts
  ```

  Expected: FAIL because `page/vite.config.ts` does not yet dedupe the four VS
  Code singleton packages. During the earlier RED sequence, the source test
  also failed for the App-owned and index-static client imports before the
  dynamic callback was introduced.

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

  In `page/src/index.tsx`, remove any top-level `rust_lsp_client` import and
  pass this callback when rendering `App`:

  ```tsx
  startLspClient={async (monaco) => {
    const { startRustLspClient } = await import("./rust_lsp_client");
    return startRustLspClient(ctx, monaco);
  }}
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

  In `page/vite.config.ts`, preserve the existing Monaco alias and add:

  ```ts
  dedupe: [
    "vscode",
    "@codingame/monaco-vscode-api",
    "@codingame/monaco-vscode-extension-api",
    "@codingame/monaco-vscode-extensions-service-override",
  ],
  ```

- [ ] **Step 6: Run focused GREEN tests**

  Run:

  ```bash
  deno test --no-lock -A page/src/lsp_start_gate_test.ts page/src/rust_lsp_startup_test.ts page/src/rust_lsp_client_test.ts page/src/rust_document_sync_test.ts
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
  bun x @biomejs/biome@1.9.4 format page/src/index.tsx page/vite.config.ts
  bun run --cwd page build
  git diff --check
  git status --short
  ```

  Expected: focused formatting and diff checks exit 0; page build succeeds.
  `App.tsx`, the existing gate test, and browser harness have documented
  pre-existing whole-file Biome differences and must not be bulk-reformatted.
  The only tracked changes are the five task paths.

- [ ] **Step 8: Commit the fix**

  ```bash
  git add page/src/index.tsx page/src/App.tsx page/src/lsp_start_gate_test.ts page/vite.config.ts scripts/lsp_browser_diagnostics_test.mjs
  git commit -m "fix(lsp): keep VS Code API singleton entry-owned"
  ```

  Expected: one commit containing only the five paths above.
