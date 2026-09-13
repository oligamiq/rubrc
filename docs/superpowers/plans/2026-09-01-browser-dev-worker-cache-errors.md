# Browser Development Worker And Cache Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop development rust-src cache maintenance from parsing Vite's HTML fallback and ensure Monaco's editor worker never loads an outdated Vite-optimized dependency.

**Architecture:** Cache pruning becomes an immediate no-op when the current archive has no positive build epoch, while positive-epoch metadata is parsed only when its media type is JSON. Vite pre-optimizes the resolved CodinGame editor-worker entry, and an isolated fresh-cache dev-server regression follows the same wrapper, worker module, and optimized dependency requests as the browser.

**Tech Stack:** TypeScript, Deno tests, Node.js test runner, Vite 8, Monaco Editor/CodinGame VS Code API, CacheStorage.

## Global Constraints

- Do not stage or commit any files.
- Preserve all existing user changes in the dirty worktree.
- Do not modify the SquashFS VFS, rust-analyzer graph, memory reservations, or diagnostics timeouts.
- Keep the existing Vite `?worker` constructor and `MonacoEnvironment.getWorker` implementation.
- Keep positive-epoch production cache pruning and legacy candidate pruning behavior.
- Do not use `optimizeDeps.ignoreOutdatedRequests` or suppress Monaco worker errors.
- Restart the current Vite development server once after changing `optimizeDeps`.

## File Structure

- Modify `page/src/rust_src_cache.ts`: current-epoch admission and deployment metadata media-type validation.
- Modify `page/src/rust_src_cache_test.ts`: cache admission, HTML fallback, declared JSON failure, and legacy candidate regressions.
- Modify `page/vite.config.ts`: initial optimization of the resolved editor-worker package entry.
- Modify `page/src/monaco_worker_test.ts`: static contract tying the worker source to Vite's resolved optimization entry.
- Create `scripts/monaco_worker_dev_server_test.mjs`: fresh-cache Vite HTTP regression for wrapper, worker module, and optimized dependency loading.

---

### Task 1: Make Cache Maintenance Deployment-Only

**Files:**
- Modify: `page/src/rust_src_cache.ts:24-80`
- Test: `page/src/rust_src_cache_test.ts:10-165`

**Interfaces:**
- Consumes: `pruneRustSrcCacheVariants(archiveUrl: string, sourceRevision: string, dependencies: RustSrcCacheDependencies): Promise<void>`.
- Produces: the same public function signature, with no dependency access for a non-positive current build epoch and no JSON parse attempt for non-JSON metadata.

- [ ] **Step 1: Make the existing valid metadata fixture declare JSON**

In `dependencies`, change the successful response to declare the production media type that the implementation will require:

```ts
return new Response(
  JSON.stringify({ version: 1, sourceSha, buildEpoch }),
  {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  },
);
```

- [ ] **Step 2: Add the failing current-epoch admission test**

Append this test to `page/src/rust_src_cache_test.ts`:

```ts
Deno.test("non-positive current build epochs skip every cache dependency", async () => {
  for (const url of [
    "https://example.test/rubrc/rust-src.sqfs",
    "https://example.test/rubrc/rust-src.sqfs?v=new",
    "https://example.test/rubrc/rust-src.sqfs?v=new&build=0",
    "https://example.test/rubrc/rust-src.sqfs?v=new&build=malformed",
    "https://example.test/rubrc/rust-src.sqfs?v=new&build=1&build=2",
  ]) {
    let dependencyAccessed = false;
    await pruneRustSrcCacheVariants(url, "new", {
      get cacheStorage(): never {
        dependencyAccessed = true;
        throw new Error("cacheStorage should not be accessed");
      },
      fetch: async () => {
        dependencyAccessed = true;
        throw new Error("fetch should not be called");
      },
      reportError: () => {
        dependencyAccessed = true;
      },
    });
    assert(!dependencyAccessed, `dependencies were accessed for ${url}`);
  }
});
```

