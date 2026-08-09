import { pruneRustSrcCacheVariants } from "./rust_src_cache.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const archiveUrl = "https://example.test/rubrc/rust-src.tar.vfsbr?v=new";

function dependencies(sourceSha: string | Error) {
  const deleted: string[] = [];
  const requests = [
    new Request("https://example.test/rubrc/rust-src.tar.vfsbr"),
    new Request("https://example.test/rubrc/rust-src.tar.vfsbr?v=old"),
    new Request(archiveUrl),
    new Request("https://example.test/rubrc/other.wasm?v=old"),
    new Request("https://other.test/rubrc/rust-src.tar.vfsbr?v=old"),
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
        return new Response(JSON.stringify({ version: 1, sourceSha }), {
          status: 200,
        });
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
      "https://example.test/rubrc/rust-src.tar.vfsbr,https://example.test/rubrc/rust-src.tar.vfsbr?v=old",
    `wrong cache entries deleted: ${test.deleted}`,
  );
});

Deno.test("a deployment cached after the pruning snapshot is retained", async () => {
  const deleted: string[] = [];
  const requests = [
    new Request("https://example.test/rubrc/rust-src.tar.vfsbr?v=old"),
    new Request(archiveUrl),
  ];
  await pruneRustSrcCacheVariants(archiveUrl, "new", {
    cacheStorage: {
      open: async () => ({
        keys: async () => [...requests],
        delete: async (request) => {
          deleted.push(request.url);
          return true;
        },
      }),
    },
    fetch: async () => {
      requests.push(
        new Request(
          "https://example.test/rubrc/rust-src.tar.vfsbr?v=newer-deployment",
        ),
      );
      return new Response(JSON.stringify({ version: 1, sourceSha: "new" }));
    },
    reportError: (_error: unknown) => {},
  });
  assert(
    deleted.join(",") === "https://example.test/rubrc/rust-src.tar.vfsbr?v=old",
    `concurrent deployment variant was deleted: ${deleted}`,
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
});

Deno.test("bad deployment metadata never prunes cache entries", async () => {
  for (const response of [
    new Response("not-json", { status: 200 }),
    new Response("unavailable", { status: 503 }),
    new Response(JSON.stringify({ version: 2, sourceSha: "new" }), {
      status: 200,
    }),
  ]) {
    const test = dependencies("new");
    test.value.fetch = async () => response;
    await pruneRustSrcCacheVariants(archiveUrl, "new", test.value);
    assert(test.deleted.length === 0, "invalid metadata pruned cache entries");
  }
});
