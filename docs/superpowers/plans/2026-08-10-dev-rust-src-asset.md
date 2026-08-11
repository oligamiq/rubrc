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
- Remove abandoned development `.tmp` files only after they are one hour old; ignore only concurrent `NotFound` races and propagate other filesystem errors.
- In development, `__RUBRC_SOURCE_REVISION__` and the middleware's required `v` query must use the same lowercase 64-character content SHA-256 read once at Vite startup.
- Preserve production `process.env.SOURCE_SHA ?? "development"`, `process.env.BUILD_EPOCH ?? "0"`, and the existing `resolve.dedupe` entries unchanged.
- Serve `/rust-src.tar.vfsbr` only for `GET` and `HEAD` when `v` exactly matches the startup SHA-256; return `409` for missing or mismatched identity, and pass genuine missing/unreadable file errors before headers to `next(error)` rather than Vite's SPA fallback.
- Set valid development asset responses to `Content-Type: application/octet-stream` and `Cache-Control: public, max-age=31536000, immutable`; `HEAD` returns the same status and headers as `GET` with no body.
- Treat client aborts before or after headers as owned stream cleanup, not Vite middleware errors or log noise.
- Extend the optional cache without adding global request coalescing; abort signals and streaming response clones remain owned by the existing single rust-src loader.
- A valid cache hit is returned unchanged; an invalid hit is deleted before a network retry; an invalid successful network response is returned but not cached.
- Cache open, match, delete, and put errors remain best-effort and must never replace the network response.
- Determine cache eligibility from `RequestInit.method` before `Request.method`; every non-GET effective method bypasses CacheStorage without cloning a request body, while every GET cache operation uses the derived `new Request(input, init)` key.
- Cancel invalid cached bodies before deletion, cancel cached/network bodies when `acceptResponse` throws before rethrowing the same error, and cancel the cache clone when `cache.put` rejects.
- `fetch_compressed_stream` accepts only `application/octet-stream`, `application/brotli`, and `application/x-brotli`, allowing normal media-type parameters and case normalization; a missing header and every other type are rejected before body access or decompression.
- Preserve the existing non-OK HTTP error path and allow corrupt binary-looking bytes to reach the Brotli decoder so its detailed error remains observable.
- Use Deno for all new TypeScript tests; the direct compressed-response tests must inject a transform and must not initialize or decode with the real Wasm module.
- Make exactly one commit per task, stage only the task's listed files, and do not include unrelated working-tree changes.
- Run the browser diagnostics harness with Bun and a test-only static server that assigns `application/octet-stream` to `.vfsbr`; do not add preview middleware or relax strict MIME.
- Format only files listed in the active task with `bun x @biomejs/biome@1.9.4 format --write`; never run repository-wide formatting.
- Do not modify or regenerate `deno.lock`.
- A test may remove only the temporary directory it created with `Deno.makeTempDir`; integration cleanup must not delete the persistent validated `.rubrc-cache` archive, sidecar, or `.rubrc-cache/sysroot` cache.

---

## File Structure

- `lib/src/fetch_with_optional_cache.ts`: owns effective-method bypass, derived GET request keys, cache open/match/delete/put best-effort behavior, acceptance-error cancellation, and the optional `acceptResponse(response)` policy hook.
- `lib/src/fetch_with_optional_cache_test.ts`: directly verifies cache recovery, RequestInit method/key semantics, invalid-network non-caching, body ownership, and all cache-operation failure paths.
- `lib/src/fetch_compressed_stream.ts`: owns strict compressed Content-Type acceptance, descriptive errors, HTTP/body ordering, and the injected decompression seam without importing Wasm.
- `lib/src/fetch_compressed_stream_test.ts`: directly verifies HTML/JSON rejection before body/decompress and all accepted MIME cases with an identity transform.
- `lib/src/brotli_stream.ts`: retains the public `fetch_compressed_stream(url, signal)` API and supplies the real CacheStorage, fetch, logger, and Wasm transform to the tested seam.
- `scripts/lsp_browser_diagnostics_contract_test.ts`: keeps a source-level contract that the public Brotli wrapper delegates to the directly tested optional-cache fetch seam.
- `scripts/prepare_rust_src_dev_asset.ts`: writes an ignored immutable validated development archive, atomically publishes its active SHA-256 sidecar, retains active plus two prior archives, and prunes only stale temporary files with explicit filesystem error ownership.
- `scripts/rust_src_dev_asset_test.ts`: directly tests development preparation/pruning in temporary directories and enforces package, Vite, ignore, production-identity, dedupe, and no-public-leakage source contracts.
- `scripts/lsp_browser_static_server.mjs`: exports a root-confined GET/HEAD static server for `page/dist` with SPA fallback, explicit MIME types, quiet abort handling, and COOP/COEP.
- `scripts/lsp_browser_static_server_test.ts`: directly tests path confinement, methods, HEAD behavior, fallback, isolation headers, MIME types, and harness/package contracts.
- `scripts/lsp_browser_diagnostics_test.mjs`: starts and closes the in-process test static server instead of spawning Vite preview.
- `package.json`: exposes the root `rust-src:prepare-dev-asset` command.
- `page/package.json`: runs root development archive preparation through `predev` and `prestart`.
- `page/vite.config.ts`: asynchronously reads the sidecar for non-preview serve mode, injects its hash, and installs the identity-checked middleware only in development.
- `.gitignore`: already ignores `.rubrc-cache/`; it is verified but not modified.

### Task 1: Optional-Cache Recovery And Strict Brotli Response Boundary

