# Dev WASI Cache Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Vite dev from reusing a stale cached
`@oligami/browser_wasi_shim-threads` module after allocator patches change.

**Architecture:** Add a dev-only Vite middleware/header hook that targets the
served `@oligami/browser_wasi_shim-threads` module path and overrides cache
headers to `no-store`. Keep production build and preview behavior unchanged.

**Limitation:** This prevents caching of responses received from the guarded
server. It cannot evict an existing cached response served without contacting
Vite; an affected browser may need a cache-bypassing reload once.

**Tech Stack:** Vite 8 config, Bun scripts, Deno source-level tests.

## Global Constraints

- Do not touch port `4173`.
- Do not modify production runtime allocator sizes or rust-analyzer memory
  reservations.
- Do not change generated
  `page/src/worker_process/vfs_bindings/thread_spawn.ts`.
- Do not commit unless explicitly requested.
- Keep the change dev-only and narrowly scoped to
  `@oligami/browser_wasi_shim-threads` module responses.

---

### Task 1: Dev-Only Cache Guard

**Files:**

- Modify: `page/vite.config.ts`
- Modify: `page/src/monaco_worker_test.ts`

**Interfaces:**

- Consumes: Vite `configureServer(server)` middleware hook.
- Produces: A dev-only middleware that sets `Cache-Control: no-store` for URLs
  containing `/@fs/` and `/node_modules/@oligami/browser_wasi_shim-threads/`.

- [x] **Step 1: Write the failing contract test**

Read the Vite config at module scope, then add this Deno test to
`page/src/monaco_worker_test.ts`:

```ts
const viteConfigSource = await Deno.readTextFile(
  new URL("../vite.config.ts", import.meta.url),
);

Deno.test("Vite dev disables browser cache for patched WASI thread shim modules", () => {
  const cacheGuardPluginSource = viteConfigSource.match(
    /function wasiThreadShimCacheGuardPlugin\(\): Plugin \{[\s\S]*?\n\}/,
  )?.[0];
  if (!cacheGuardPluginSource) {
    throw new Error("Vite dev cache guard plugin is missing");
  }
  if (!cacheGuardPluginSource.includes('apply: "serve"')) {
    throw new Error("cache guard is not limited to the Vite dev server");
  }
  if (
    !/rawUrl\?\.includes\("\/@fs\/"\)\s*&&\s*rawUrl\.includes\(\s*"\/node_modules\/@oligami\/browser_wasi_shim-threads\/"\s*,?\s*\)/
      .test(
        cacheGuardPluginSource,
      )
  ) {
    throw new Error(
      "cache guard does not require both the Vite /@fs/ URL and patched package path",
    );
  }
  if (
    !cacheGuardPluginSource.includes(
      "response.setHeader = function (name, value)",
    ) ||
    !cacheGuardPluginSource.includes(
      'name.toLowerCase() === "cache-control" ? "no-store" : value',
    )
  ) {
    throw new Error("cache guard does not override downstream cache headers");
  }
  if (
    !/const isDevelopmentServer\s*=\s*command === "serve"\s*&&\s*isPreview !== true/
      .test(
        viteConfigSource,
      ) ||
    !viteConfigSource.includes(
      "...(isDevelopmentServer ? [wasiThreadShimCacheGuardPlugin()] : [])",
    )
  ) {
    throw new Error("cache guard is not excluded from Vite preview");
  }
});
```

- [x] **Step 2: Run the test to verify it fails**

Run:
`deno test --no-lock --allow-read page/src/monaco_worker_test.ts --filter "Vite dev disables browser cache"`

Expected: FAIL with `Vite dev cache guard plugin is missing`.

- [x] **Step 3: Implement the minimal dev-only Vite plugin**

Add this helper to `page/vite.config.ts` after `developmentRustSrcPlugin`:

```ts
function wasiThreadShimCacheGuardPlugin(): Plugin {
  return {
    name: "rubrc-wasi-thread-shim-cache-guard",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const rawUrl = request.url;
        if (
          rawUrl?.includes("/@fs/") &&
          rawUrl.includes("/node_modules/@oligami/browser_wasi_shim-threads/")
        ) {
          const setHeader = response.setHeader;
          response.setHeader = function (name, value) {
            return setHeader.call(
              this,
              name,
              name.toLowerCase() === "cache-control" ? "no-store" : value,
            );
          };
          response.setHeader("Cache-Control", "no-store");
        }
        next();
      });
    },
  };
}
```

Add the plugin to the `plugins` array before `solidPlugin()` only for the
development server, excluding preview:

```ts
...(isDevelopmentServer ? [wasiThreadShimCacheGuardPlugin()] : []),
```

- [x] **Step 4: Run the focused test to verify it passes**

Run:
`deno test --no-lock --allow-read page/src/monaco_worker_test.ts --filter "Vite dev disables browser cache"`

Expected: PASS.

- [x] **Step 5: Verify the live dev header**

Run a Vite dev server on an isolated port, then request the served module URL
observed in the browser:

```bash
bun run --cwd page dev --host 127.0.0.1 --port 4177 --strictPort
curl --fail --silent --show-error --dump-header - --output /tmp/opencode/rubrc-dev-module.js "http://127.0.0.1:4177/@fs/home/oligami/projects/rubrc/node_modules/@oligami/browser_wasi_shim-threads/dist/browser-wasi-shim-threads.es.js?v=745b5201"
```

Expected header includes `Cache-Control: no-store`.

- [x] **Step 6: Verify dev startup still reaches ready**

Run: `bun /tmp/opencode/rubrc-dev-oom-probe.mjs "http://127.0.0.1:4177/" 1`

Expected: JSON output has `"result": { "kind": "ready" }` and no `fatal` object.

## Self-Review

- Spec coverage: The plan covers the approved dev-only cache guard and keeps
  production/static paths unchanged.
- Placeholder scan: No placeholder steps remain.
- Type consistency: The plugin name, Vite `Plugin` type, middleware arguments,
  and target package string match existing `page/vite.config.ts` patterns.