- [ ] **Step 3: Add failing media-type behavior tests**

Append these tests:

```ts
Deno.test("positive epoch HTML metadata fallback is an unreported no-op", async () => {
  const test = dependencies("new");
  let reported: unknown;
  test.value.fetch = async () =>
    new Response("<!DOCTYPE html><title>Rubrc</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  test.value.reportError = (error) => {
    reported = error;
  };

  await pruneRustSrcCacheVariants(archiveUrl, "new", test.value);

  assert(reported === undefined, `HTML fallback reported ${reported}`);
  assert(test.deleted.length === 0, "HTML fallback deleted cache entries");
});

Deno.test("malformed declared JSON is reported without pruning", async () => {
  const test = dependencies("new");
  let reported: unknown;
  test.value.fetch = async () =>
    new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  test.value.reportError = (error) => {
    reported = error;
  };

  await pruneRustSrcCacheVariants(archiveUrl, "new", test.value);

  assert(reported instanceof SyntaxError, "declared JSON failure was hidden");
  assert(test.deleted.length === 0, "malformed JSON deleted cache entries");
});
```

- [ ] **Step 4: Run the cache test and confirm RED**

Run:

```bash
deno test --no-lock page/src/rust_src_cache_test.ts
```

Expected: FAIL because the zero/missing/malformed current epoch accesses `cacheStorage`, and the HTML response reaches `response.json()` and reports `SyntaxError`.

- [ ] **Step 5: Move dependency access behind current-epoch admission**

In `pruneRustSrcCacheVariants`, create and validate `current` before reading `dependencies.cacheStorage`:

```ts
try {
  const current = new URL(
    archiveUrl,
    typeof location === "undefined"
      ? "https://development.invalid/"
      : location.href,
  );
  const currentBuildEpoch = cacheBuildEpoch(current);
  if (currentBuildEpoch === undefined || currentBuildEpoch <= 0) return;

  const cacheStorage = dependencies.cacheStorage;
  if (!cacheStorage) return;
  const cache = await cacheStorage.open("rubrc-assets-v1");
  const requests = await cache.keys();
```

Do not change `cacheBuildEpoch` itself. Its missing-build result must remain `0` so positive production epochs can prune legacy candidate URLs.

- [ ] **Step 6: Validate metadata media type before parsing**

Immediately after `if (!response.ok) return;`, add:

```ts
const contentType = response.headers.get("content-type")
  ?.split(";", 1)[0]
  .trim()
  .toLowerCase();
if (
  contentType !== "application/json" &&
  !(contentType?.startsWith("application/") && contentType.endsWith("+json"))
) {
  return;
}
const metadata: unknown = await response.json();
```

Remove the old unconditional `const metadata: unknown = await response.json();` line.

- [ ] **Step 7: Run the cache tests and confirm GREEN**

Run:

```bash
deno test --no-lock page/src/rust_src_cache_test.ts
```

Expected: all tests PASS, including the existing assertion that unversioned and version-only legacy candidate URLs are deleted by a matching positive epoch.

- [ ] **Step 8: Check only the Task 1 diff**

Run:

```bash
git diff --check -- page/src/rust_src_cache.ts page/src/rust_src_cache_test.ts
git diff -- page/src/rust_src_cache.ts page/src/rust_src_cache_test.ts
```

Expected: no whitespace errors; only current-epoch admission, metadata media-type validation, and their tests are added. Do not stage or commit.

---

### Task 2: Pre-Optimize The Monaco Editor Worker

**Files:**
- Modify: `page/vite.config.ts:167-176`
- Modify: `page/src/monaco_worker_test.ts:1-22`
- Create: `scripts/monaco_worker_dev_server_test.mjs`

**Interfaces:**
- Consumes: `page/src/workers/editor.worker.ts` importing `monaco-editor/esm/vs/editor/editor.worker.js`, the `monaco-editor` alias to `@codingame/monaco-vscode-editor-api`, and Vite's `createServer` API.
- Produces: an initial optimized dependency entry for `@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js` and a fresh-cache HTTP regression for the generated worker graph.