**Files:**
- Modify: `lib/src/fetch_with_optional_cache.ts:1-84`
- Modify: `lib/src/fetch_with_optional_cache_test.ts:47-724`
- Create: `lib/src/fetch_compressed_stream.ts`
- Create: `lib/src/fetch_compressed_stream_test.ts`
- Modify: `lib/src/brotli_stream.ts:5,49-69`
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts:137-150`

**Interfaces:**
- Consumes: browser `CacheStorage.open(name)`, `Cache.match(input)`, `Cache.delete(input)`, `Cache.put(input, response)`, `fetch(input, init)`, and the existing `get_brotli_decompress_stream(): Promise<TransformStream<Uint8Array, Uint8Array>>`.
- Produces: exported `FetchInput = string | URL | Request`; exported `CacheBoundary` with `match`, `delete`, and `put`; exported `FetchWithOptionalCacheDependencies` with optional `acceptResponse?: (response: Response) => boolean`; effective method `init?.method ?? Request.method ?? "GET"`; derived GET key `new Request(input, init)`; `fetchWithOptionalCache(...): Promise<Response>`; `isAcceptedCompressedResponse(response): boolean` rejecting missing/malformed types; `fetchCompressedStream(url, signal, dependencies): Promise<ReadableStream<Uint8Array>>`; unchanged public `fetch_compressed_stream(url, signal): Promise<ReadableStream<Uint8Array>>`.

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

Replace the existing `cache put rejection preserves the fetched response body`
test with the committed ownership regression:

```ts
Deno.test("cache put rejection preserves the fetched response body", async () => {
  const expected = new Uint8Array([0, 1, 2, 127, 255]);
  const cacheError = new Error("cache failed");
  const reportedErrors: unknown[] = [];
  let cacheCloneCancelCalls = 0;

  const response = await fetchWithOptionalCache(
    "https://example.test/asset.br",
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
            put(_input, cacheResponse) {
              const cacheBody = cacheResponse.body;
              assert(cacheBody !== null, "cached clone had no body");
              const cancel = cacheBody.cancel.bind(cacheBody);
              cacheBody.cancel = async (reason) => {
                cacheCloneCancelCalls += 1;
                await cancel(reason);
              };
              return Promise.reject(cacheError);
            },
          };
        },
      },
      async fetch() {
        return new Response(expected);
      },
      reportCacheError(error) {
        reportedErrors.push(error);
      },
    },
  );

  assertBytesEqual(new Uint8Array(await response.arrayBuffer()), expected);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(reportedErrors[0] === cacheError, "reported the wrong cache error");
  assert(cacheCloneCancelCalls === 1, "cached clone was not canceled once");
});
```

Append these direct behavior tests to `lib/src/fetch_with_optional_cache_test.ts`:

```ts
Deno.test("invalid cache hit is deleted and replaced from the network", async () => {
  const input = "https://example.test/rust-src.tar.vfsbr?v=valid";
  let cachedBodyCancelCalls = 0;
  const cachedResponse = new Response(
    new ReadableStream({
      cancel() {
        cachedBodyCancelCalls += 1;
      },
    }),
    { headers: { "content-type": "text/html" } },
  );
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
            assert(
              cachedBodyCancelCalls === 1,
              "invalid cached body was not canceled before deletion",
            );
            deleted.push(deletedInput);
            return true;
          },
          async put(putInput, putResponse) {
            assert(
              putInput instanceof Request && putInput.url === input,
              "network response used the wrong cache key",
            );
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
  assert(
    deleted.length === 1 &&
      deleted[0] instanceof Request &&
      deleted[0].url === input,
    "invalid hit was not deleted",
  );
  assert(fetchCalls === 1, "network was not fetched exactly once");
  assert(putCalls === 1, "valid replacement was not cached exactly once");
  assert(cachedBodyCancelCalls === 1, "invalid cached body cancellation changed");
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

Deno.test("init method overrides a GET Request when bypassing CacheStorage", async () => {
  const input = new Request("https://example.test/request-upload");
  const init = { method: "post", body: "overridden-request-body" };
  let fetchCalls = 0;

  await fetchWithOptionalCache(input, init, {
    cacheStorage: {
      open() {
        throw new Error("overridden non-GET Request must not open CacheStorage");
      },
    },
    async fetch(fetchInput, fetchInit) {
      assert(fetchInput === input, "network Request identity changed");
      assert(fetchInit === init, "network override identity changed");
      fetchCalls += 1;
      return new Response(new Uint8Array([1]));
    },
    reportCacheError(error) {
      throw error;
    },
  });

  assert(fetchCalls === 1, "overridden Request was not fetched exactly once");
});

Deno.test("a POST Request overridden to GET uses a derived GET cache key", async () => {
  const input = new Request("https://example.test/request-cache-key", {
    method: "POST",
  });
  const init = {
    method: "GET",
    headers: { "x-rubrc-cache-variant": "strict" },
    credentials: "include" as RequestCredentials,
  };
  const cachedResponse = new Response(new Uint8Array([1]));

  const response = await fetchWithOptionalCache(input, init, {
    cacheStorage: {
      async open() {
        return {
          async match(cacheInput) {
            assert(cacheInput instanceof Request, "cache key was not a Request");
            assert(cacheInput !== input, "cache key reused the POST Request");
            assert(cacheInput.method === "GET", "cache key method was not GET");
            assert(cacheInput.url === input.url, "cache key URL changed");
            assert(
              cacheInput.headers.get("x-rubrc-cache-variant") === "strict",
              "cache key omitted init headers",
            );
            assert(
              cacheInput.credentials === "include",
              "cache key omitted init credentials",
            );
            return cachedResponse;
          },
          async delete() {
            throw new Error("accepted cache hit must not be deleted");
          },
          async put() {
            throw new Error("accepted cache hit must not be replaced");
          },
        };
      },
    },
    async fetch() {
      throw new Error("accepted cache hit must not fetch the network");
    },
    reportCacheError(error) {
      throw error;
    },
  });

  assert(response === cachedResponse, "derived GET cache hit identity changed");
});

Deno.test("acceptResponse errors cancel cached and network bodies", async () => {
  for (const source of ["cached", "network"] as const) {
    const predicateError = new Error(`${source} predicate failed`);
    let cancelCalls = 0;
    let deleteCalls = 0;
    let putCalls = 0;
    const candidate = new Response(
      new ReadableStream({
        cancel() {
          cancelCalls += 1;
        },
      }),
    );
    let rejection: unknown;

    try {
      await fetchWithOptionalCache(
        `https://example.test/${source}-predicate-error`,
        undefined,
        {
          cacheStorage: {
            async open() {
              return {
                async match() {
                  return source === "cached" ? candidate : undefined;
                },
                async delete() {
                  deleteCalls += 1;
                  return true;
                },
                async put() {
                  putCalls += 1;
                },
              };
            },
          },
          async fetch() {
            if (source === "cached") {
              throw new Error("cached predicate error must not fetch");
            }
            return candidate;
          },
          acceptResponse() {
            throw predicateError;
          },
          reportCacheError(error) {
            throw error;
          },
        },
      );
    } catch (error) {
      rejection = error;
    }

    assert(rejection === predicateError, `${source} predicate error identity changed`);
    assert(cancelCalls === 1, `${source} predicate body was not canceled once`);
    assert(deleteCalls === 0, `${source} predicate error deleted a cache entry`);
    assert(putCalls === 0, `${source} predicate error cached a response`);
  }
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

function cancellableResponse(
  bytes: Uint8Array,
  init: ResponseInit,
  onCancel: () => void,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        onCancel();
      },
    }),
    init,
  );
}

Deno.test("invalid and malformed MIME types cancel before decompression", async () => {
  for (const contentType of [
    "text/html; charset=utf-8",
    "application/json",
    "image/png",
    "application/octet-stream, text/html",
    "application/octet-stream; profile=archive, text/html",
    "application/octet-stream;",
    "application/octet-stream; charset",
  ]) {
    const url = `https://example.test/rust-src.tar.vfsbr?v=${encodeURIComponent(contentType)}`;
    let cancelCalls = 0;
    let decompressCalls = 0;
    const response = cancellableResponse(
      new Uint8Array([1, 2, 3]),
      { headers: { "content-type": contentType } },
      () => {
        cancelCalls += 1;
      },
    );
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
    assert(cancelCalls === 1, `${contentType} body was not canceled once`);
    assert(decompressCalls === 0, `${contentType} reached decompression`);
  }
});

