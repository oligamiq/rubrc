# Development Rust-Source Asset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vite development serve the validated local `rust-src.tar.vfsbr` under a content-hash identity while rejecting and recovering from cached or network HTML/JSON responses before Brotli decoding.

**Architecture:** Keep optional-cache policy in `fetchWithOptionalCache`, but add response acceptance and best-effort deletion so a poisoned hit is evicted and retried. Isolate compressed-response fetching from the Wasm decoder behind an injected transform seam, then prepare the development archive before Vite starts and let an async dev-only plugin bind both the URL revision and middleware to the atomic SHA-256 sidecar.

**Tech Stack:** TypeScript 6.0.3, Deno 2.8.3 tests and archive scripts, Bun 1.3.14 lifecycle scripts, Vite 8.1.x, Node 24 native Brotli, CacheStorage, Web Streams

## Global Constraints

- `bun run --cwd page dev` and `bun run --cwd page start` must serve the same validated `rust-src.tar.vfsbr` asset shape as production.
- Write development archives only as `.rubrc-cache/dev/rust-src-<sha256>.tar.vfsbr` and the active SHA-256 only to `.rubrc-cache/dev/rust-src.sha256`; never write either under `page/public` or include them in a production Vite build.
- Generate the archive through the existing validated `prepareInstalledRustSrcArchive` path; missing `rust-src` or `rust-src-preview` must fail the pre-lifecycle script and prevent Vite from starting.
- Atomically publish the SHA-256 sidecar from a temporary file in the same directory, after the validated archive has been written.
- Retain the active development archive and the two newest prior content-addressed archives; remove older variants best-effort after publishing the sidecar.
- In development, `__RUBRC_SOURCE_REVISION__` and the middleware's required `v` query must use the same lowercase 64-character content SHA-256 read once at Vite startup.
- Preserve production `process.env.SOURCE_SHA ?? "development"`, `process.env.BUILD_EPOCH ?? "0"`, and the existing `resolve.dedupe` entries unchanged.
- Serve `/rust-src.tar.vfsbr` only when `v` exactly matches the startup SHA-256; return `409` for missing or mismatched identity, and pass missing/unreadable file errors to `next(error)` rather than Vite's SPA fallback.
- Set the development asset response `Content-Type` to exactly `application/octet-stream`.
- Extend the optional cache without adding global request coalescing; abort signals and streaming response clones remain owned by the existing single rust-src loader.
- A valid cache hit is returned unchanged; an invalid hit is deleted before a network retry; an invalid successful network response is returned but not cached.
- Cache open, match, delete, and put errors remain best-effort and must never replace the network response.
- Non-GET Request objects bypass CacheStorage, and a response clone is canceled when `cache.put` rejects.
- `fetch_compressed_stream` accepts only `application/octet-stream`, `application/brotli`, and `application/x-brotli`, allowing normal media-type parameters and case normalization; a missing header and every other type are rejected before body access or decompression.
- Preserve the existing non-OK HTTP error path and allow corrupt binary-looking bytes to reach the Brotli decoder so its detailed error remains observable.
- Use Deno for all new TypeScript tests; the direct compressed-response tests must inject a transform and must not initialize or decode with the real Wasm module.
- Make exactly one commit per task, stage only the task's listed files, and do not include unrelated working-tree changes.
- Format only files listed in the active task with `bun x @biomejs/biome@1.9.4 format --write`; never run repository-wide formatting.
- A test may remove only the temporary directory it created with `Deno.makeTempDir`; integration cleanup must not delete the persistent validated `.rubrc-cache` archive, sidecar, or `.rubrc-cache/sysroot` cache.

---

## File Structure

- `lib/src/fetch_with_optional_cache.ts`: owns cache open/match/delete/put best-effort behavior and the optional `acceptResponse(response)` policy hook.
- `lib/src/fetch_with_optional_cache_test.ts`: directly verifies cache recovery, invalid-network non-caching, and all cache-operation failure paths.
- `lib/src/fetch_compressed_stream.ts`: owns strict compressed Content-Type acceptance, descriptive errors, HTTP/body ordering, and the injected decompression seam without importing Wasm.
- `lib/src/fetch_compressed_stream_test.ts`: directly verifies HTML/JSON rejection before body/decompress and all accepted MIME cases with an identity transform.
- `lib/src/brotli_stream.ts`: retains the public `fetch_compressed_stream(url, signal)` API and supplies the real CacheStorage, fetch, logger, and Wasm transform to the tested seam.
- `scripts/lsp_browser_diagnostics_contract_test.ts`: keeps a source-level contract that the public Brotli wrapper delegates to the directly tested optional-cache fetch seam.
- `scripts/prepare_rust_src_dev_asset.ts`: writes an ignored immutable validated development archive and atomically publishes its active SHA-256 sidecar.
- `scripts/rust_src_dev_asset_test.ts`: directly tests development preparation in a temporary directory and enforces package, Vite, ignore, production-identity, dedupe, and no-public-leakage source contracts.
- `package.json`: exposes the root `rust-src:prepare-dev-asset` command.
- `page/package.json`: runs root development archive preparation through `predev` and `prestart`.
- `page/vite.config.ts`: asynchronously reads the sidecar for non-preview serve mode, injects its hash, and installs the identity-checked middleware only in development.
- `.gitignore`: already ignores `.rubrc-cache/`; it is verified but not modified.

### Task 1: Optional-Cache Recovery And Strict Brotli Response Boundary

**Files:**
- Modify: `lib/src/fetch_with_optional_cache.ts:1-41`
- Modify: `lib/src/fetch_with_optional_cache_test.ts:47-164`
- Create: `lib/src/fetch_compressed_stream.ts`
- Create: `lib/src/fetch_compressed_stream_test.ts`
- Modify: `lib/src/brotli_stream.ts:5,49-69`
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts:137-150`

**Interfaces:**
- Consumes: browser `CacheStorage.open(name)`, `Cache.match(input)`, `Cache.delete(input)`, `Cache.put(input, response)`, `fetch(input, init)`, and the existing `get_brotli_decompress_stream(): Promise<TransformStream<Uint8Array, Uint8Array>>`.
- Produces: exported `FetchInput = string | URL | Request`; exported `CacheBoundary` with `match`, `delete`, and `put`; exported `FetchWithOptionalCacheDependencies` with optional `acceptResponse?: (response: Response) => boolean`; `fetchWithOptionalCache(...): Promise<Response>`; `isAcceptedCompressedResponse(response): boolean`; `fetchCompressedStream(url, signal, dependencies): Promise<ReadableStream<Uint8Array>>`; unchanged public `fetch_compressed_stream(url, signal): Promise<ReadableStream<Uint8Array>>`.

- [ ] **Step 1: Add failing cache recovery and non-caching tests**

In each existing cache mock in `lib/src/fetch_with_optional_cache_test.ts`, add the exact `delete` method required by the new boundary. Add this method after `match` in the match-rejection mock:

```ts
            async delete() {
              throw new Error("cache delete must not run after a failed match");
            },
