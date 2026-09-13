# Browser Development Worker And Cache Error Design

## Context

The development browser reports two independent console errors while starting
the SquashFS-backed full rust-src runtime.

First, Monaco creates its editor worker, but the worker's generated module
imports a dependency URL from an obsolete Vite dependency-optimization graph.
That URL returns `504 Outdated Optimize Dep`. Monaco receives a worker error and
falls back to loading worker code on the main thread, which can freeze the UI.

The editor worker entry itself is available as a same-origin module and returns
`200`. `MonacoEnvironment.getWorker` is installed and returns the existing Vite
`?worker` constructor. The failure occurs after worker creation when the worker
loads a deep Monaco dependency that was not part of Vite's initial optimized
dependency set.

Second, rust-src cache maintenance runs during development with build epoch
`0`. It requests `/.rubrc-pages-build.json`, which does not exist on the Vite
development server. Vite returns the application HTML fallback with status
`200` and `Content-Type: text/html`; cache maintenance then calls
`response.json()` and reports a syntax error. A zero build epoch can never
match valid deployment metadata because production cache pruning requires a
positive build epoch.

These warnings do not describe a SquashFS mount failure. They are development
worker optimization and best-effort cache-maintenance failures.

## Goals

- Prevent Monaco's editor worker from requesting an outdated optimized
  dependency during development startup.
- Keep Monaco language work off the browser main thread.
- Avoid deployment-metadata requests when cache pruning cannot be valid.
- Preserve production rust-src cache pruning for positive build epochs.
- Preserve the current worker constructor, SquashFS asset transport, and runtime
  startup architecture.
- Add focused regressions that exercise the actual development-server worker
  dependency response.

## Non-Goals

- Change the SquashFS filesystem implementation or rust-analyzer memory policy.
- Suppress Monaco worker errors or accept main-thread fallback.
- Add a development-only `.rubrc-pages-build.json` endpoint.
- Change production deployment metadata or cache naming.
- Replace Vite's worker integration with a custom worker loader.
- Address the separately identified VFS mount and read-only semantic issues in
  this change.

## Design

### Monaco Worker Dependency Optimization

Add the resolved editor worker package entry to Vite's
`optimizeDeps.include`:

```text
@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js
```

The source imports this entry through the repository's `monaco-editor` alias.
The resolved package entry matches the dependency ID in the observed failing
optimized URL and avoids relying on alias handling inside Vite's initial scan.
Vite then optimizes the worker dependency before the main dependency graph has
produced browser hashes. The generated worker module and its optimized
dependency therefore use the same current optimization graph.

This is intentionally limited to the editor worker that produced the observed
504. Other application workers are not added speculatively; a future worker
dependency receives its own evidence and regression if it exhibits the same
failure.

The existing `?worker` constructor and `MonacoEnvironment.getWorker` remain
unchanged. The configuration does not use `optimizeDeps.ignoreOutdatedRequests`
and does not hide a real worker initialization failure.

After this configuration changes, the currently running development server must
be restarted once so Vite creates a fresh optimization graph.

### Development Cache Maintenance

`pruneRustSrcCacheVariants` continues to parse the current archive URL's `build`
query parameter before performing maintenance. If the current value is absent,
malformed, or zero, the function returns immediately.

The return occurs before opening CacheStorage, listing cache keys, fetching
deployment metadata, or reporting an error. These values cannot pass the
existing positive-epoch metadata check, so skipping them does not remove any
possible cache deletion. `cacheBuildEpoch` keeps mapping a missing build value
to zero so a positive-epoch production deployment can still prune legacy cached
candidate URLs that lack a build parameter. Only the current archive URL gets
the new early-return check.

For a positive build epoch, behavior remains unchanged:

1. Open the rust-src asset cache.
2. Snapshot its requests.
3. Fetch same-directory `.rubrc-pages-build.json` with `cache: "no-store"`.
4. Require a JSON Content-Type before parsing the response.
5. Require matching version, source revision, and positive build epoch.
6. Delete only older variants of the same-origin rust-src asset path.

An HTML or other non-JSON SPA fallback is an expected metadata miss and returns
without reporting a parse error. Malformed declared JSON, metadata fetch,
invalid current URLs, and CacheStorage failures remain best-effort and continue
through the existing error reporter for production deployments.

## Error Handling

- A Monaco worker load error remains visible and must not be converted into an
  accepted main-thread fallback.
- Vite's normal `504 Outdated Optimize Dep` behavior remains enabled for genuine
  stale requests; the worker dependency is made part of the initial graph
  instead of globally ignoring outdated requests.
- Development epoch zero is an expected no-op, not an error.
- Positive-epoch cache-maintenance failures remain non-fatal and cannot delete
  cache entries.

## Testing

Tests are added before implementation changes.

### Cache Tests

- A rust-src URL with `build=0` performs no CacheStorage access, cache-key
  listing, metadata fetch, deletion, or error report.
- A missing or malformed build value has the same no-op behavior.
- A positive-epoch `200 text/html` metadata response performs no deletion and
  does not attempt JSON parsing or report a syntax error.
- Legacy candidate cache URLs without a build parameter remain eligible for
  deletion by a matching positive-epoch deployment.
- Existing positive-epoch matching, stale-tab, invalid-metadata, and storage
  failure tests remain unchanged and pass.

### Worker Configuration Tests

- The Vite configuration contains the exact resolved editor worker package entry
  in `optimizeDeps.include`, and a fresh Vite scan resolves it successfully.
- The existing Monaco worker contract continues to require the Vite `?worker`
  constructor and editor worker module.

### Development Server Regression

Start a fresh Vite development server with an empty optimizer cache using the
validated development rust-src asset. Disable automatic dependency discovery
for this isolated regression so only the explicit `optimizeDeps.include` entry
determines whether the worker dependency is pre-bundled, then:

1. Request the editor worker constructor wrapper and extract its `worker_file`
   URL.
2. Request that worker module and extract its optimized dependency URL.
3. Request the dependency immediately.
4. Require a successful JavaScript response and reject `504 Outdated Optimize
   Dep`.

The regression must not depend on a previously warmed Vite cache. It runs in a
Node-capable test harness because the Vite configuration imports Node and Vite
plugins; Deno source inspection alone is not sufficient. Keeping application
entry discovery out of this contract also prevents unrelated optional
dependencies from making the worker regression flaky.

### Verification

Run the focused rust-src cache, Monaco worker, development asset, and static
server tests. Run the production page build to ensure worker bundling remains
valid. Run `git diff --check`. Finally, restart the existing development server
once and confirm that neither the Monaco main-thread fallback warning nor the
rust-src metadata JSON warning appears.

## Alternatives

### Exclude The Worker Dependency From Optimization

`optimizeDeps.exclude` would avoid an optimized dependency URL and serve the
pure ESM worker dependency directly. It increases development module requests
and is unnecessary when the dependency can be included in the initial graph.

### Force Restart As An Operational Workaround

Starting Vite with `--force` can rebuild the current dependency graph, but a
later missing-dependency discovery can reproduce the worker-only stale request.
It is useful once after the configuration change but is not the fix.

### Development Metadata Endpoint

Serving synthetic deployment metadata in development would avoid the JSON parse
error, but cache pruning is intentionally deployment-scoped and cannot be valid
at build epoch zero. An early no-op is smaller and preserves that boundary.