Deno.test("missing Content-Type is canceled, rejected, and never cached", async () => {
  const url = "https://example.test/rust-src.tar.vfsbr?v=missing-type";
  let cancelCalls = 0;
  let decompressCalls = 0;
  let putCalls = 0;
  let rejection: unknown;

  try {
    await fetchCompressedStream(url, undefined, {
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
        return cancellableResponse(new Uint8Array([1, 2, 3]), {}, () => {
          cancelCalls += 1;
        });
      },
      reportCacheError(error) {
        throw error;
      },
      async getDecompressStream() {
        decompressCalls += 1;
        return new TransformStream<Uint8Array, Uint8Array>();
      },
    });
  } catch (error) {
    rejection = error;
  }

  assert(rejection instanceof Error, "missing Content-Type did not reject");
  assert(rejection.message.includes(url), "missing header error omitted the URL");
  assert(
    rejection.message.includes("missing Content-Type"),
    "missing header error is unclear",
  );
  assert(cancelCalls === 1, "missing Content-Type body was not canceled once");
  assert(decompressCalls === 0, "missing Content-Type reached decompression");
  assert(putCalls === 0, "missing Content-Type response was cached");
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
    const stream = await fetchCompressedStream(
      "https://example.test/rust-src.tar.vfsbr?v=accepted",
      undefined,
      {
        async fetch() {
          return new Response(expected, {
            headers: { "content-type": contentType },
          });
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

Deno.test("decompressor initialization errors cancel the accepted body", async () => {
  const initializationError = new Error("decompressor initialization failed");
  let cancelCalls = 0;
  let rejection: unknown;

  try {
    await fetchCompressedStream(
      "https://example.test/rust-src.tar.vfsbr?v=decompressor-error",
      undefined,
      {
        async fetch() {
          return cancellableResponse(
            new Uint8Array([1, 2, 3]),
            { headers: { "content-type": "application/octet-stream" } },
            () => {
              cancelCalls += 1;
            },
          );
        },
        reportCacheError() {},
        async getDecompressStream() {
          throw initializationError;
        },
      },
    );
  } catch (error) {
    rejection = error;
  }

  assert(rejection === initializationError, "initialization error identity changed");
  assert(cancelCalls === 1, "accepted response body was not canceled once");
});

Deno.test("non-OK responses cancel before retaining the HTTP failure path", async () => {
  let cancelCalls = 0;
  let decompressCalls = 0;
  let rejection: unknown;
  try {
    await fetchCompressedStream(
      "https://example.test/rust-src.tar.vfsbr?v=missing",
      undefined,
      {
        async fetch() {
          return cancellableResponse(
            new TextEncoder().encode("missing"),
            { status: 404, headers: { "content-type": "text/html" } },
            () => {
              cancelCalls += 1;
            },
          );
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
  assert(cancelCalls === 1, "non-OK response body was not canceled once");
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
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "GET") {
    return await fetch(input, init);
  }
  if (!cacheStorage) return await fetch(input, init);
  const cacheInput = new Request(input, init);
  const responseIsAccepted = async (response: Response): Promise<boolean> => {
    try {
      return acceptResponse(response);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  };

  let cache: CacheBoundary;
  try {
    cache = await cacheStorage.open("rubrc-assets-v1");
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  let cachedResponse: Response | undefined;
  try {
    cachedResponse = await cache.match(cacheInput);
  } catch (error) {
    reportCacheError(error);
    return await fetch(input, init);
  }

  if (cachedResponse) {
    if (cachedResponse.ok && (await responseIsAccepted(cachedResponse))) {
      return cachedResponse;
    }
    await cachedResponse.body?.cancel().catch(() => undefined);
    try {
      await cache.delete(cacheInput);
    } catch (error) {
      reportCacheError(error);
    }
  }

  const response = await fetch(input, init);
  if (response.ok && (await responseIsAccepted(response))) {
    const cacheResponse = response.clone();
    void cache.put(cacheInput, cacheResponse).catch(async (error) => {
      await cacheResponse.body?.cancel().catch(() => undefined);
      reportCacheError(error);
    });
  }
  return response;
}
```

This deliberately keeps open/match fallback behavior unchanged, uses the effective
`RequestInit` method before touching CacheStorage, derives one GET `Request` key
for match/delete/put, retries after a rejected hit even if deletion fails, and
cancels only the body branch owned by a rejected hit, thrown predicate, or failed
cache clone.

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
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type FetchCompressedStreamDependencies = Omit<
  FetchWithOptionalCacheDependencies,
  "acceptResponse"
> & {
  getDecompressStream(): Promise<TransformStream<Uint8Array, Uint8Array>>;
};

function mediaType(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null || contentType.includes(",")) return null;

  const [rawType, ...rawParameters] = contentType.split(";");
  const typeParts = rawType.trim().split("/");
  if (
    typeParts.length !== 2 ||
    !HTTP_TOKEN.test(typeParts[0]) ||
    !HTTP_TOKEN.test(typeParts[1])
  ) {
    return null;
  }
  for (const rawParameter of rawParameters) {
    const separator = rawParameter.indexOf("=");
    if (separator < 1) return null;
    const name = rawParameter.slice(0, separator).trim();
    const value = rawParameter.slice(separator + 1).trim();
    if (!HTTP_TOKEN.test(name) || !HTTP_TOKEN.test(value)) return null;
  }

  return typeParts.join("/").toLowerCase();
}

export function isAcceptedCompressedResponse(response: Response): boolean {
  const type = mediaType(response);
  return type !== null && ACCEPTED_COMPRESSED_CONTENT_TYPES.has(type);
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
  const response = await fetchWithOptionalCache(
    url,
    signal === undefined ? undefined : { signal },
    {
      cacheStorage: dependencies.cacheStorage,
      fetch: dependencies.fetch,
      reportCacheError: dependencies.reportCacheError,
      acceptResponse: isAcceptedCompressedResponse,
    },
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Failed to fetch wasm");
  }
  if (!isAcceptedCompressedResponse(response)) {
    const contentType = response.headers.get("content-type");
    await response.body?.cancel().catch(() => undefined);
    const reason =
      contentType === null
        ? "missing Content-Type"
        : `unsupported Content-Type ${JSON.stringify(contentType)}`;
    throw new Error(
      `Invalid compressed asset response for ${requestUrl(url)}: ${reason}`,
    );
  }
  if (!response.body) {
    throw new Error("No body in response");
  }

  let decompressStream: TransformStream<Uint8Array, Uint8Array>;
  try {
    decompressStream = await dependencies.getDecompressStream();
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  return response.body.pipeThrough(decompressStream);
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

Expected: PASS. Effective non-GET methods bypass CacheStorage, derived GET keys
include `RequestInit`, cache open/match/delete/put failures retain their defined
fallbacks, owned bodies/clones are canceled on rejection, invalid network
HTML/JSON/missing MIME are not cached, the three accepted binary types reach only
the injected transform, and the HTTP failure assertion remains
`Failed to fetch wasm`.

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
- Modify: `page/vite.config.ts:1-151`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs:1-62,372-387`
- Create: `scripts/lsp_browser_static_server.mjs`
- Create: `scripts/lsp_browser_static_server_test.ts`
- Verify only: `.gitignore:7`
- Verify only: `page/src/sysroot_archive.ts:23-47,114-127`

**Interfaces:**
- Consumes: validated `prepareInstalledRustSrcArchive`, Deno WebCrypto SHA-256, POSIX same-directory replacement `Deno.rename`, Bun pre-script lifecycle, Vite `ConfigEnv.isPreview`, Node `FileHandle.createReadStream()`, and Node HTTP `Server`.
- Produces: `DEV_RUST_SRC_DIRECTORY = ".rubrc-cache/dev"`; immutable `rust-src-<sha256>.tar.vfsbr`; active `rust-src.sha256`; `DevelopmentRustSrcPruneDependencies`; exported `pruneDevelopmentRustSrcAssets(directory, activeSha256, dependencies?): Promise<void>`; `writeRustSrcDevAsset(directory?, prepare?): Promise<string>` returning the lowercase SHA-256; root `rust-src:prepare-dev-asset`; page `predev`/`prestart`; dev-only `__RUBRC_SOURCE_REVISION__ = <sidecar SHA-256>`; matching GET/HEAD response `200 application/octet-stream` with immutable caching and `409 text/plain` otherwise.
- Produces for acceptance: `resolveStaticPath(rootDirectory, pathname): string | null`; `createBrowserStaticServer(rootDirectory?): Server`; `startBrowserStaticServer(options?): Promise<Server>`; `closeBrowserStaticServer(server?): Promise<void>`; Bun-executed browser harness; and root-confined test-only `page/dist` server with GET/HEAD, COOP/COEP, SPA fallback, explicit JS/CSS/Wasm/HTML MIME, and `.vfsbr` `application/octet-stream`.

- [ ] **Step 1: Add the failing direct preparation and lifecycle/source contract tests**

Create `scripts/rust_src_dev_asset_test.ts` with this complete content:

```ts
/// <reference lib="deno.ns" />

import {
  pruneDevelopmentRustSrcAssets,
  writeRustSrcDevAsset,
} from "./prepare_rust_src_dev_asset.ts";

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

Deno.test("development pruning removes only temporary files older than one hour", async () => {
  const directory = await Deno.makeTempDir();
  const oldTemporary = `${directory}/rust-src-old.tmp`;
  const recentTemporary = `${directory}/rust-src-recent.tmp`;
  try {
    await Deno.writeFile(oldTemporary, new Uint8Array([1]));
    await Deno.writeFile(recentTemporary, new Uint8Array([2]));
    const now = Date.now();
    await Deno.utime(
      oldTemporary,
      new Date(now - 3_600_001),
      new Date(now - 3_600_001),
    );
    await Deno.utime(
      recentTemporary,
      new Date(now - 3_599_999),
      new Date(now - 3_599_999),
    );

    await pruneDevelopmentRustSrcAssets(
      directory,
      "a".repeat(64),
      undefined,
    );

    let oldExists = true;
    try {
      await Deno.stat(oldTemporary);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      oldExists = false;
    }
    assert(!oldExists, "temporary file older than one hour was retained");
    assert(
      (await Deno.stat(recentTemporary)).isFile,
      "temporary file younger than one hour was removed",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development pruning ignores only NotFound stat and remove races", async () => {
  const entry: Deno.DirEntry = {
    name: "abandoned.tmp",
    isFile: true,
    isDirectory: false,
    isSymlink: false,
  };
  const entries = async function* () {
    yield entry;
  };

  for (const operation of ["stat", "remove"] as const) {
    for (const error of [
      new Deno.errors.NotFound("concurrent removal"),
      new Deno.errors.PermissionDenied("permission denied"),
    ]) {
      let rejection: unknown;
      try {
        await pruneDevelopmentRustSrcAssets(
          "/virtual/dev",
          "a".repeat(64),
          {
            readDir: entries,
            async stat() {
              if (operation === "stat") throw error;
              return { mtime: new Date(0) } as Deno.FileInfo;
            },
            async remove() {
              if (operation === "remove") throw error;
            },
            now: () => 3_600_001,
          },
        );
      } catch (caught) {
        rejection = caught;
      }

      if (error instanceof Deno.errors.NotFound) {
        assert(rejection === undefined, `${operation} NotFound was propagated`);
      } else {
        assert(rejection === error, `${operation} filesystem error was hidden`);
      }
    }
  }
});

Deno.test("same-hash replacement requires a regular destination", async () => {
  const directory = await Deno.makeTempDir();
  const outputDirectory = `${directory}/dev`;
  const archive = new Uint8Array([4, 5, 6]);
  const prepare = async () => ({
    archive,
    cacheArchive: ".rubrc-cache/sysroot/rust-src.tar.vfsbr",
    source: "cache" as const,
  });
  try {
    const sha256 = await writeRustSrcDevAsset(outputDirectory, prepare);
    const repeatedSha256 = await writeRustSrcDevAsset(outputDirectory, prepare);
    assert(repeatedSha256 === sha256, "same-hash POSIX replacement changed identity");
    assert(
      (await Deno.stat(`${outputDirectory}/rust-src-${sha256}.tar.vfsbr`)).isFile,
      "same-hash destination stopped being a regular file",
    );

    const emptySha256 =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const blockingDirectory =
      `${outputDirectory}/rust-src-${emptySha256}.tar.vfsbr`;
    await Deno.mkdir(blockingDirectory);
    let rejection: unknown;
    try {
      await writeRustSrcDevAsset(outputDirectory, async () => ({
        archive: new Uint8Array(),
        cacheArchive: ".rubrc-cache/sysroot/rust-src.tar.vfsbr",
        source: "cache",
      }));
    } catch (error) {
      rejection = error;
    }
    assert(rejection instanceof Error, "non-file destination was accepted");
    assert(
      rejection.message.includes("not a regular file"),
      "non-file destination error was unclear",
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
      prepareSource.includes("DEV_RUST_SRC_TMP_MAX_AGE_MS = 60 * 60 * 1_000") &&
      prepareSource.includes("await Deno.rename(temporaryAsset, assetPath)") &&
      prepareSource.includes("await Deno.rename(temporarySidecar, sidecarPath)") &&
      !prepareSource.includes("Deno.errors.AlreadyExists"),
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
      vite.includes('request.method !== "GET" && request.method !== "HEAD"') &&
      vite.includes('requestUrl.searchParams.get("v") !== asset.sha256') &&
      vite.includes("response.statusCode = 409") &&
      vite.includes(
        'response.setHeader("Content-Type", "application/octet-stream")',
      ) &&
      vite.includes('response.setHeader("Content-Length", String(stat.size))') &&
      vite.includes('"Cache-Control"') &&
      vite.includes('"public, max-age=31536000, immutable"') &&
      vite.includes('request.method === "HEAD"') &&
      vite.includes("stream = file.createReadStream()") &&
      vite.includes("await pipeline(stream, response)") &&
      vite.includes("if (response.destroyed)") &&
      vite.includes("void serveDevelopmentRustSrcAsset(") &&
      vite.includes("if (!response.destroyed) next(error)"),
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

Every direct filesystem test writes under its own `Deno.makeTempDir()` path and
removes only that path; no test removes `.rubrc-cache/dev` or
`.rubrc-cache/sysroot`.

- [ ] **Step 2: Add failing direct static-server and harness contracts**

Create `scripts/lsp_browser_static_server_test.ts` with this complete content:

```ts
/// <reference lib="deno.ns" />

import { resolve } from "node:path";
import {
  closeBrowserStaticServer,
  resolveStaticPath,
  startBrowserStaticServer,
} from "./lsp_browser_static_server.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("browser static server confines paths and serves GET/HEAD with explicit MIME", async () => {
  const directory = await Deno.makeTempDir();
  const assets = `${directory}/assets`;
  await Deno.mkdir(assets);
  await Deno.writeTextFile(`${directory}/index.html`, "<main>rubrc</main>");
  await Deno.writeTextFile(`${assets}/app.js`, "export const ready = true;");
  await Deno.writeTextFile(`${assets}/app.css`, "main { color: green; }");
  await Deno.writeFile(`${assets}/worker.wasm`, new Uint8Array([0, 97, 115, 109]));
  await Deno.writeFile(`${directory}/rust-src.tar.vfsbr`, new Uint8Array([1, 2, 3]));
  const server = await startBrowserStaticServer({
    rootDirectory: directory,
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const address = server.address();
    assert(address !== null && typeof address === "object", "server has no TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    for (const [path, contentType] of [
      ["/", "text/html; charset=utf-8"],
      ["/assets/app.js", "text/javascript; charset=utf-8"],
      ["/assets/app.css", "text/css; charset=utf-8"],
      ["/assets/worker.wasm", "application/wasm"],
      ["/rust-src.tar.vfsbr", "application/octet-stream"],
    ]) {
      const response = await fetch(`${base}${path}`);
      assert(response.status === 200, `${path} returned ${response.status}`);
      assert(
        response.headers.get("content-type") === contentType,
        `${path} returned ${response.headers.get("content-type")}`,
      );
      assert(
        response.headers.get("cross-origin-embedder-policy") === "require-corp" &&
          response.headers.get("cross-origin-opener-policy") === "same-origin",
        `${path} omitted cross-origin isolation`,
      );
      await response.body?.cancel();
    }

    const head = await fetch(`${base}/rust-src.tar.vfsbr`, { method: "HEAD" });
    assert(head.status === 200, `HEAD returned ${head.status}`);
    assert(head.headers.get("content-length") === "3", "HEAD omitted content length");
    assert((await head.arrayBuffer()).byteLength === 0, "HEAD returned a body");

    const fallback = await fetch(`${base}/deep/client/route`);
    assert(fallback.status === 200, "SPA fallback did not return 200");
    assert(
      fallback.headers.get("content-type") === "text/html; charset=utf-8" &&
        (await fallback.text()) === "<main>rubrc</main>",
      "SPA fallback did not serve index.html",
    );

    const post = await fetch(`${base}/rust-src.tar.vfsbr`, { method: "POST" });
    assert(post.status === 405, `POST returned ${post.status}`);
    assert(post.headers.get("allow") === "GET, HEAD", "405 omitted Allow header");
  } finally {
    await closeBrowserStaticServer(server);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("browser static path resolution rejects traversal", () => {
  const root = resolve("/tmp/rubrc-static-root");
  assert(
    resolveStaticPath(root, "/assets/app.js") === resolve(root, "assets/app.js"),
    "normal static path changed",
  );
  for (const path of [
    "/../outside.txt",
    "/%2e%2e%2foutside.txt",
    "/..\\outside.txt",
    "/%00outside.txt",
  ]) {
    assert(resolveStaticPath(root, path) === null, `${path} escaped static root`);
  }
});

Deno.test("browser diagnostics uses the Bun static server without changing Vite preview", async () => {
  const rootPackage = JSON.parse(await Deno.readTextFile("package.json"));
  const harness = await Deno.readTextFile("scripts/lsp_browser_diagnostics_test.mjs");
  const vite = await Deno.readTextFile("page/vite.config.ts");

  assert(
    rootPackage.scripts["test:lsp-browser"] ===
      "VITE_RUBRC_LSP_TEST=1 bun run --cwd page build && bun run vfs:prepare:prod && bun run rust-src:prepare-asset && bun scripts/lsp_browser_diagnostics_test.mjs",
    "browser diagnostics is not executed by Bun",
  );
  assert(
    harness.includes('from "./lsp_browser_static_server.mjs"') &&
      harness.includes("await startBrowserStaticServer(") &&
      harness.includes("await closeBrowserStaticServer(staticServer)") &&
      !harness.includes('from "node:child_process"') &&
      !harness.includes('"serve"'),
    "browser harness still owns a Vite preview child",
  );
  assert(
    vite.includes("preview: { headers: crossOriginIsolationHeaders }") &&
      !vite.includes("configurePreviewServer"),
    "production Vite preview configuration changed",
  );
});
```

- [ ] **Step 3: Run the focused tests to verify RED**

Run:

```bash
deno test --no-lock -A \
  scripts/rust_src_dev_asset_test.ts \
  scripts/lsp_browser_static_server_test.ts \
  scripts/rust_src_archive_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: FAIL because pruning lacks the injectable/error-aware boundary and stale-temp behavior, the Vite GET/HEAD/immutable/abort contracts are absent, `scripts/lsp_browser_static_server.mjs` is missing, the harness still spawns preview, and the root runner still invokes Node. Existing archive and browser contracts continue to pass independently.

- [ ] **Step 4: Implement atomic development asset preparation and exact pruning ownership**

Create `scripts/prepare_rust_src_dev_asset.ts` with this complete content:

```ts
import { prepareInstalledRustSrcArchive } from "./rust_src_archive.ts";

export const DEV_RUST_SRC_DIRECTORY = ".rubrc-cache/dev";
export const DEV_RUST_SRC_SIDECAR =
  `${DEV_RUST_SRC_DIRECTORY}/rust-src.sha256`;
export const DEV_RUST_SRC_RETAINED_ASSETS = 3;
export const DEV_RUST_SRC_TMP_MAX_AGE_MS = 60 * 60 * 1_000;

export type DevelopmentRustSrcPruneDependencies = {
  readDir(path: string): AsyncIterable<Deno.DirEntry>;
  stat(path: string): Promise<Deno.FileInfo>;
  remove(path: string): Promise<void>;
  now(): number;
};

const defaultPruneDependencies: DevelopmentRustSrcPruneDependencies = {
  readDir: (path) => Deno.readDir(path),
  stat: (path) => Deno.stat(path),
  remove: (path) => Deno.remove(path),
  now: () => Date.now(),
};

async function statIfPresent(
  path: string,
  dependencies: DevelopmentRustSrcPruneDependencies,
): Promise<Deno.FileInfo | null> {
  try {
    return await dependencies.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function removeIfPresent(
  path: string,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  try {
    await remove(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

export async function pruneDevelopmentRustSrcAssets(
  directory: string,
  activeSha256: string,
  dependencies: DevelopmentRustSrcPruneDependencies = defaultPruneDependencies,
): Promise<void> {
  const priorArchives: Array<{ path: string; mtime: number }> = [];
  for await (const entry of dependencies.readDir(directory)) {
    if (!entry.isFile) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.name.endsWith(".tmp")) {
      const stat = await statIfPresent(path, dependencies);
      const mtime =
        stat?.mtime?.getTime() ?? stat?.birthtime?.getTime();
      if (
        mtime !== undefined &&
        dependencies.now() - mtime > DEV_RUST_SRC_TMP_MAX_AGE_MS
      ) {
        await removeIfPresent(path, dependencies.remove);
      }
      continue;
    }

    const match = /^rust-src-([a-f0-9]{64})\.tar\.vfsbr$/.exec(entry.name);
    if (!match || match[1] === activeSha256) continue;
    const stat = await statIfPresent(path, dependencies);
    if (stat === null) continue;
    priorArchives.push({ path, mtime: stat.mtime?.getTime() ?? 0 });
  }

  priorArchives.sort(
    (left, right) =>
      right.mtime - left.mtime || right.path.localeCompare(left.path),
  );
  for (const candidate of priorArchives.slice(DEV_RUST_SRC_RETAINED_ASSETS - 1)) {
    await removeIfPresent(candidate.path, dependencies.remove);
  }
}

async function validateAssetDestination(path: string): Promise<void> {
  const stat = await statIfPresent(path, defaultPruneDependencies);
  if (stat !== null && !stat.isFile) {
    throw new Error(`development rust-src destination is not a regular file: ${path}`);
  }
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
  const digest = await crypto.subtle.digest("SHA-256", archive as BufferSource);
  const sha256 = bytesToHex(new Uint8Array(digest));
  const assetPath = `${directory}/rust-src-${sha256}.tar.vfsbr`;
  const sidecarPath = `${directory}/rust-src.sha256`;
  const temporaryAsset = `${assetPath}.${crypto.randomUUID()}.tmp`;
  const temporarySidecar = `${sidecarPath}.${crypto.randomUUID()}.tmp`;

  await Deno.mkdir(directory, { recursive: true });
  try {
    await Deno.writeFile(temporaryAsset, archive);
    await validateAssetDestination(assetPath);
    await Deno.rename(temporaryAsset, assetPath);
    await Deno.writeTextFile(temporarySidecar, `${sha256}\n`);
    await Deno.rename(temporarySidecar, sidecarPath);
    await pruneDevelopmentRustSrcAssets(directory, sha256);
  } catch (error) {
    const cleanup = await Promise.allSettled([
      removeIfPresent(temporaryAsset, Deno.remove),
      removeIfPresent(temporarySidecar, Deno.remove),
    ]);
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "development rust-src preparation and cleanup failed",
      );
    }
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
same-directory rename; POSIX safely replaces an existing same-hash regular
file, while a directory/special destination fails before rename. Pruning never
removes the active archive, keeps the two newest prior archives, removes only
temporary files strictly older than one hour, and ignores only `NotFound`
stat/remove races. Any other preparation, pruning, or cleanup error exits the
root command nonzero before Bun can launch Vite.

- [ ] **Step 5: Add root and page lifecycle scripts and switch browser acceptance to Bun**

In the root `package.json` scripts object, retain `rust-src:prepare-asset` and add the development command immediately after it:

```json
"rust-src:prepare-asset": "deno run --no-lock --allow-read --allow-write --allow-run scripts/prepare_rust_src_asset.ts",
"rust-src:prepare-dev-asset": "deno run --no-lock --allow-read --allow-write --allow-run scripts/prepare_rust_src_dev_asset.ts",
```

Replace only the final runner in the existing root browser command, preserving
its build and asset-preparation chain:

```json
"test:lsp-browser": "VITE_RUBRC_LSP_TEST=1 bun run --cwd page build && bun run vfs:prepare:prod && bun run rust-src:prepare-asset && bun scripts/lsp_browser_diagnostics_test.mjs"
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

- [ ] **Step 6: Implement the async hash-bound Vite development plugin**

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
          request,
          response,
          next,
          asset,
        ).catch((error) => {
          if (!response.destroyed) next(error);
        });
      });
    },
  };
}

async function serveDevelopmentRustSrcAsset(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  next: (error?: unknown) => void,
  asset: DevelopmentRustSrcAsset,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    next();
    return;
  }
  const rawUrl = request.url;
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
    const message =
      `rust-src development asset revision mismatch; expected ${asset.sha256}\n`;
    response.end(request.method === "HEAD" ? undefined : message);
    return;
  }

  const file = await open(asset.path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(`development rust-src asset is not a regular file: ${asset.path}`);
    }
    if (response.destroyed) {
      await file.close();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", String(stat.size));
    response.setHeader(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );
    if (request.method === "HEAD") {
      await file.close();
      if (!response.destroyed) response.end();
      return;
    }
  } catch (error) {
    await file.close();
    throw error;
  }
  let stream: ReturnType<typeof file.createReadStream>;
  try {
    stream = file.createReadStream();
  } catch (error) {
    await file.close();
    throw error;
  }
  try {
    await pipeline(stream, response);
  } catch (error) {
    if (
      response.destroyed ||
      (error instanceof Error &&
        "code" in error &&
        (error.code === "ECONNRESET" ||
          error.code === "ERR_STREAM_PREMATURE_CLOSE"))
    ) {
      return;
    }
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
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

`isPreview !== true` is required because Vite reports both development and preview as `command === "serve"`; preview must not read the development sidecar or install this middleware. Non-GET/HEAD requests never open the archive. `open()` and regular-file `stat()` complete before response headers, so genuine missing/unreadable failures reach `next(error)`. HEAD closes the file before ending without a body; GET pipeline aborts are consumed locally before or after headers, while non-abort failures before headers still reach Vite.

- [ ] **Step 7: Implement the root-confined browser acceptance static server**

Create `scripts/lsp_browser_static_server.mjs` with this complete content:

```js
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("../page/dist/", import.meta.url));
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".json", "application/json; charset=utf-8"],
  [".vfsbr", "application/octet-stream"],
]);

function isMissing(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isClientAbort(error, request, response) {
  return (
    request.destroyed ||
    response.destroyed ||
    (error instanceof Error &&
      "code" in error &&
      (error.code === "ECONNRESET" ||
        error.code === "ERR_STREAM_PREMATURE_CLOSE"))
  );
}

function endResponse(request, response, body = "") {
  response.end(request.method === "HEAD" ? undefined : body);
}

export function resolveStaticPath(rootDirectory, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\0")
  ) {
    return null;
  }
  const normalized = decoded.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return null;

  const root = resolve(rootDirectory);
  const candidate = resolve(root, `.${normalized}`);
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return candidate;
}

async function regularFile(path) {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile() ? fileStat : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function serveFile(request, response, path, fileStat) {
  response.statusCode = 200;
  response.setHeader(
    "Content-Type",
    CONTENT_TYPES.get(extname(path).toLowerCase()) ??
      "application/octet-stream",
  );
  response.setHeader("Content-Length", String(fileStat.size));
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  try {
    await pipeline(createReadStream(path), response);
  } catch (error) {
    if (isClientAbort(error, request, response)) return;
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    throw error;
  }
}

async function handleRequest(rootDirectory, request, response) {
  for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
    response.setHeader(name, value);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET, HEAD");
    endResponse(request, response, "Method Not Allowed\n");
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(request.url ?? "/", "http://localhost");
  } catch {
    response.statusCode = 400;
    endResponse(request, response, "Bad Request\n");
    return;
  }
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const requestedPath = resolveStaticPath(rootDirectory, pathname);
  if (requestedPath === null) {
    response.statusCode = 400;
    endResponse(request, response, "Bad Request\n");
    return;
  }

  const requestedStat = await regularFile(requestedPath);
  if (requestedStat !== null) {
    await serveFile(request, response, requestedPath, requestedStat);
    return;
  }

  const fallbackPath = resolve(rootDirectory, "index.html");
  const fallbackStat = await regularFile(fallbackPath);
  if (fallbackStat === null) {
    response.statusCode = 404;
    endResponse(request, response, "Not Found\n");
    return;
  }
  await serveFile(request, response, fallbackPath, fallbackStat);
}

export function createBrowserStaticServer(rootDirectory = DEFAULT_ROOT) {
  const root = resolve(rootDirectory);
  return createServer((request, response) => {
    void handleRequest(root, request, response).catch((error) => {
      if (isClientAbort(error, request, response)) return;
      console.error("Browser static server request failed", error);
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 500;
      endResponse(request, response, "Internal Server Error\n");
    });
  });
}

export async function startBrowserStaticServer({
  rootDirectory = DEFAULT_ROOT,
  hostname = "127.0.0.1",
  port = 4173,
} = {}) {
  const server = createBrowserStaticServer(rootDirectory);
  await new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, hostname, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  return server;
}

export async function closeBrowserStaticServer(server) {
  if (!server?.listening) return;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
    server.closeAllConnections?.();
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? "4173");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid static server port: ${process.env.PORT}`);
  }
  const server = await startBrowserStaticServer({ port });
  console.log(`browser static server listening on http://127.0.0.1:${port}`);
  const shutdown = () => void closeBrowserStaticServer(server);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
```

The lexical containment check rejects decoded traversal and NULs before any
filesystem access. Only missing/non-file requested paths use `index.html`;
filesystem permission errors become 500 rather than masquerading as SPA routes.
Expected client disconnects are consumed by the server's stream owner.

- [ ] **Step 8: Move the browser harness from Vite preview to the in-process server**

In `scripts/lsp_browser_diagnostics_test.mjs`, remove the child-process import:

```js
import { spawn } from "node:child_process";
```

Add this import after the failure-state import:

```js
import {
  closeBrowserStaticServer,
  startBrowserStaticServer,
} from "./lsp_browser_static_server.mjs";
```

Replace the `preview` owner declaration with:

```js
let browser;
let staticServer;
```

In `waitForServer`, replace the preview-specific comment and final error with:

```js
    } catch {
      // The in-process static server is still binding.
    }
```

```js
  throw new Error("browser static server did not start within 30 seconds");
```

Replace the preview spawn/resume block before `await waitForServer()` with:

```js
  staticServer = await startBrowserStaticServer({
    hostname: "127.0.0.1",
    port: 4173,
  });
```

Replace the complete child-process cleanup in `finally` with:

```js
} finally {
  await browser?.close();
  await closeBrowserStaticServer(staticServer);
}
```

The harness remains responsible for one server owner and closes all listening
and accepted sockets even when browser setup or diagnostics fail. It no longer
loads Vite preview configuration during acceptance.

- [ ] **Step 9: Format only Task 2 files**

Run:

```bash
bun x @biomejs/biome@1.9.4 format --write \
  scripts/prepare_rust_src_dev_asset.ts \
  scripts/rust_src_dev_asset_test.ts \
  scripts/lsp_browser_static_server.mjs \
  scripts/lsp_browser_static_server_test.ts \
  scripts/lsp_browser_diagnostics_test.mjs \
  package.json \
  page/package.json \
  page/vite.config.ts
```

Expected: exit 0; only the eight listed Task 2 files are formatted. `deno.lock`, `.gitignore`, `scripts/prepare_rust_src_asset.ts`, and `page/src/sysroot_archive.ts` remain byte-for-byte unchanged.

- [ ] **Step 10: Run focused Task 2 tests to verify GREEN**

Run:

```bash
deno test --no-lock -A \
  scripts/rust_src_dev_asset_test.ts \
  scripts/lsp_browser_static_server_test.ts \
  scripts/rust_src_archive_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: PASS. Retention keeps active plus two newest prior archives; stale temporary pruning uses a strict one-hour boundary; only `NotFound` races are ignored; same-hash replacement rejects non-files; static serving is root-confined and GET/HEAD-only with exact MIME/isolation/fallback behavior; and harness/package contracts select Bun without changing Vite preview. Tests remove only their temporary directories, leaving persistent `.rubrc-cache/dev` and `.rubrc-cache/sysroot` untouched.

- [ ] **Step 11: Verify production SOURCE_SHA, dedupe, and no static dev-asset leakage**

Run from the repository root:

```bash
PRODUCTION_SHA=0123456789abcdef0123456789abcdef01234567
SOURCE_SHA="$PRODUCTION_SHA" BUILD_EPOCH=17 bun run --cwd page build
rg -F "$PRODUCTION_SHA" page/dist/assets
test ! -e page/dist/rust-src.tar.vfsbr
test ! -e page/public/rust-src.tar.vfsbr
```

Expected: the production Vite build exits 0, `rg` finds the exact 40-character `SOURCE_SHA` in a built JavaScript asset, and neither Vite build output nor `page/public` contains a rust-src archive until the existing separate production `rust-src:prepare-asset` command is run. The source-contract test from Step 8 has also verified all four existing `resolve.dedupe` entries.

- [ ] **Step 12: Run the real development preparation/server/identity/Brotli integration**

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
if (!/^cache-control:\s*public, max-age=31536000, immutable\s*$/im.test(headers)) {
  throw new Error(`unexpected cache control:\n${headers}`);
}
NODE

node --input-type=module - "$SHA" <<'NODE'
const sha = process.argv[2];
const response = await fetch(
  `http://127.0.0.1:4174/rust-src.tar.vfsbr?v=${sha}&build=0`,
  { method: "HEAD" },
);
if (response.status !== 200) throw new Error(`HEAD returned ${response.status}`);
if (response.headers.get("content-type") !== "application/octet-stream") {
  throw new Error(`HEAD returned ${response.headers.get("content-type")}`);
}
if (response.headers.get("cache-control") !== "public, max-age=31536000, immutable") {
  throw new Error(`HEAD returned ${response.headers.get("cache-control")}`);
}
if ((await response.arrayBuffer()).byteLength !== 0) {
  throw new Error("HEAD returned an archive body");
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
! rg -F "ERR_STREAM_PREMATURE_CLOSE" "$TMP_DIR/vite.log"
! rg -F "ECONNRESET" "$TMP_DIR/vite.log"

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
GET and HEAD return 200 with `application/octet-stream`, exact immutable caching,
and matching lengths while HEAD returns no body; an aborted archive transfer
does not crash Vite or log expected disconnect errors;
`sha256sum` proves sidecar/content identity; Node's native
`brotliDecompressSync` prints a nonzero decoded byte count; and the mismatched
revision returns 409. The trap removes only its `/tmp` files and server process,
not `.rubrc-cache`.

- [ ] **Step 13: Run the exact browser diagnostics regression through the test server**

Run:

```bash
bun run test:lsp-browser
```

Expected: exit 0 with final output `browser displayed and cleared rust-analyzer markers`. Bun executes the TypeScript-importing harness, the in-process static server returns the production rust-src asset as `application/octet-stream`, and cleanup closes that server. The production Vite preview configuration remains unused and unchanged; browser output contains neither `Brotli decompression failed with code -2` nor an invalid compressed Content-Type error.

- [ ] **Step 14: Run the combined focused regression and inspect the final diff**

Run:

```bash
deno test --no-lock -A \
  lib/src/fetch_with_optional_cache_test.ts \
  lib/src/fetch_compressed_stream_test.ts \
  scripts/rust_src_archive_test.ts \
  scripts/rust_src_dev_asset_test.ts \
  scripts/lsp_browser_static_server_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts
git diff --check
git status --short
test -z "$(git status --short -- deno.lock)"
git diff -- \
  scripts/prepare_rust_src_dev_asset.ts \
  scripts/rust_src_dev_asset_test.ts \
  scripts/lsp_browser_static_server.mjs \
  scripts/lsp_browser_static_server_test.ts \
  scripts/lsp_browser_diagnostics_test.mjs \
  package.json \
  page/package.json \
  page/vite.config.ts
```

Expected: all focused tests pass, `git diff --check` is silent, `deno.lock`, `.rubrc-cache`, and `page/dist` do not appear in status, and Task 2 changes contain no `page/public` output, preview middleware, production `SOURCE_SHA` change, dedupe change, or unrelated edits.

- [ ] **Step 15: Commit Task 2**

Run:

```bash
git add \
  scripts/prepare_rust_src_dev_asset.ts \
  scripts/rust_src_dev_asset_test.ts \
  scripts/lsp_browser_static_server.mjs \
  scripts/lsp_browser_static_server_test.ts \
  scripts/lsp_browser_diagnostics_test.mjs \
  package.json \
  page/package.json \
  page/vite.config.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: serve validated rust source in development"
```

Expected: the staged-name list contains exactly the eight Task 2 files and the commit succeeds. `deno.lock`, `.gitignore`, `scripts/prepare_rust_src_asset.ts`, `page/src/sysroot_archive.ts`, `.rubrc-cache`, `page/public`, `page/dist`, and unrelated working-tree changes are not staged.

## Final Verification

- [ ] Confirm Task 1 maps effective `RequestInit` method override, non-GET body bypass, derived GET keys, accepted hit, rejected/non-OK hit cancellation and deletion, deletion failure, open/match failure, valid network put, invalid network no-put, predicate-throw cancellation, and failed-put clone cancellation.
- [ ] Confirm direct compressed-response tests reject and cancel missing/malformed/HTML/JSON types, cover the three accepted binary types and valid parameters/case, preserve non-OK error identity, and cancel on decompressor initialization failure without importing Wasm.
- [ ] Confirm Task 2 retains active plus two newest prior immutable archives, removes only `.tmp` files strictly older than one hour, ignores only `Deno.errors.NotFound`, propagates all other stat/remove failures, validates an existing same-hash destination as a regular file, and contains no `AlreadyExists` assumption.
- [ ] Confirm Vite development handles only GET/HEAD, HEAD has no body, valid responses are immutable and binary, aborts are locally owned without `next(error)` noise, genuine pre-header file failures still reach Vite, and production preview/public/build behavior is unchanged.
- [ ] Confirm the static server directly proves root confinement, GET/HEAD/405 behavior, SPA fallback, COOP/COEP, `.vfsbr`, JS, CSS, Wasm, and HTML MIME; the Bun harness starts and closes it in-process.
- [ ] Confirm the real dev command proves preparation, GET/HEAD content type/cache/body semantics, response/file identity, sidecar SHA identity, native Brotli decompression, quiet abort, and mismatch rejection while retaining the persistent validated cache.
- [ ] Confirm production `SOURCE_SHA`, `BUILD_EPOCH`, browser diagnostics, rust-src cache pruning/dedupe in `page/src/sysroot_archive.ts`, all existing Vite `resolve.dedupe` entries, and `deno.lock` remain unchanged.
- [ ] Confirm both commits stage only their enumerated source/test/config files and `git diff --check` is silent.