```

Add this method after `match` in the put-rejection mock:

```ts
              async delete() {
                throw new Error("cache delete must not run after a miss");
              },
```

Add this method after `match` in the cache-hit mock:

```ts
            async delete() {
              throw new Error("cache delete must not run on an accepted hit");
            },
```

Append these direct behavior tests to `lib/src/fetch_with_optional_cache_test.ts`:

```ts
Deno.test("invalid cache hit is deleted and replaced from the network", async () => {
  const input = "https://example.test/rust-src.tar.vfsbr?v=valid";
  const cachedResponse = new Response("<!doctype html>", {
    headers: { "content-type": "text/html" },
  });
  const networkBytes = new Uint8Array([1, 2, 3, 4]);
  const networkResponse = new Response(networkBytes, {
    headers: { "content-type": "application/octet-stream" },
  });
  const deleted: FetchInput[] = [];
  let fetchCalls = 0;
  let putCalls = 0;

  const response = await fetchWithOptionalCache(input, undefined, {
    cacheStorage: {
      async open() {
        return {
          async match() {
            return cachedResponse;
          },
          async delete(deletedInput) {
            deleted.push(deletedInput);
            return true;
          },
          async put(putInput, putResponse) {
            assert(putInput === input, "network response used the wrong cache key");
            assert(
              putResponse !== networkResponse,
              "network response was cached without cloning",
            );
            putCalls += 1;
          },
        };
      },
    },
    async fetch() {
      fetchCalls += 1;
      return networkResponse;
    },
    acceptResponse(candidate) {
      return candidate.headers.get("content-type") === "application/octet-stream";
    },
    reportCacheError(error) {
      throw new Error("valid recovery reported a cache error", { cause: error });
    },
  });

  assert(response === networkResponse, "network response identity changed");
  assert(deleted.length === 1 && deleted[0] === input, "invalid hit was not deleted");
  assert(fetchCalls === 1, "network was not fetched exactly once");
  assert(putCalls === 1, "valid replacement was not cached exactly once");
});

Deno.test("invalid successful network responses are returned but not cached", async () => {
  for (const contentType of ["text/html", "application/json"]) {
    const networkResponse = new Response("invalid", {
      headers: { "content-type": contentType },
    });
    let putCalls = 0;

    const response = await fetchWithOptionalCache(
      `https://example.test/asset?v=${encodeURIComponent(contentType)}`,
      undefined,
      {
        cacheStorage: {
          async open() {
            return {
              async match() {
                return undefined;
              },
              async delete() {
                throw new Error("cache delete must not run after a miss");
              },
              async put() {
                putCalls += 1;
              },
            };
          },
        },
        async fetch() {
          return networkResponse;
        },
        acceptResponse(candidate) {
          return candidate.headers.get("content-type") === "application/octet-stream";
        },
        reportCacheError(error) {
          throw new Error("invalid network response reported a cache error", {
            cause: error,
          });
        },
      },
    );

    assert(response === networkResponse, `${contentType} response identity changed`);
    assert(putCalls === 0, `${contentType} response was cached`);
  }
});

Deno.test("cache delete rejection is reported while network recovery continues", async () => {
  const cacheError = new Error("cache delete failed");
  const networkResponse = new Response(new Uint8Array([8, 9]), {
    headers: { "content-type": "application/octet-stream" },
  });
  const reportedErrors: unknown[] = [];
  let putCalls = 0;

  const response = await fetchWithOptionalCache(
    "https://example.test/rust-src.tar.vfsbr?v=recovery",
    undefined,
    {
      cacheStorage: {
        async open() {
          return {
            async match() {
              return new Response("cached html", {
                headers: { "content-type": "text/html" },
              });
            },
            delete() {
              return Promise.reject(cacheError);
            },
            async put() {
              putCalls += 1;
            },
          };
        },
      },
      async fetch() {
        return networkResponse;
      },
      acceptResponse(candidate) {
        return candidate.headers.get("content-type") === "application/octet-stream";
      },
      reportCacheError(error) {
        reportedErrors.push(error);
      },
    },
  );

  assert(response === networkResponse, "delete failure replaced the network response");
  assert(reportedErrors.length === 1, "delete failure was not reported exactly once");
  assert(reportedErrors[0] === cacheError, "wrong delete failure was reported");
  assert(putCalls === 1, "valid recovery was not cached after delete failure");
});

Deno.test("non-GET Request bodies bypass CacheStorage", async () => {
  const input = new Request("https://example.test/uploaded-asset", {
    method: "POST",
    body: "compressed-request-body",
  });
  let fetchedBody = "";

  await fetchWithOptionalCache(input, undefined, {
    cacheStorage: {
      open() {
        throw new Error("non-GET request must not open CacheStorage");
      },
    },
    async fetch(fetchInput) {
      assert(fetchInput === input, "network did not receive the original Request");
      fetchedBody = await input.text();
      return new Response(new Uint8Array([1]), {
        headers: { "content-type": "application/octet-stream" },
      });
    },
    acceptResponse: () => true,
    reportCacheError(error) {
      throw error;
    },
  });

  assert(fetchedBody === "compressed-request-body", "network Request body changed");
});
```

Also change the top-level import so the tests can type the recorded cache key:

```ts
import {
  type FetchInput,
  fetchWithOptionalCache,
} from "./fetch_with_optional_cache.ts";
```

- [ ] **Step 2: Add failing direct compressed-response tests without Wasm**

Create `lib/src/fetch_compressed_stream_test.ts` with this complete content:

```ts
/// <reference lib="deno.ns" />

import { fetchCompressedStream } from "./fetch_compressed_stream.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

