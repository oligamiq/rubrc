/// <reference lib="deno.ns" />

import {
  fetchBinaryStream,
  isAcceptedBinaryResponse,
} from "./fetch_binary_stream.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("binary asset fetch returns accepted bytes without transformation", async () => {
  const input = new Uint8Array([0x68, 0x73, 0x71, 0x73, 1, 2, 3]);
  const stream = await fetchBinaryStream(
    "https://example.test/rust-src.sqfs?v=abc",
    undefined,
    {
      fetch: async () => new Response(input, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
      reportCacheError() {},
    },
  );
  const output = new Uint8Array(await new Response(stream).arrayBuffer());
  assert(output.join(",") === input.join(","), "binary bytes were transformed");
});

Deno.test("binary asset response rejects document content types", async () => {
  assert(
    isAcceptedBinaryResponse(new Response(null, {
      headers: { "content-type": "application/octet-stream" },
    })),
    "octet-stream was rejected",
  );
  assert(
    !isAcceptedBinaryResponse(new Response(null, {
      headers: { "content-type": "text/html" },
    })),
    "HTML was accepted as a binary asset",
  );

  let rejected = false;
  try {
    await fetchBinaryStream("https://example.test/rust-src.sqfs", undefined, {
      fetch: async () => new Response("<html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      reportCacheError() {},
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("Invalid binary asset response");
  }
  assert(rejected, "HTML binary response was not rejected");
});