- [ ] **Step 1: Add a failing static worker optimization contract**

At the top of `page/src/monaco_worker_test.ts`, load the Vite configuration:

```ts
const viteConfigSource = await Deno.readTextFile(
  new URL("../vite.config.ts", import.meta.url),
);
```

Append this test:

```ts
Deno.test("Vite pre-optimizes the resolved Monaco editor worker entry", () => {
  const resolvedWorkerEntry =
    "@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js";
  const includeBlock = viteConfigSource.match(
    /optimizeDeps\s*:\s*\{[\s\S]*?include\s*:\s*\[([\s\S]*?)\]/,
  )?.[1] ?? "";
  if (!includeBlock.includes(`"${resolvedWorkerEntry}"`)) {
    throw new Error(
      `optimizeDeps.include is missing ${resolvedWorkerEntry}`,
    );
  }
});
```

- [ ] **Step 2: Run the static worker test and confirm RED**

Run:

```bash
deno test --no-lock --allow-read page/src/monaco_worker_test.ts
```

Expected: FAIL with `optimizeDeps.include is missing @codingame/.../editor.worker.js`.

- [ ] **Step 3: Add the fresh-cache Vite regression**

Create `scripts/monaco_worker_dev_server_test.mjs` with this content:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const pageRoot = fileURLToPath(new URL("../page/", import.meta.url));
const configFile = fileURLToPath(
  new URL("../page/vite.config.ts", import.meta.url),
);

function importedPath(source, predicate) {
  for (const match of source.matchAll(/import\s+["']([^"']+)["']/g)) {
    if (predicate(match[1])) return match[1];
  }
  return undefined;
}