Deno.test("invalid MIME types are rejected before body access or decompression", async () => {
  for (const contentType of [
    "text/html; charset=utf-8",
    "application/json",
    "image/png",
  ]) {
    const url = `https://example.test/rust-src.tar.vfsbr?v=${encodeURIComponent(contentType)}`;
    let bodyReads = 0;
    let decompressCalls = 0;
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": contentType }),
      get body(): ReadableStream<Uint8Array> {
        bodyReads += 1;
        throw new Error("invalid response body was accessed");
      },
    } as Response;
    let rejection: unknown;

    try {
      await fetchCompressedStream(url, undefined, {
        async fetch() {
          return response;
        },
        reportCacheError() {},
        async getDecompressStream() {
          decompressCalls += 1;
          return new TransformStream<Uint8Array, Uint8Array>();
        },
      });
    } catch (error) {
      rejection = error;
    }

    assert(rejection instanceof Error, `${contentType} did not reject`);
    assert(rejection.message.includes(url), `${contentType} error omitted the URL`);
    assert(
      rejection.message.includes(contentType),
      `${contentType} error omitted the Content-Type`,
    );
    assert(bodyReads === 0, `${contentType} response body was accessed`);
    assert(decompressCalls === 0, `${contentType} reached decompression`);
  }
});

Deno.test("missing Content-Type is rejected before decompression", async () => {
  let decompressCalls = 0;
  let rejection: unknown;
  try {
    await fetchCompressedStream(
      "https://example.test/rust-src.tar.vfsbr?v=missing-type",
      undefined,
      {
        async fetch() {
          return new Response(new Uint8Array([1, 2, 3]));
        },
        reportCacheError() {},
        async getDecompressStream() {
          decompressCalls += 1;
          return new TransformStream<Uint8Array, Uint8Array>();
        },
      },
    );
  } catch (error) {
    rejection = error;
  }
  assert(rejection instanceof Error, "missing Content-Type did not reject");
  assert(rejection.message.includes("missing"), "missing header error is unclear");
  assert(decompressCalls === 0, "missing Content-Type reached decompression");
});

Deno.test("binary Brotli Content-Type responses reach decompression", async () => {
  const expected = new Uint8Array([11, 12, 13]);
  for (const contentType of [
    "application/octet-stream",
    "application/brotli",
    "application/x-brotli; profile=archive",
    "Application/Octet-Stream; Charset=binary",
  ]) {
    let decompressCalls = 0;
    const headers = new Headers();
    headers.set("content-type", contentType);

    const stream = await fetchCompressedStream(
      "https://example.test/rust-src.tar.vfsbr?v=accepted",
      undefined,
      {
        async fetch() {
          return new Response(expected, { headers });
        },
        reportCacheError() {},
        async getDecompressStream() {
          decompressCalls += 1;
          return new TransformStream<Uint8Array, Uint8Array>();
        },
      },
    );

    const actual = await readBytes(stream);
    assert(actual.join(",") === expected.join(","), `${contentType} bytes changed`);
    assert(decompressCalls === 1, `${contentType} did not reach decompression once`);
  }
});

Deno.test("non-OK responses retain the HTTP failure path", async () => {
  let decompressCalls = 0;
  let rejection: unknown;
  try {
    await fetchCompressedStream(
      "https://example.test/rust-src.tar.vfsbr?v=missing",
      undefined,
      {
        async fetch() {
          return new Response("missing", {
            status: 404,
            headers: { "content-type": "text/html" },
          });
        },
        reportCacheError() {},
        async getDecompressStream() {
          decompressCalls += 1;
          return new TransformStream<Uint8Array, Uint8Array>();
        },
      },
    );
  } catch (error) {
    rejection = error;
  }

  assert(rejection instanceof Error, "non-OK response did not reject");
  assert(rejection.message === "Failed to fetch wasm", "HTTP error path changed");
  assert(decompressCalls === 0, "non-OK response reached decompression");
});
```

- [ ] **Step 3: Update the failing source contract for the new tested seam**

Replace the test named `compressed stream delegates the optional cache boundary` in `scripts/lsp_browser_diagnostics_contract_test.ts` with:

```ts
Deno.test("compressed stream delegates the tested optional cache boundary", async () => {
  const wrapper = await Deno.readTextFile("lib/src/brotli_stream.ts");
  const fetchBoundary = await Deno.readTextFile(
    "lib/src/fetch_compressed_stream.ts",
  );

  assert(
    wrapper.includes(
      'import { fetchCompressedStream } from "./fetch_compressed_stream.ts";',
    ) && wrapper.includes("fetchCompressedStream(url, signal,"),
    "public compressed stream does not delegate to the directly tested seam",
  );
  assert(
    fetchBoundary.includes("fetchWithOptionalCache,") &&
      fetchBoundary.includes('from "./fetch_with_optional_cache.ts";') &&
      fetchBoundary.includes("await fetchWithOptionalCache("),
    "compressed-response seam bypasses the optional cache boundary",
  );
});
```

- [ ] **Step 4: Run the focused tests to verify RED**

Run:

```bash
deno test --no-lock --allow-read \
  lib/src/fetch_with_optional_cache_test.ts \
  lib/src/fetch_compressed_stream_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: FAIL. Deno reports that `lib/src/fetch_compressed_stream.ts` is missing and that `FetchInput`, `CacheBoundary.delete`, and `acceptResponse` are not yet exported/implemented; no test should reach a real Brotli Wasm import.

- [ ] **Step 5: Implement cache deletion and response acceptance**

Replace `lib/src/fetch_with_optional_cache.ts` with this complete content:

