import { pruneRustSrcCacheVariants } from "./rust_src_cache.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const archiveUrl =
  "https://example.test/rubrc/rust-src.tar.vfsbr?v=new&build=10";

function dependencies(sourceSha: string | Error, buildEpoch = 10) {
  const deleted: string[] = [];
  const requests = [
    new Request("https://example.test/rubrc/rust-src.tar.vfsbr"),
    new Request("https://example.test/rubrc/rust-src.tar.vfsbr?v=legacy"),
    new Request("https://example.test/rubrc/rust-src.tar.vfsbr?v=old&build=9"),
    new Request(archiveUrl),
    new Request(
      "https://example.test/rubrc/rust-src.tar.vfsbr?v=same-epoch&build=10",
    ),
    new Request(
      "https://example.test/rubrc/rust-src.tar.vfsbr?v=newer&build=11",
    ),
    new Request(
      "https://example.test/rubrc/rust-src.tar.vfsbr?v=malformed&build=nope",
    ),
    new Request("https://example.test/rubrc/other.wasm?v=old&build=9"),
    new Request("https://other.test/rubrc/rust-src.tar.vfsbr?v=old&build=9"),
  ];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    deleted,
    fetchCalls,
    value: {
      cacheStorage: {
        open: async (name: string) => {
          assert(name === "rubrc-assets-v1", `wrong cache: ${name}`);
          return {
            keys: async () => requests,
            delete: async (request: Request) => {
              deleted.push(request.url);
              return true;
            },
          };
        },
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        if (sourceSha instanceof Error) throw sourceSha;
        return new Response(
          JSON.stringify({ version: 1, sourceSha, buildEpoch }),
          { status: 200 },
        );
      },
      reportError: (_error: unknown) => {},
    },
  };
}

Deno.test("matching deployment prunes only older same-path variants", async () => {
  const test = dependencies("new");
  await pruneRustSrcCacheVariants(archiveUrl, "new", test.value);
  assert(test.fetchCalls.length === 1, "metadata was not fetched once");
  assert(
    test.fetchCalls[0].url ===
      "https://example.test/rubrc/.rubrc-pages-build.json",
    `wrong metadata URL: ${test.fetchCalls[0].url}`,
  );
  assert(
    test.fetchCalls[0].init?.cache === "no-store",
    "metadata fetch did not bypass the HTTP cache",
  );
  assert(
    test.deleted.join(",") ===
      "https://example.test/rubrc/rust-src.tar.vfsbr,https://example.test/rubrc/rust-src.tar.vfsbr?v=legacy,https://example.test/rubrc/rust-src.tar.vfsbr?v=old&build=9",
    `wrong cache entries deleted: ${test.deleted}`,
  );
});

Deno.test("older metadata never deletes a newer revision already in the snapshot", async () => {
  const deleted: string[] = [];
  const oldArchiveUrl =
    "https://example.test/rubrc/rust-src.tar.vfsbr?v=old&build=10";
  await pruneRustSrcCacheVariants(oldArchiveUrl, "old", {
    cacheStorage: {
      open: async () => ({
        keys: async () => [
          new Request(oldArchiveUrl),
          new Request(
            "https://example.test/rubrc/rust-src.tar.vfsbr?v=newer&build=11",
          ),
        ],
        delete: async (request) => {
          deleted.push(request.url);
          return true;
        },
      }),
    },
    fetch: async () =>
      new Response(
        JSON.stringify({ version: 1, sourceSha: "old", buildEpoch: 10 }),
      ),
    reportError: (_error: unknown) => {},
  });
  assert(
    deleted.length === 0,
    `newer deployment variant was deleted: ${deleted}`,
  );
});

Deno.test("stale tabs and metadata failures retain every cache entry", async () => {
  for (const sourceSha of ["newer-deployment", new Error("offline")]) {
    const test = dependencies(sourceSha);
    await pruneRustSrcCacheVariants(archiveUrl, "old", test.value);
    assert(
      test.deleted.length === 0,
      "non-current bundle pruned cache entries",
    );
  }

  const staleEpoch = dependencies("new", 11);
  await pruneRustSrcCacheVariants(archiveUrl, "new", staleEpoch.value);
  assert(
    staleEpoch.deleted.length === 0,
    "same-SHA metadata for another epoch pruned cache entries",
  );
});

Deno.test("bad deployment metadata never prunes cache entries", async () => {
  for (const response of [
    new Response("not-json", { status: 200 }),
    new Response("unavailable", { status: 503 }),
    new Response(JSON.stringify({ version: 2, sourceSha: "new" }), {
      status: 200,
    }),
    new Response(JSON.stringify({ version: 1, sourceSha: "new" }), {
      status: 200,
    }),
    new Response(
      JSON.stringify({ version: 1, sourceSha: "new", buildEpoch: "10" }),
      { status: 200 },
    ),
  ]) {
    const test = dependencies("new");
    test.value.fetch = async () => response;
    await pruneRustSrcCacheVariants(archiveUrl, "new", test.value);
    assert(test.deleted.length === 0, "invalid metadata pruned cache entries");
  }
});

Deno.test("CacheStorage access failures are best-effort", async () => {
  const securityError = new DOMException("storage disabled", "SecurityError");
  let reported: unknown;
  await pruneRustSrcCacheVariants(archiveUrl, "new", {
    get cacheStorage(): never {
      throw securityError;
    },
    fetch: async () => {
      throw new Error("metadata fetch should not start");
    },
    reportError: (error) => {
      reported = error;
    },
  });
  assert(reported === securityError, "CacheStorage failure was not reported");
});
