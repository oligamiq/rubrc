/// <reference lib="deno.ns" />

import { fetchWithOptionalCache } from "./fetch_with_optional_cache.ts";

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