```ts
export type FetchInput = string | URL | Request;

export interface CacheBoundary {
  match(input: FetchInput): Promise<Response | undefined>;
  delete(input: FetchInput): Promise<boolean>;
  put(input: FetchInput, response: Response): Promise<void>;
}

export interface CacheStorageBoundary {
  open(name: string): Promise<CacheBoundary>;
}

export interface FetchWithOptionalCacheDependencies {
  cacheStorage?: CacheStorageBoundary;
  fetch(input: FetchInput, init?: RequestInit): Promise<Response>;
  reportCacheError(error: unknown): void;
  acceptResponse?: (response: Response) => boolean;
}

export async function fetchWithOptionalCache(
  input: FetchInput,
  init: RequestInit | undefined,
  dependencies: FetchWithOptionalCacheDependencies,
): Promise<Response> {
  const {
    cacheStorage,
    fetch,
    reportCacheError,
    acceptResponse = () => true,
  } = dependencies;
  if (input instanceof Request && input.method !== "GET") {
    return await fetch(input, init);
  }
  if (!cacheStorage) return await fetch(input, init);

  let cache: CacheBoundary;
  try {
    cache = await cacheStorage.open("rubrc-assets-v1");
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  let cachedResponse: Response | undefined;
  try {
    cachedResponse = await cache.match(input);
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  if (cachedResponse) {
    if (acceptResponse(cachedResponse)) return cachedResponse;
    try {
      await cache.delete(input);
    } catch (error) {
      reportCacheError(error);
    }
  }

  const response = await fetch(input, init);
  if (response.ok && acceptResponse(response)) {
    const cacheResponse = response.clone();
    void cache.put(input, cacheResponse).catch(async (error) => {
      await cacheResponse.body?.cancel().catch(() => undefined);
      reportCacheError(error);
    });
  }
  return response;
}
```

This deliberately keeps open/match fallback behavior unchanged, retries after a rejected hit even if deletion fails, and never turns asynchronous put failure into a fetch failure.

- [ ] **Step 6: Implement the MIME boundary and injected decompression seam**

Create `lib/src/fetch_compressed_stream.ts` with this complete content:

```ts
import {
  type FetchInput,
  type FetchWithOptionalCacheDependencies,
  fetchWithOptionalCache,
} from "./fetch_with_optional_cache.ts";

const ACCEPTED_COMPRESSED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/brotli",
  "application/x-brotli",
]);

export type FetchCompressedStreamDependencies = Omit<
  FetchWithOptionalCacheDependencies,
  "acceptResponse"
> & {
  getDecompressStream(): Promise<TransformStream<Uint8Array, Uint8Array>>;
};

function mediaType(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return null;
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

export function isAcceptedCompressedResponse(response: Response): boolean {
  const type = mediaType(response);
  return type === null || ACCEPTED_COMPRESSED_CONTENT_TYPES.has(type);
}

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export async function fetchCompressedStream(
  url: FetchInput,
  signal: AbortSignal | undefined,
  dependencies: FetchCompressedStreamDependencies,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetchWithOptionalCache(url, { signal }, {
    cacheStorage: dependencies.cacheStorage,
    fetch: dependencies.fetch,
    reportCacheError: dependencies.reportCacheError,
    acceptResponse: isAcceptedCompressedResponse,
  });

  if (!response.ok) {
    throw new Error("Failed to fetch wasm");
  }
  if (!isAcceptedCompressedResponse(response)) {
    const contentType = response.headers.get("content-type");
    throw new Error(
      `Invalid compressed asset response for ${requestUrl(url)}: unsupported Content-Type ${JSON.stringify(contentType)}`,
    );
  }
  if (!response.body) {
    throw new Error("No body in response");
  }

  return response.body.pipeThrough(await dependencies.getDecompressStream());
}
```

In `lib/src/brotli_stream.ts`, replace the optional-cache import with:

```ts
import { fetchCompressedStream } from "./fetch_compressed_stream.ts";
```

Replace the complete `fetch_compressed_stream` function at lines 49-69 with:

```ts
export const fetch_compressed_stream = async (
  url: string | URL | globalThis.Request,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> =>
  await fetchCompressedStream(url, signal, {
    cacheStorage: "caches" in globalThis ? caches : undefined,
    fetch,
    reportCacheError(error) {
      console.warn("Failed to cache compressed asset", error);
    },
    getDecompressStream: get_brotli_decompress_stream,
  });
```

The wrapper signature remains unchanged for `lib/src/get_wasm.ts`, `lib/src/sysroot.ts`, and the dynamic import in `page/src/sysroot_archive.ts`.

- [ ] **Step 7: Format only Task 1 files**

Run:

```bash
bun x @biomejs/biome@1.9.4 format --write \
  lib/src/fetch_with_optional_cache.ts \
  lib/src/fetch_with_optional_cache_test.ts \
  lib/src/fetch_compressed_stream.ts \
  lib/src/fetch_compressed_stream_test.ts \
  lib/src/brotli_stream.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: exit 0; only the six listed files are formatted.

- [ ] **Step 8: Run focused Task 1 tests to verify GREEN**

Run:

```bash
deno test --no-lock --allow-read \
  lib/src/fetch_with_optional_cache_test.ts \
  lib/src/fetch_compressed_stream_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: PASS. Cache open/match/delete/put failures remain reported and non-fatal, invalid hits retry, invalid network HTML/JSON are not cached, MIME errors include URL/type before body access, all four accepted binary header forms reach only the injected transform, and the HTTP failure assertion remains `Failed to fetch wasm`.

- [ ] **Step 9: Build the library and inspect the Task 1 diff**

Run:

```bash
bun run --cwd lib build
git diff --check
git status --short
git diff -- \
  lib/src/fetch_with_optional_cache.ts \
  lib/src/fetch_with_optional_cache_test.ts \
  lib/src/fetch_compressed_stream.ts \
  lib/src/fetch_compressed_stream_test.ts \
  lib/src/brotli_stream.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: the Vite library build exits 0, `git diff --check` is silent, and the diff contains only the acceptance/deletion boundary, injected compressed fetch seam, direct tests, and adjusted source contract. `lib/dist` remains ignored and unstaged.

- [ ] **Step 10: Commit Task 1**

Run:

```bash
git add \
  lib/src/fetch_with_optional_cache.ts \
  lib/src/fetch_with_optional_cache_test.ts \
  lib/src/fetch_compressed_stream.ts \
  lib/src/fetch_compressed_stream_test.ts \
  lib/src/brotli_stream.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "fix: reject invalid compressed asset responses"