test("fresh Vite graph serves the Monaco editor worker dependency", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "rubrc-vite-worker-"));
  const server = await createServer({
    root: pageRoot,
    configFile,
    cacheDir,
    optimizeDeps: { force: true, noDiscovery: true },
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });

  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert(address !== null && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const wrapperResponse = await fetch(
      `${origin}/src/workers/editor.worker.ts?worker`,
    );
    assert.equal(wrapperResponse.status, 200, "worker wrapper did not load");
    const wrapperSource = await wrapperResponse.text();
    const workerPath = wrapperSource.match(/new Worker\(["']([^"']+)["']/)?.[1];
    assert(workerPath, "worker wrapper did not contain a worker_file URL");

    const workerResponse = await fetch(new URL(workerPath, origin));
    assert.equal(workerResponse.status, 200, "worker module did not load");
    const workerSource = await workerResponse.text();
    const dependencyPath = importedPath(
      workerSource,
      (path) =>
        path.includes("/node_modules/.vite/deps/") &&
        path.includes("editor__worker__js.js"),
    );
    assert(dependencyPath, "worker module did not use the optimized editor entry");

    const dependencyResponse = await fetch(new URL(dependencyPath, origin));
    assert.notEqual(
      dependencyResponse.status,
      504,
      "editor worker dependency returned 504 Outdated Optimize Dep",
    );
    assert.equal(dependencyResponse.status, 200);
    assert.match(
      dependencyResponse.headers.get("content-type") ?? "",
      /(?:java|type)script/i,
    );
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Prepare the validated development asset**

Run:

```bash
bun run rust-src:prepare-dev-asset
```

Expected: the command succeeds and `.rubrc-cache/dev/rust-src.sha256` identifies an existing immutable `.sqfs` asset. This is required because `page/vite.config.ts` validates the sidecar when creating a development server.

- [ ] **Step 5: Run the Vite regression and confirm RED**

Run:

```bash
node --test scripts/monaco_worker_dev_server_test.mjs
```

Expected before the configuration change: record whether the isolated runtime request reproduces `504 Outdated Optimize Dep`. The static contract from Step 2 is the required RED result; Vite timing may allow this live request to pass before the fix, so do not weaken or remove the static RED test.

- [ ] **Step 6: Add the resolved worker entry to Vite optimization**

Change the existing `optimizeDeps` block in `page/vite.config.ts` to retain all current exclusions and add:

```ts
optimizeDeps: {
  include: [
    "@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js",
  ],
  exclude: [
    "brotli-dec-wasm",
    "@oligami/browser_wasi_shim-threads",
    "@oligami/browser_wasi_shim-threads/worker_background_worker",
  ],
  esbuildOptions: {
    plugins: [importMetaUrlPlugin],
  },
},
```

- [ ] **Step 7: Run worker tests and confirm GREEN**

Run:

```bash
deno test --no-lock --allow-read page/src/monaco_worker_test.ts
node --test scripts/monaco_worker_dev_server_test.mjs
```

Expected: both tests PASS; the isolated worker dependency response is `200` JavaScript and never `504`.

- [ ] **Step 8: Run the existing development asset contracts**

Run:

```bash
deno test --no-lock --allow-read --allow-write scripts/rust_src_dev_asset_test.ts
```

Expected: all existing development asset and Vite middleware contracts PASS.

- [ ] **Step 9: Check only the Task 2 diff**

Run:

```bash
git diff --check -- page/vite.config.ts page/src/monaco_worker_test.ts scripts/monaco_worker_dev_server_test.mjs
git diff -- page/vite.config.ts page/src/monaco_worker_test.ts scripts/monaco_worker_dev_server_test.mjs
```

Expected: no whitespace errors; only the resolved worker include and its static/live regressions are added. Do not stage or commit.

---

### Task 3: Verify The Browser Error Fix Set

**Files:**
- Verify: `page/src/rust_src_cache.ts`
- Verify: `page/src/rust_src_cache_test.ts`
- Verify: `page/vite.config.ts`
- Verify: `page/src/monaco_worker_test.ts`
- Verify: `scripts/monaco_worker_dev_server_test.mjs`

**Interfaces:**
- Consumes: completed Task 1 and Task 2 behavior.
- Produces: verification evidence that cache maintenance is quiet in development, the editor worker dependency is loadable from a fresh optimizer cache, and production worker bundling still succeeds.

- [ ] **Step 1: Run all focused tests together**

Run:

```bash
deno test --no-lock --allow-read page/src/rust_src_cache_test.ts page/src/monaco_worker_test.ts
deno test --no-lock --allow-read --allow-write scripts/rust_src_dev_asset_test.ts
node --test scripts/monaco_worker_dev_server_test.mjs
```

Expected: every focused test PASS with no leaked Vite server process.

- [ ] **Step 2: Build the production page bundle**

Run:

```bash
bun run --cwd page build
```

Expected: Vite production build succeeds and emits the editor worker bundle without unresolved imports.

- [ ] **Step 3: Check repository formatting and scope**

Run:

```bash
bun x @biomejs/biome check page/src/rust_src_cache.ts page/src/rust_src_cache_test.ts page/vite.config.ts page/src/monaco_worker_test.ts scripts/monaco_worker_dev_server_test.mjs
git diff --check
git status --short
```

Expected: Biome and `git diff --check` pass. `git status` retains all pre-existing user changes and shows only the intended browser-error files as additional changes. Do not stage or commit.

- [ ] **Step 4: Restart development Vite once and inspect startup**

Stop the existing development server, then run:

```bash
bun run --cwd page dev -- --force
```

After the server reports ready, load the application once and require:

- no `504 Outdated Optimize Dep` for the editor worker dependency;
- no Monaco `Could not create web worker(s)` main-thread fallback warning;
- no `Failed to maintain rust-src cache` JSON syntax warning;
- normal SquashFS rust-src loading continues.

Stop the verification server after collecting the result. If a browser executable is unavailable in the environment, report this final interactive check as unavailable rather than claiming it passed; the fresh-cache Node regression and production build remain mandatory.
