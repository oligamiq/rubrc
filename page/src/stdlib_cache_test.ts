import { fetchStdlibCache, installStdlibCache } from "./stdlib_cache.ts";
import { STDLIB_CACHE_SESSION_ID } from "./lsp_protocol.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("cache installation sends the binary buffer without JSON or workspace mirroring", async () => {
  const bytes = new Uint8Array([0, 255, 128]);
  await installStdlibCache(async (message) => {
    assert(
      message.sessionId === STDLIB_CACHE_SESSION_ID,
      "wrong installation route",
    );
    assert(message.data === bytes, "cache was copied or converted before RPC");
  }, bytes);
});

Deno.test("missing or invalid cache manifest falls back to cold startup", async () => {
  const original = globalThis.fetch;
  try {
    for (
      const response of [
        new Response(null, { status: 404 }),
        Response.json({ version: 2, file: "f", hash: "h" }),
        Response.json({ version: 1, file: "../other", hash: "0".repeat(64) }),
        Response.json(null),
      ]
    ) {
      globalThis.fetch = async () => response;
      assert(
        await fetchStdlibCache("/", new AbortController().signal) === undefined,
        "invalid manifest was accepted",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("cache integrity is checked against actual bytes", async () => {
  const original = globalThis.fetch;
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const requests: string[] = [];
  let corrupt = false;
  try {
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return String(url).endsWith("std-cache.json")
        ? Response.json({
          version: 1,
          hash,
          size: bytes.length,
          parts: [{ file: `std-${hash}.salsa.part-000`, size: 2 }, {
            file: `std-${hash}.salsa.part-001`,
            size: 3,
          }],
        })
        : new Response(
          corrupt
            ? new Uint8Array(String(url).endsWith("000") ? 2 : 3).fill(9)
            : String(url).endsWith("000")
            ? bytes.slice(0, 2)
            : bytes.slice(2),
        );
    };
    const result = await fetchStdlibCache(
      "/app/",
      new AbortController().signal,
    );
    assert(
      result?.join() === bytes.join(),
      "valid binary cache did not round-trip",
    );
    assert(requests[0] === "/app/std-cache.json", "base URL was malformed");
    assert(
      requests[1] === `/app/std-${hash}.salsa.part-000`,
      "wrong content-addressed URL",
    );
    corrupt = true;
    assert(
      await fetchStdlibCache("/app/", new AbortController().signal) ===
        undefined,
      "corrupt cache was accepted",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("aborting cache preparation prevents further startup", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  const result = await fetchStdlibCache("/", controller.signal).catch((error) =>
    error
  );
  assert(result === reason, "abort reason was swallowed");
});