```

Expected: the staged-name list contains exactly the six Task 1 files and the commit succeeds without staging generated `dist` files or unrelated changes.

### Task 2: Validated Development Asset Lifecycle And Vite Middleware

**Files:**
- Create: `scripts/prepare_rust_src_dev_asset.ts`
- Create: `scripts/rust_src_dev_asset_test.ts`
- Modify: `package.json:26-29`
- Modify: `page/package.json:9-14`
- Modify: `page/vite.config.ts:1-60`
- Verify only: `.gitignore:7`
- Verify only: `page/src/sysroot_archive.ts:23-47,114-127`

**Interfaces:**
- Consumes: validated `prepareInstalledRustSrcArchive`, Deno WebCrypto SHA-256, same-directory `Deno.rename`, Bun pre-script lifecycle, Vite `ConfigEnv.isPreview`, and Node `FileHandle.createReadStream()`.
- Produces: `DEV_RUST_SRC_DIRECTORY = ".rubrc-cache/dev"`; immutable `rust-src-<sha256>.tar.vfsbr`; active `rust-src.sha256`; `writeRustSrcDevAsset(directory?, prepare?): Promise<string>` returning the lowercase SHA-256; root `rust-src:prepare-dev-asset`; page `predev`/`prestart`; dev-only `__RUBRC_SOURCE_REVISION__ = <sidecar SHA-256>`; middleware response `200 application/octet-stream` only for the exact matching `v` query and `409 text/plain` otherwise.

- [ ] **Step 1: Add the failing direct preparation and lifecycle/source contract tests**

Create `scripts/rust_src_dev_asset_test.ts` with this complete content:

```ts
/// <reference lib="deno.ns" />

