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
    assert(
      rejection.message.includes(url),
      `${contentType} error omitted the URL`,
    );
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
  assert(
    rejection.message.includes(url),
    "missing header error omitted the URL",
  );
  assert(
    rejection.message.includes("Content-Type null"),
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
    const headers = new Headers({ "content-type": contentType });

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
            {
              status: 404,
              headers: { "content-type": "text/html" },
            },
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
  assert(
    rejection.message === "Failed to fetch wasm",
    "HTTP error path changed",
  );
  assert(cancelCalls === 1, "non-OK response body was not canceled once");
  assert(decompressCalls === 0, "non-OK response reached decompression");
});

Deno.test("a Request signal is preserved when no explicit signal is provided", async () => {
  const controller = new AbortController();
  const request = new Request(
    "https://example.test/rust-src.tar.vfsbr?v=request-signal",
    { signal: controller.signal },
  );
  const requestSignal = request.signal;

  const stream = await fetchCompressedStream(request, undefined, {
    async fetch(fetchInput, init) {
      assert(
        fetchInput === request,
        "fetch did not receive the original Request",
      );
      assert(fetchInput instanceof Request, "fetch input was not a Request");
      assert(
        fetchInput.signal === requestSignal,
        "Request signal identity changed",
      );
      assert(
        init === undefined,
        "undefined explicit signal created RequestInit",
      );
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "application/octet-stream" },
      });
    },
    reportCacheError() {},
    async getDecompressStream() {
      return new TransformStream<Uint8Array, Uint8Array>();
    },
  });

  await readBytes(stream);
  controller.abort();
  assert(
    requestSignal.aborted,
    "Request signal stopped following its controller",
  );
});
