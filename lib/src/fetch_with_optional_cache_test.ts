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
  let cacheCloneCancelCalls = 0;
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
        reportCacheError(error: unknown) {
          reportedErrors.push(error);
        },
      },
    );

    assertBytesEqual(new Uint8Array(await response.arrayBuffer()), expected);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert(reportedErrors.length === 1, "cache error was not reported once");
    assert(reportedErrors[0] === cacheError, "reported the wrong cache error");
    assert(cacheCloneCancelCalls === 1, "cached clone was not canceled once");
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
  let cachedBodyCancelCalls = 0;
  const cachedResponse = new Response(
    new ReadableStream({
      cancel() {
        cachedBodyCancelCalls += 1;
      },
    }),
    {
      headers: { "content-type": "text/html" },
    },
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
    deleted.length === 1 &&
      deleted[0] instanceof Request &&
      deleted[0].url === input,
    "invalid hit was not deleted",
  );
  assert(fetchCalls === 1, "network was not fetched exactly once");
  assert(putCalls === 1, "valid replacement was not cached exactly once");
  assert(
    cachedBodyCancelCalls === 1,
    "invalid cached body cancellation changed",
  );
});

Deno.test("non-OK cache hits are deleted and replaced from the network", async () => {
  const input = "https://example.test/rust-src.tar.vfsbr?v=stale-error";
  let cachedBodyCancelCalls = 0;
  const cachedResponse = new Response(
    new ReadableStream({
      cancel() {
        cachedBodyCancelCalls += 1;
      },
    }),
    {
      status: 404,
      headers: { "content-type": "application/octet-stream" },
    },
  );
  const networkResponse = new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "application/octet-stream" },
  });
  let deleteCalls = 0;
  let fetchCalls = 0;

  const response = await fetchWithOptionalCache(input, undefined, {
    cacheStorage: {
      async open() {
        return {
          async match() {
            return cachedResponse;
          },
          async delete() {
            deleteCalls += 1;
            return true;
          },
          async put() {},
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
      throw error;
    },
  });

  assert(response === networkResponse, "non-OK cache hit was returned");
  assert(
    cachedBodyCancelCalls === 1,
    "non-OK cached body was not canceled once",
  );
  assert(deleteCalls === 1, "non-OK cache hit was not deleted once");
  assert(fetchCalls === 1, "non-OK cache hit did not recover from the network");
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

Deno.test("non-GET init methods bypass CacheStorage for string and URL inputs", async () => {
  for (const input of [
    "https://example.test/string-upload",
    new URL("https://example.test/url-upload"),
  ]) {
    let fetchCalls = 0;
    const init = { method: "POST", body: "compressed-request-body" };

    await fetchWithOptionalCache(input, init, {
      cacheStorage: {
        open() {
          throw new Error("non-GET init must not open CacheStorage");
        },
      },
      async fetch(fetchInput, fetchInit) {
        assert(fetchInput === input, "network input identity changed");
        assert(fetchInit === init, "network init identity changed");
        fetchCalls += 1;
        return new Response(new Uint8Array([1]));
      },
      reportCacheError(error) {
        throw error;
      },
    });

    assert(fetchCalls === 1, "network fetch did not run exactly once");
  }
});

Deno.test("init method overrides a GET Request when bypassing CacheStorage", async () => {
  const input = new Request("https://example.test/request-upload");
  const init = { method: "post", body: "overridden-request-body" };
  let fetchCalls = 0;

  await fetchWithOptionalCache(input, init, {
    cacheStorage: {
      open() {
        throw new Error(
          "overridden non-GET Request must not open CacheStorage",
        );
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
  const init = { method: "GET" };
  const cachedResponse = new Response(new Uint8Array([1]));

  const response = await fetchWithOptionalCache(input, init, {
    cacheStorage: {
      async open() {
        return {
          async match(cacheInput) {
            assert(
              cacheInput instanceof Request,
              "cache key was not a Request",
            );
            assert(cacheInput !== input, "cache key reused the POST Request");
            assert(cacheInput.method === "GET", "cache key method was not GET");
            assert(cacheInput.url === input.url, "cache key URL changed");
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

Deno.test("RequestInit metadata is represented in the derived cache key", async () => {
  const input = "https://example.test/metadata-cache-key";
  const init: RequestInit = {
    headers: { "x-rubrc-cache-variant": "strict" },
    credentials: "include",
    mode: "cors",
  };
  const cachedResponse = new Response(new Uint8Array([2]));

  const response = await fetchWithOptionalCache(input, init, {
    cacheStorage: {
      async open() {
        return {
          async match(cacheInput) {
            assert(
              cacheInput instanceof Request,
              "cache key was not a Request",
            );
            assert(
              cacheInput.headers.get("x-rubrc-cache-variant") === "strict",
              "cache key omitted init headers",
            );
            assert(
              cacheInput.credentials === "include",
              "cache key omitted init credentials",
            );
            assert(cacheInput.mode === "cors", "cache key omitted init mode");
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

  assert(response === cachedResponse, "metadata cache hit identity changed");
});

Deno.test("cached acceptResponse errors cancel the body before rethrowing", async () => {
  const predicateError = new Error("cached predicate failed");
  let cancelCalls = 0;
  let deleteCalls = 0;
  let fetchCalls = 0;
  const cachedResponse = new Response(
    new ReadableStream({
      cancel() {
        cancelCalls += 1;
      },
    }),
  );
  let rejection: unknown;

  try {
    await fetchWithOptionalCache(
      "https://example.test/cached-predicate-error",
      undefined,
      {
        cacheStorage: {
          async open() {
            return {
              async match() {
                return cachedResponse;
              },
              async delete() {
                deleteCalls += 1;
                return true;
              },
              async put() {},
            };
          },
        },
        async fetch() {
          fetchCalls += 1;
          return new Response();
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

  assert(
    rejection === predicateError,
    "cached predicate error identity changed",
  );
  assert(cancelCalls === 1, "cached predicate body was not canceled once");
  assert(deleteCalls === 0, "cached predicate error deleted the cache entry");
  assert(fetchCalls === 0, "cached predicate error fetched the network");
});

Deno.test("network acceptResponse errors cancel the body before rethrowing", async () => {
  const predicateError = new Error("network predicate failed");
  let cancelCalls = 0;
  let putCalls = 0;
  const networkResponse = new Response(
    new ReadableStream({
      cancel() {
        cancelCalls += 1;
      },
    }),
  );
  let rejection: unknown;

  try {
    await fetchWithOptionalCache(
      "https://example.test/network-predicate-error",
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

  assert(
    rejection === predicateError,
    "network predicate error identity changed",
  );
  assert(cancelCalls === 1, "network predicate body was not canceled once");
  assert(putCalls === 0, "network predicate error cached the response");
});