import { writeRustSrcDevAsset } from "./prepare_rust_src_dev_asset.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("development rust-src writer publishes bytes and atomic SHA sidecar", async () => {
  const directory = await Deno.makeTempDir();
  const outputDirectory = `${directory}/dev`;
  try {
    const sha256 = await writeRustSrcDevAsset(outputDirectory, async () => ({
      archive: new Uint8Array([4, 5, 6]),
      cacheArchive: ".rubrc-cache/sysroot/rust-src.tar.vfsbr",
      source: "cache",
    }));

    assert(
      sha256 ===
        "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
      "development writer returned the wrong SHA-256",
    );
    const asset = await Deno.readFile(
      `${outputDirectory}/rust-src-${sha256}.tar.vfsbr`,
    );
    assert(asset.join(",") === "4,5,6", "development asset bytes changed");
    const sidecar = await Deno.readTextFile(`${outputDirectory}/rust-src.sha256`);
    assert(sidecar === `${sha256}\n`, "SHA-256 sidecar content changed");
    const entries = [];
    for await (const entry of Deno.readDir(`${directory}/dev`)) {
      entries.push(entry.name);
    }
    assert(
      entries.sort().join(",") ===
        `rust-src-${sha256}.tar.vfsbr,rust-src.sha256`,
      `temporary sidecar leaked: ${entries.join(",")}`,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development rust-src writer retains only three immutable versions", async () => {
  const directory = await Deno.makeTempDir();
  const outputDirectory = `${directory}/dev`;
  try {
    let activeSha256 = "";
    for (const byte of [1, 2, 3, 4]) {
      activeSha256 = await writeRustSrcDevAsset(outputDirectory, async () => ({
        archive: new Uint8Array([byte]),
        cacheArchive: ".rubrc-cache/sysroot/rust-src.tar.vfsbr",
        source: "generated",
      }));
    }
    const assets = [];
    for await (const entry of Deno.readDir(outputDirectory)) {
      if (/^rust-src-[a-f0-9]{64}\.tar\.vfsbr$/.test(entry.name)) {
        assets.push(entry.name);
      }
    }
    assert(assets.length === 3, `retained ${assets.length} archive versions`);
    assert(
      assets.includes(`rust-src-${activeSha256}.tar.vfsbr`),
      "active content-addressed archive was pruned",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development rust-src lifecycle stays ignored and outside production", async () => {
  const rootPackage = JSON.parse(await Deno.readTextFile("package.json"));
  const pagePackage = JSON.parse(await Deno.readTextFile("page/package.json"));
  const ignore = await Deno.readTextFile(".gitignore");
  const prepareSource = await Deno.readTextFile(
    "scripts/prepare_rust_src_dev_asset.ts",
  );

  assert(
    rootPackage.scripts["rust-src:prepare-dev-asset"] ===
      "deno run --no-lock --allow-read --allow-write --allow-run scripts/prepare_rust_src_dev_asset.ts",
    "root development preparation command changed",
  );
  assert(
    pagePackage.scripts.predev ===
      "bun run --cwd .. rust-src:prepare-dev-asset" &&
      pagePackage.scripts.prestart ===
        "bun run --cwd .. rust-src:prepare-dev-asset",
    "page dev/start lifecycle does not prepare the validated asset",
  );
  assert(ignore.split(/\r?\n/).includes(".rubrc-cache/"), ".rubrc-cache is not ignored");
  assert(
    prepareSource.includes("export const DEV_RUST_SRC_DIRECTORY") &&
      prepareSource.includes('".rubrc-cache/dev"') &&
      prepareSource.includes("const { archive } = await prepare()") &&
      prepareSource.includes("rust-src-${sha256}.tar.vfsbr") &&
      prepareSource.includes("DEV_RUST_SRC_RETAINED_ASSETS = 3") &&
      prepareSource.includes("await pruneDevelopmentRustSrcAssets(directory, sha256)") &&
      prepareSource.includes("await Deno.rename(temporaryAsset, assetPath)") &&
      prepareSource.includes("await Deno.rename(temporarySidecar, sidecarPath)"),
    "development writer does not use validated output and atomic sidecar publication",
  );
  assert(
    !rootPackage.scripts["rust-src:prepare-dev-asset"].includes("page/public") &&
      !prepareSource.includes("page/public"),
    "development asset leaks into Vite public assets",
  );
});

Deno.test("Vite development identity and middleware are hash-bound", async () => {
  const vite = await Deno.readTextFile("page/vite.config.ts");

  assert(
    vite.includes("export default defineConfig(async ({ command, isPreview }) =>") &&
      vite.includes(
        'const isDevelopmentServer = command === "serve" && isPreview !== true;',
      ),
    "Vite config is not asynchronous and dev-only",
  );
  assert(
    vite.includes("rust-src.sha256") &&
      vite.includes("rust-src-${sha256}.tar.vfsbr") &&
      vite.includes("developmentRustSrcAsset?.sha256") &&
      vite.includes('process.env.SOURCE_SHA ?? "development"'),
    "Vite source revision does not separate development hash from production SHA",
  );
  assert(
    vite.includes('requestUrl.pathname !== "/rust-src.tar.vfsbr"') &&
      vite.includes('requestUrl.searchParams.get("v") !== asset.sha256') &&
      vite.includes("response.statusCode = 409") &&
      vite.includes(
        'response.setHeader("Content-Type", "application/octet-stream")',
      ) &&
      vite.includes('response.setHeader("Content-Length", String(stat.size))') &&
      vite.includes("await pipeline(file.createReadStream(), response)") &&
      vite.includes("if (response.headersSent)") &&
      vite.includes("response.destroy()") &&
      vite.includes("void serveDevelopmentRustSrcAsset(") &&
      vite.includes(".catch(next)"),
    "Vite middleware is not path-, hash-, MIME-, and error-bound",
  );
  assert(
    !vite.includes("page/public") && !vite.includes("configurePreviewServer"),
    "development middleware leaks into public or preview serving",
  );
  for (const dependency of [
    '"vscode"',
    '"@codingame/monaco-vscode-api"',
    '"@codingame/monaco-vscode-extension-api"',
    '"@codingame/monaco-vscode-extensions-service-override"',
  ]) {
    assert(vite.includes(dependency), `Vite dedupe lost ${dependency}`);
  }
});
```

The first test is the only test that creates generated asset files. It writes under a fresh `Deno.makeTempDir()` path and removes only that path; it never removes `.rubrc-cache/dev` or `.rubrc-cache/sysroot`.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
deno test --no-lock -A \
  scripts/rust_src_dev_asset_test.ts \
  scripts/rust_src_archive_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: FAIL because `scripts/prepare_rust_src_dev_asset.ts` and `writeRustSrcDevAsset` do not exist and the root/page lifecycle and async Vite contracts are absent. Existing archive and browser contracts continue to pass independently.

- [ ] **Step 3: Implement atomic development asset preparation**

Create `scripts/prepare_rust_src_dev_asset.ts` with this complete content:

```ts
import { prepareInstalledRustSrcArchive } from "./rust_src_archive.ts";

export const DEV_RUST_SRC_DIRECTORY = ".rubrc-cache/dev";
export const DEV_RUST_SRC_SIDECAR =
  `${DEV_RUST_SRC_DIRECTORY}/rust-src.sha256`;
export const DEV_RUST_SRC_RETAINED_ASSETS = 3;

async function pruneDevelopmentRustSrcAssets(
  directory: string,
  activeSha256: string,
): Promise<void> {
  const candidates: Array<{ path: string; active: boolean; mtime: number }> = [];
  for await (const entry of Deno.readDir(directory)) {
    const match = /^rust-src-([a-f0-9]{64})\.tar\.vfsbr$/.exec(entry.name);
    if (!entry.isFile || !match) continue;
    const path = `${directory}/${entry.name}`;
    const stat = await Deno.stat(path);
    candidates.push({
      path,
      active: match[1] === activeSha256,
      mtime: stat.mtime?.getTime() ?? 0,
    });
  }
  candidates.sort((left, right) =>
    Number(right.active) - Number(left.active) || right.mtime - left.mtime
  );
  await Promise.all(
    candidates.slice(DEV_RUST_SRC_RETAINED_ASSETS).map((candidate) =>
      Deno.remove(candidate.path).catch(() => undefined)
    ),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function writeRustSrcDevAsset(
  directory = DEV_RUST_SRC_DIRECTORY,
  prepare = prepareInstalledRustSrcArchive,
): Promise<string> {
  const { archive } = await prepare();
  const digest = await crypto.subtle.digest("SHA-256", archive);
  const sha256 = bytesToHex(new Uint8Array(digest));
  const assetPath = `${directory}/rust-src-${sha256}.tar.vfsbr`;
  const sidecarPath = `${directory}/rust-src.sha256`;
  const temporaryAsset = `${assetPath}.${crypto.randomUUID()}.tmp`;
  const temporarySidecar = `${sidecarPath}.${crypto.randomUUID()}.tmp`;

  await Deno.mkdir(directory, { recursive: true });
  try {
    await Deno.writeFile(temporaryAsset, archive);
    await Deno.rename(temporaryAsset, assetPath).catch(async (error) => {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      await Deno.remove(temporaryAsset);
    });
    await Deno.writeTextFile(temporarySidecar, `${sha256}\n`);
    await Deno.rename(temporarySidecar, sidecarPath);
    await pruneDevelopmentRustSrcAssets(directory, sha256);
  } catch (error) {
    await Promise.all([
      Deno.remove(temporaryAsset).catch(() => undefined),
      Deno.remove(temporarySidecar).catch(() => undefined),
    ]);
    throw error;
  }

  return sha256;
}

if (import.meta.main) {
  const sha256 = await writeRustSrcDevAsset();
  console.log(`prepared validated rust-src development asset ${sha256}`);
}
```

The SHA is computed directly from the validated bytes already held by the
generator. Each content-addressed asset and the active sidecar are published by
same-directory rename; concurrent preparation cannot mutate an asset selected
by a running server. Failure exits the root command nonzero before Bun can
launch Vite.

- [ ] **Step 4: Add root and page lifecycle scripts**

In the root `package.json` scripts object, retain `rust-src:prepare-asset` and add the development command immediately after it:

```json
"rust-src:prepare-asset": "deno run --no-lock --allow-read --allow-write --allow-run scripts/prepare_rust_src_asset.ts",
"rust-src:prepare-dev-asset": "deno run --no-lock --allow-read --allow-write --allow-run scripts/prepare_rust_src_dev_asset.ts",
```

In `page/package.json`, replace the complete scripts object with:

```json
"scripts": {
  "prestart": "bun run --cwd .. rust-src:prepare-dev-asset",
  "start": "vite",
  "predev": "bun run --cwd .. rust-src:prepare-dev-asset",
  "dev": "vite",
  "build": "vite build",
  "serve": "vite preview",
  "fmt": "biome format --write ."
},
```

Bun's pre-script lifecycle makes `dev` and `start` stop before `vite` whenever validated preparation fails.

- [ ] **Step 5: Implement the async hash-bound Vite development plugin**

Replace `page/vite.config.ts` with this complete content:

```ts
import { open, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solidPlugin from "vite-plugin-solid";

const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const developmentRustSrcDirectory = fileURLToPath(
  new URL("../.rubrc-cache/dev/", import.meta.url),
);
const developmentRustSrcSidecarPath =
  `${developmentRustSrcDirectory}/rust-src.sha256`;

type DevelopmentRustSrcAsset = {
  path: string;
  sha256: string;
};

async function readDevelopmentRustSrcAsset(): Promise<DevelopmentRustSrcAsset> {
  const sha256 = (await readFile(developmentRustSrcSidecarPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(
      `invalid development rust-src SHA-256 in ${developmentRustSrcSidecarPath}`,
    );
  }
  return {
    path: `${developmentRustSrcDirectory}/rust-src-${sha256}.tar.vfsbr`,
    sha256,
  };
}

function developmentRustSrcPlugin(asset: DevelopmentRustSrcAsset): Plugin {
  return {
    name: "rubrc-development-rust-src",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void serveDevelopmentRustSrcAsset(
          request.url,
          response,
          next,
          asset,
        ).catch(next);
      });
    },
  };
}

async function serveDevelopmentRustSrcAsset(
  rawUrl: string | undefined,
  response: import("node:http").ServerResponse,
  next: (error?: unknown) => void,
  asset: DevelopmentRustSrcAsset,
): Promise<void> {
  if (!rawUrl?.startsWith("/") || rawUrl.startsWith("//")) {
    next();
    return;
  }
  const requestUrl = new URL(rawUrl, "http://localhost");
  if (requestUrl.pathname !== "/rust-src.tar.vfsbr") {
    next();
    return;
  }
  if (requestUrl.searchParams.get("v") !== asset.sha256) {
    response.statusCode = 409;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(
      `rust-src development asset revision mismatch; expected ${asset.sha256}\n`,
    );
    return;
  }

  const file = await open(asset.path, "r");
  try {
    const stat = await file.stat();
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", String(stat.size));
  } catch (error) {
    await file.close();
    throw error;
  }
  try {
    await pipeline(file.createReadStream(), response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    throw error;
  }
}

export default defineConfig(async ({ command, isPreview }) => {
  const isDevelopmentServer = command === "serve" && isPreview !== true;
  const developmentRustSrcAsset = isDevelopmentServer
    ? await readDevelopmentRustSrcAsset()
    : undefined;
  const productionSourceRevision = process.env.SOURCE_SHA ?? "development";
  const sourceRevision =
    developmentRustSrcAsset?.sha256 ?? productionSourceRevision;

  return {
    define: {
      __RUBRC_SOURCE_REVISION__: JSON.stringify(sourceRevision),
      __RUBRC_BUILD_EPOCH__: JSON.stringify(process.env.BUILD_EPOCH ?? "0"),
    },
    resolve: {
      alias: {
        "monaco-editor": "@codingame/monaco-vscode-editor-api",
      },
      dedupe: [
        "vscode",
        "@codingame/monaco-vscode-api",
        "@codingame/monaco-vscode-extension-api",
        "@codingame/monaco-vscode-extensions-service-override",
      ],
    },
    plugins: [
      ...(developmentRustSrcAsset
        ? [developmentRustSrcPlugin(developmentRustSrcAsset)]
        : []),
      solidPlugin(),
      tailwindcss(),
    ],
    optimizeDeps: {
      exclude: ["brotli-dec-wasm"],
      esbuildOptions: {
        plugins: [importMetaUrlPlugin],
      },
    },
    server: {
      port: 3000,
      headers: crossOriginIsolationHeaders,
    },
    preview: { headers: crossOriginIsolationHeaders },
    build: {
      target: "esnext",
      minify: process.env.NODE_ENV === "production" ? true : false,
    },
    worker: {
      format: "es",
    },
    base: "./",
  };
});
```

`isPreview !== true` is required because Vite reports both development and preview as `command === "serve"`; preview must not read the development sidecar or install this middleware. `open()` completes before response headers are sent, so a missing or unreadable archive rejects into `.catch(next)` and cannot fall through as index HTML.

- [ ] **Step 6: Format only Task 2 files**

Run:

```bash
bun x @biomejs/biome@1.9.4 format --write \
  scripts/prepare_rust_src_dev_asset.ts \
  scripts/rust_src_dev_asset_test.ts \
  package.json \
  page/package.json \
  page/vite.config.ts
```

Expected: exit 0; only the five listed Task 2 files are formatted. `.gitignore`, `scripts/prepare_rust_src_asset.ts`, and `page/src/sysroot_archive.ts` remain byte-for-byte unchanged.

- [ ] **Step 7: Run focused Task 2 tests to verify GREEN**

Run:

```bash
deno test --no-lock -A \
  scripts/rust_src_dev_asset_test.ts \
  scripts/rust_src_archive_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: PASS. The direct writer test removes only its temporary directory; the persistent `.rubrc-cache/dev` and `.rubrc-cache/sysroot` paths are untouched by this test command.

- [ ] **Step 8: Verify production SOURCE_SHA, dedupe, and no static dev-asset leakage**

Run from the repository root:

```bash
PRODUCTION_SHA=0123456789abcdef0123456789abcdef01234567
SOURCE_SHA="$PRODUCTION_SHA" BUILD_EPOCH=17 bun run --cwd page build
rg -F "$PRODUCTION_SHA" page/dist/assets
test ! -e page/dist/rust-src.tar.vfsbr
test ! -e page/public/rust-src.tar.vfsbr
```

Expected: the production Vite build exits 0, `rg` finds the exact 40-character `SOURCE_SHA` in a built JavaScript asset, and neither Vite build output nor `page/public` contains a rust-src archive until the existing separate production `rust-src:prepare-asset` command is run. The source-contract test from Step 8 has also verified all four existing `resolve.dedupe` entries.

- [ ] **Step 9: Run the real development preparation/server/identity/Brotli integration**

Run this complete command from the repository root. It intentionally retains the validated `.rubrc-cache/dev` archive and sidecar after stopping Vite:

```bash
set -euo pipefail
TMP_DIR="$(mktemp -d)"
DEV_PID=""
cleanup() {
  if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill "$DEV_PID"
    wait "$DEV_PID" || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

bun run --cwd page dev --host 127.0.0.1 --port 4174 --strictPort \
  >"$TMP_DIR/vite.log" 2>&1 &
DEV_PID=$!

READY=0
for _ in $(seq 1 1200); do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    cat "$TMP_DIR/vite.log"
    exit 1
  fi
  if curl --fail --silent --show-error http://127.0.0.1:4174/ \
    >"$TMP_DIR/index.html"; then
    READY=1
    break
  fi
  sleep 0.25
done
test "$READY" = 1

SHA="$(tr -d '\r\n' < .rubrc-cache/dev/rust-src.sha256)"
test "${#SHA}" = 64
curl --silent --limit-rate 1024 --max-time 0.05 \
  "http://127.0.0.1:4174/rust-src.tar.vfsbr?v=$SHA&build=0" \
  >"$TMP_DIR/aborted.vfsbr" || true
curl --fail --silent --show-error http://127.0.0.1:4174/ \
  >"$TMP_DIR/after-abort.html"
curl --fail --silent --show-error \
  --dump-header "$TMP_DIR/headers" \
  --output "$TMP_DIR/served.vfsbr" \
  "http://127.0.0.1:4174/rust-src.tar.vfsbr?v=$SHA&build=0"

node --input-type=module - "$TMP_DIR/headers" <<'NODE'
import { readFileSync } from "node:fs";
const headers = readFileSync(process.argv[2], "utf8");
if (!/^content-type:\s*application\/octet-stream\s*$/im.test(headers)) {
  throw new Error(`unexpected content type:\n${headers}`);
}
NODE

cmp --silent ".rubrc-cache/dev/rust-src-$SHA.tar.vfsbr" "$TMP_DIR/served.vfsbr"
printf '%s  %s\n' "$SHA" "$TMP_DIR/served.vfsbr" | sha256sum --check --status

node --input-type=module - "$TMP_DIR/served.vfsbr" <<'NODE'
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
const compressed = readFileSync(process.argv[2]);
const decompressed = brotliDecompressSync(compressed);
if (decompressed.byteLength === 0) {
  throw new Error("native Brotli produced an empty rust-src archive");
}
console.log(`native Brotli decoded ${decompressed.byteLength} bytes`);
NODE

STATUS="$(curl --silent --show-error --output "$TMP_DIR/mismatch.txt" \
  --write-out '%{http_code}' \
  'http://127.0.0.1:4174/rust-src.tar.vfsbr?v=wrong&build=0')"
test "$STATUS" = 409

kill "$DEV_PID"
wait "$DEV_PID" || true
DEV_PID=""

bun run --cwd page start --host 127.0.0.1 --port 4175 --strictPort \
  >"$TMP_DIR/vite-start.log" 2>&1 &
DEV_PID=$!
for _ in $(seq 1 1200); do
  if curl --fail --silent --show-error http://127.0.0.1:4175/ \
    >"$TMP_DIR/start-index.html"; then
    break
  fi
  sleep 0.25
done
curl --fail --silent --show-error \
  --output "$TMP_DIR/start-served.vfsbr" \
  "http://127.0.0.1:4175/rust-src.tar.vfsbr?v=$SHA&build=0"
cmp --silent ".rubrc-cache/dev/rust-src-$SHA.tar.vfsbr" \
  "$TMP_DIR/start-served.vfsbr"
```

Expected: `predev` and `prestart` run the real validated generator before Vite
starts; both script names serve bytes identical to the content-addressed file;
the revisioned dev request returns 200 with `application/octet-stream`;
an aborted archive transfer does not crash the Vite server;
`sha256sum` proves sidecar/content identity; Node's native
`brotliDecompressSync` prints a nonzero decoded byte count; and the mismatched
revision returns 409. The trap removes only its `/tmp` files and server process,
not `.rubrc-cache`.

- [ ] **Step 10: Run the exact browser diagnostics regression**

Run:

```bash
bun run test:lsp-browser
```

Expected: exit 0 with final output `browser displayed and cleared rust-analyzer markers`. The production build/preview path still uses `SOURCE_SHA`, existing rust-src production preparation, and existing cache dedupe; browser output contains neither `Brotli decompression failed with code -2` nor an invalid compressed Content-Type error.

- [ ] **Step 11: Run the combined focused regression and inspect the final diff**

Run:

```bash
deno test --no-lock -A \
  lib/src/fetch_with_optional_cache_test.ts \
  lib/src/fetch_compressed_stream_test.ts \
  scripts/rust_src_archive_test.ts \
  scripts/rust_src_dev_asset_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
git diff --check
git status --short
git diff -- \
  scripts/prepare_rust_src_dev_asset.ts \
  scripts/rust_src_dev_asset_test.ts \
  package.json \
  page/package.json \
  page/vite.config.ts
```

Expected: all focused tests pass, `git diff --check` is silent, `.rubrc-cache` and `page/dist` do not appear in status, and Task 2 changes contain no `page/public` output, preview middleware, production `SOURCE_SHA` change, dedupe change, or unrelated edits.

- [ ] **Step 12: Commit Task 2**

Run:

```bash
git add \
  scripts/prepare_rust_src_dev_asset.ts \
  scripts/rust_src_dev_asset_test.ts \
  package.json \
  page/package.json \
  page/vite.config.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: serve validated rust source in development"
```

Expected: the staged-name list contains exactly the five Task 2 files and the commit succeeds. `.gitignore`, `scripts/prepare_rust_src_asset.ts`, `page/src/sysroot_archive.ts`, `.rubrc-cache`, `page/public`, `page/dist`, and unrelated working-tree changes are not staged.

## Final Verification

- [ ] Confirm Task 1 maps every cache state: accepted hit, rejected hit plus successful delete, rejected hit plus failed delete, open failure, match failure, valid network put, invalid network no-put, and put failure.
- [ ] Confirm direct compressed-response tests reject missing Content-Type and cover the three accepted binary types, media-type parameters/case, HTML, JSON, non-OK status, body cancellation, body-access ordering, and decompressor-call ordering without importing Wasm.
- [ ] Confirm Task 2 maps validated generation failure, exact cache/sidecar paths, atomic sidecar publication, Bun `predev`/`prestart`, startup hash validation, exact `v` matching, 409 mismatch, `next(error)` file failures, binary MIME, and no preview/public/build leakage.
- [ ] Confirm the real dev command proves preparation, Vite serving, content type, response/file byte identity, sidecar SHA identity, native Brotli decompression, and mismatch rejection while retaining the persistent validated cache.
- [ ] Confirm production `SOURCE_SHA`, `BUILD_EPOCH`, browser diagnostics, rust-src cache pruning/dedupe in `page/src/sysroot_archive.ts`, and all existing Vite `resolve.dedupe` entries remain unchanged.
- [ ] Confirm both commits stage only their enumerated source/test/config files and `git diff --check` is silent.
