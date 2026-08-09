/// <reference lib="deno.ns" />

import {
  type FetchInput,
  fetchWithOptionalCache,
} from "./fetch_with_optional_cache.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  assert(actual.length === expected.length, "response byte length changed");
  for (let index = 0; index < expected.length; index += 1) {
    assert(actual[index] === expected[index], `response byte ${index} changed`);
  }
}

Deno.test("cache open rejection falls back to the network response", async () => {
  const expected = new Uint8Array([10, 20, 30, 40]);
  const cacheError = new Error("cache open failed");
  const reportedErrors: unknown[] = [];
  let fetchCalls = 0;

  const response = await fetchWithOptionalCache(
    "https://example.test/asset.br",
    undefined,
    {
      cacheStorage: {
        open() {
          return Promise.reject(cacheError);
        },
      },
      async fetch() {
        fetchCalls += 1;
        return new Response(expected);
      },
      reportCacheError(error: unknown) {
        reportedErrors.push(error);
      },
    },
  );

  assert(fetchCalls === 1, "network fetch did not run exactly once");
  assertBytesEqual(new Uint8Array(await response.arrayBuffer()), expected);
  assert(reportedErrors.length === 1, "cache error was not reported once");
  assert(reportedErrors[0] === cacheError, "reported the wrong cache error");
});

Deno.test("cache match rejection falls back to the network response", async () => {
  const expected = new Uint8Array([50, 60, 70, 80]);
  const cacheError = new Error("cache match failed");
  const reportedErrors: unknown[] = [];
  let fetchCalls = 0;
  let putCalls = 0;

  const response = await fetchWithOptionalCache(
    "https://example.test/asset.br",
    undefined,
    {
      cacheStorage: {
        async open() {
          return {
            match() {
              return Promise.reject(cacheError);
            },
            async delete() {
              throw new Error("cache delete must not run after a failed match");
            },
            async put() {
              putCalls += 1;
            },
          };
        },
      },
      async fetch() {
        fetchCalls += 1;
        return new Response(expected);
      },
      reportCacheError(error: unknown) {
        reportedErrors.push(error);
      },
    },
  );

  assert(fetchCalls === 1, "network fetch did not run exactly once");
  assertBytesEqual(new Uint8Array(await response.arrayBuffer()), expected);
  assert(reportedErrors.length === 1, "cache error was not reported once");
  assert(reportedErrors[0] === cacheError, "reported the wrong cache error");
  assert(putCalls === 0, "cache put ran after a failed lookup");
});

Deno.test("cache put rejection preserves the fetched response body", async () => {
  const expected = new Uint8Array([0, 1, 2, 127, 255]);
  const cacheError = new Error("cache failed");
  const reportedErrors: unknown[] = [];
  let unhandledRejections = 0;
  const onUnhandledRejection = () => {
    unhandledRejections += 1;
  };
  globalThis.addEventListener("unhandledrejection", onUnhandledRejection);

  try {
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
              put() {
                return Promise.reject(cacheError);
              },
            };
          },
        },
        async fetch() {
          return new Response(expected);
        },
        reportCacheError(error: unknown) {
          reportedErrors.push(error);
        },
      },
    );

    assertBytesEqual(new Uint8Array(await response.arrayBuffer()), expected);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert(reportedErrors.length === 1, "cache error was not reported once");
    assert(reportedErrors[0] === cacheError, "reported the wrong cache error");
    assert(unhandledRejections === 0, "cache rejection was left unhandled");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
  }
});

Deno.test("cache hit returns the cached response without fetching", async () => {
  const cachedResponse = new Response(new Uint8Array([4, 5, 6]));
  let fetchCalls = 0;

  const response = await fetchWithOptionalCache(
    "https://example.test/asset.br",
    undefined,
    {
      cacheStorage: {
        async open() {
          return {
            async match() {
              return cachedResponse;
            },
            async delete() {
              throw new Error("cache delete must not run on an accepted hit");
            },
            async put() {
              throw new Error("cache put must not run on a hit");
            },
          };
        },
      },
      async fetch() {
        fetchCalls += 1;
        throw new Error("fetch must not run on a cache hit");
      },
      reportCacheError() {},
    },
  );

  assert(response === cachedResponse, "cache hit response identity changed");
  assert(fetchCalls === 0, "fetch ran on a cache hit");
});

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
            assert(
              putInput === input,
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
      return (
        candidate.headers.get("content-type") === "application/octet-stream"
      );
    },
    reportCacheError(error) {
      throw new Error("valid recovery reported a cache error", {
        cause: error,
      });
    },
  });

  assert(response === networkResponse, "network response identity changed");
  assert(
    deleted.length === 1 && deleted[0] === input,
    "invalid hit was not deleted",
  );
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
          return (
            candidate.headers.get("content-type") === "application/octet-stream"
          );
        },
        reportCacheError(error) {
          throw new Error("invalid network response reported a cache error", {
            cause: error,
          });
        },
      },
    );

    assert(
      response === networkResponse,
      `${contentType} response identity changed`,
    );
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
        return (
          candidate.headers.get("content-type") === "application/octet-stream"
        );
      },
      reportCacheError(error) {
        reportedErrors.push(error);
      },
    },
  );

  assert(
    response === networkResponse,
    "delete failure replaced the network response",
  );
  assert(
    reportedErrors.length === 1,
    "delete failure was not reported exactly once",
  );
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
      assert(
        fetchInput === input,
        "network did not receive the original Request",
      );
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

  assert(
    fetchedBody === "compressed-request-body",
    "network Request body changed",
  );
});
