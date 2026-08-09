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
    assert(
      rejection.message.includes(url),
      `${contentType} error omitted the URL`,
    );
    assert(
      rejection.message.includes(contentType),
      `${contentType} error omitted the Content-Type`,
    );
    assert(bodyReads === 0, `${contentType} response body was accessed`);
    assert(decompressCalls === 0, `${contentType} reached decompression`);
  }
});

Deno.test("binary Brotli and absent Content-Type responses reach decompression", async () => {
  const expected = new Uint8Array([11, 12, 13]);
  for (const contentType of [
    undefined,
    "application/octet-stream",
    "application/brotli",
    "application/x-brotli; profile=archive",
    "Application/Octet-Stream; Charset=binary",
  ]) {
    let decompressCalls = 0;
    const headers = new Headers();
    if (contentType !== undefined) headers.set("content-type", contentType);

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
    assert(
      actual.join(",") === expected.join(","),
      `${contentType} bytes changed`,
    );
    assert(
      decompressCalls === 1,
      `${contentType} did not reach decompression once`,
    );
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
  assert(
    rejection.message === "Failed to fetch wasm",
    "HTTP error path changed",
  );
  assert(decompressCalls === 0, "non-OK response reached decompression");
});
