import {
  createHttpBridge,
  type HttpBridgeMessage,
  isHttpBridgeMessage,
} from "../lib/src/http_bridge.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CHUNK_SIZE = 16 * 1024;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function assertRejects(
  action: () => unknown | Promise<unknown>,
  message: string,
) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

function message<Name extends HttpBridgeMessage["name"]>(
  name: Name,
  args: Record<string, unknown>,
) {
  return { name, args };
}

function requestArgs(overrides: Record<string, unknown> = {}) {
  return {
    method: Array.from(encoder.encode("GET")),
    url: Array.from(encoder.encode("https://example.test/data")),
    headers: [],
    body: [],
    ...overrides,
  };
}

async function readError(
  bridge: ReturnType<typeof createHttpBridge>,
  requestId: number,
  length: number,
) {
  const result = await bridge(message("httpResponseReadError", {
    request_id: requestId,
    chunk_len: length,
  }));
  return decoder.decode(new Uint8Array(result.chunk));
}

Deno.test("HTTP bridge guard rejects messages without arguments", () => {
  assert(
    !isHttpBridgeMessage({ name: "httpRequestStart" }),
    "HTTP messages require an args object",
  );
});

Deno.test("HTTP bridge preserves request and normalized response data", async () => {
  let receivedUrl = "";
  let receivedInit: RequestInit | undefined;
  const responseBody = new Uint8Array(MAX_CHUNK_SIZE + 3);
  responseBody.set([0, 255, 128], MAX_CHUNK_SIZE);
  const headers = new Headers();
  headers.append("X-Repeated", "first");
  headers.append("x-repeated", "second");

  const bridge = createHttpBridge(async (input, init) => {
    receivedUrl = String(input);
    receivedInit = init;
    return new Response(responseBody, { status: 206, headers });
  });
  const metadata = await bridge(message("httpRequestStart", {
    method: Array.from(encoder.encode("POST")),
    url: Array.from(encoder.encode("https://example.test/data?q=1")),
    headers: Array.from(
      encoder.encode("X-Test:  value:with:colons \r\nx-test:\tsecond\r\n"),
    ),
    body: [0, 255, 128, 1],
  }));

  assertEquals(receivedUrl, "https://example.test/data?q=1", "request URL");
  assertEquals(receivedInit?.method, "POST", "request method");
  assertEquals(
    (receivedInit?.headers as Headers).get("x-test"),
    "value:with:colons, second",
    "request headers",
  );
  assertEquals(
    Array.from(receivedInit?.body as Uint8Array),
    [0, 255, 128, 1],
    "request body",
  );
  assertEquals(metadata, {
    request_id: 1,
    status: 206,
    headers_len: encoder.encode("x-repeated:first, second\n").length,
    body_len: MAX_CHUNK_SIZE + 3,
    error_len: 0,
  }, "response metadata");

  const headersChunk = await bridge(message("httpResponseReadHeaders", {
    request_id: 1,
    chunk_len: MAX_CHUNK_SIZE + 100,
  }));
  assertEquals(
    decoder.decode(new Uint8Array(headersChunk.chunk)),
    "x-repeated:first, second\n",
    "normalized response headers",
  );
  const firstBodyChunk = await bridge(message("httpResponseReadBody", {
    request_id: 1,
    chunk_len: MAX_CHUNK_SIZE + 100,
  }));
  assertEquals(
    firstBodyChunk.chunk.length,
    MAX_CHUNK_SIZE,
    "bounded body chunk",
  );
  const secondBodyChunk = await bridge(message("httpResponseReadBody", {
    request_id: 1,
    chunk_len: 100,
  }));
  assertEquals(secondBodyChunk.chunk, [0, 255, 128], "binary response tail");
});

Deno.test("HTTP bridge retains byte range validation errors", async () => {
  let fetched = false;
  const bridge = createHttpBridge(() => {
    fetched = true;
    return Promise.resolve(new Response());
  });
  const metadata = await bridge(message(
    "httpRequestStart",
    requestArgs({
      body: [0, 256],
    }),
  ));

  assertEquals(fetched, false, "invalid bytes must not reach Fetch");
  assertEquals(metadata.status, 0, "invalid byte status");
  assert(
    (await readError(bridge, metadata.request_id, metadata.error_len)).includes(
      "byte array",
    ),
    "invalid byte error must be retained",
  );
});

Deno.test("HTTP bridge rejects sparse byte arrays", async () => {
  let fetched = false;
  const bridge = createHttpBridge(() => {
    fetched = true;
    return Promise.resolve(new Response());
  });
  const sparseBody = [1, 2, 3];
  delete sparseBody[1];
  const metadata = await bridge(message(
    "httpRequestStart",
    requestArgs({
      method: Array.from(encoder.encode("POST")),
      body: sparseBody,
    }),
  ));

  assertEquals(fetched, false, "sparse bytes must not reach Fetch");
  assert(metadata.error_len > 0, "sparse byte error must be retained");
});

Deno.test("HTTP bridge retains malformed request decoding errors", async () => {
  const bridge = createHttpBridge(() => Promise.resolve(new Response()));
  const metadata = await bridge(message(
    "httpRequestStart",
    requestArgs({
      headers: Array.from(encoder.encode("missing-colon\n")),
    }),
  ));

  assertEquals(metadata.status, 0, "malformed request status");
  assert(
    (await readError(bridge, metadata.request_id, metadata.error_len)).includes(
      "malformed",
    ),
    "malformed request error must be retained",
  );
});

Deno.test("HTTP bridge retains invalid UTF-8 request errors", async () => {
  let fetched = false;
  const bridge = createHttpBridge(() => {
    fetched = true;
    return Promise.resolve(new Response());
  });
  const metadata = await bridge(message(
    "httpRequestStart",
    requestArgs({
      method: [0xff],
    }),
  ));

  assertEquals(fetched, false, "invalid UTF-8 must not reach Fetch");
  assert(metadata.error_len > 0, "invalid UTF-8 error must be retained");
});

Deno.test("HTTP bridge allows only HTTP and HTTPS URLs", async () => {
  let fetched = false;
  const bridge = createHttpBridge(() => {
    fetched = true;
    return Promise.resolve(new Response());
  });
  const metadata = await bridge(message(
    "httpRequestStart",
    requestArgs({
      url: Array.from(encoder.encode("file:///etc/passwd")),
    }),
  ));

  assertEquals(fetched, false, "disallowed URL must not reach Fetch");
  assert(
    (await readError(bridge, metadata.request_id, metadata.error_len)).includes(
      "protocol",
    ),
    "protocol error must be retained",
  );
});

Deno.test("HTTP bridge rejects non-empty GET and HEAD bodies", async () => {
  for (const method of ["GET", "HEAD"]) {
    let fetched = false;
    const bridge = createHttpBridge(() => {
      fetched = true;
      return Promise.resolve(new Response());
    });
    const metadata = await bridge(message(
      "httpRequestStart",
      requestArgs({
        method: Array.from(encoder.encode(method)),
        body: [1],
      }),
    ));

    assertEquals(fetched, false, `${method} body must not reach Fetch`);
    assert(
      (await readError(bridge, metadata.request_id, metadata.error_len))
        .includes(
          `${method} request body`,
        ),
      `${method} body error must be retained`,
    );
  }
});

Deno.test("HTTP bridge rejects declared oversized responses before reading", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const bridge = createHttpBridge(
    () =>
      Promise.resolve(
        new Response(body, {
          headers: { "content-length": "5" },
        }),
      ),
    { maxResponseBytes: 4 },
  );
  const metadata = await bridge(message("httpRequestStart", requestArgs()));

  assertEquals(metadata.body_len, 0, "oversized declared body length");
  assertEquals(cancelled, true, "oversized declared body must be cancelled");
  assert(
    (await readError(bridge, metadata.request_id, metadata.error_len)).includes(
      "exceeds 4 bytes",
    ),
    "declared size error must be retained",
  );
});

Deno.test("HTTP bridge caps and cancels chunked response buffering", async () => {
  let pull = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pull++ === 0) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      } else {
        controller.enqueue(new Uint8Array([4, 5]));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const bridge = createHttpBridge(
    () => Promise.resolve(new Response(body)),
    { maxResponseBytes: 4 },
  );
  const metadata = await bridge(message("httpRequestStart", requestArgs()));

  assertEquals(metadata.body_len, 0, "oversized streamed body length");
  assertEquals(cancelled, true, "oversized streamed body must be cancelled");
  assert(
    (await readError(bridge, metadata.request_id, metadata.error_len)).includes(
      "exceeds 4 bytes",
    ),
    "streamed size error must be retained",
  );
});

Deno.test("HTTP bridge keeps three overlapping default responses independent", async () => {
  const releases: Array<(response: Response) => void> = [];
  const bridge = createHttpBridge(
    () => new Promise<Response>((resolve) => releases.push(resolve)),
    { maxResponseBytes: 8 },
  );
  const pending = [
    bridge(message("httpRequestStart", requestArgs())),
    bridge(message("httpRequestStart", requestArgs())),
    bridge(message("httpRequestStart", requestArgs())),
  ];
  assertEquals(releases.length, 3, "three fetches must overlap");
  releases[2](new Response(new Uint8Array([3])));
  releases[0](new Response(new Uint8Array([1])));
  releases[1](new Response(new Uint8Array([2])));
  const responses = await Promise.all(pending);

  for (let index = 0; index < responses.length; index++) {
    const requestId = responses[index].request_id;
    assertEquals(
      (await bridge(message("httpResponseReadBody", {
        request_id: requestId,
        chunk_len: 1,
      }))).chunk,
      [index + 1],
      `overlapping response ${index + 1}`,
    );
    await bridge(message("httpResponseEnd", { request_id: requestId }));
  }
});

Deno.test("HTTP bridge rejects a new start without evicting retained responses", async () => {
  let fetchCount = 0;
  const bridge = createHttpBridge(
    () => Promise.resolve(new Response(new Uint8Array([++fetchCount]))),
    { maxResponseBytes: 8, maxRetainedResponses: 2 },
  );
  const first = await bridge(message("httpRequestStart", requestArgs()));
  const second = await bridge(message("httpRequestStart", requestArgs()));

  await assertRejects(
    () => bridge(message("httpRequestStart", requestArgs())),
    "start beyond retained capacity must fail",
  );
  assertEquals(fetchCount, 2, "capacity failure must not begin Fetch");
  for (const [metadata, expected] of [[first, 1], [second, 2]] as const) {
    assertEquals(
      (await bridge(message("httpResponseReadBody", {
        request_id: metadata.request_id,
        chunk_len: 1,
      }))).chunk,
      [expected],
      `retained response ${expected}`,
    );
    await bridge(message("httpResponseEnd", {
      request_id: metadata.request_id,
    }));
  }
  const replacement = await bridge(message("httpRequestStart", requestArgs()));
  assertEquals(
    fetchCount,
    3,
    "end must release capacity for replacement Fetch",
  );
  assertEquals(
    (await bridge(message("httpResponseReadBody", {
      request_id: replacement.request_id,
      chunk_len: 1,
    }))).chunk,
    [3],
    "replacement after successful ends",
  );
  await bridge(message("httpResponseEnd", {
    request_id: replacement.request_id,
  }));
});

Deno.test("HTTP bridge reserves capacity for pending starts", async () => {
  const releases: Array<(response: Response) => void> = [];
  let fetchCount = 0;
  const bridge = createHttpBridge(
    () => {
      fetchCount++;
      if (fetchCount <= 2) {
        return new Promise<Response>((resolve) => releases.push(resolve));
      }
      return Promise.resolve(new Response(new Uint8Array([3])));
    },
    { maxResponseBytes: 8, maxRetainedResponses: 2 },
  );
  const firstPending = bridge(message("httpRequestStart", requestArgs()));
  const secondPending = bridge(message("httpRequestStart", requestArgs()));
  let extraRejected = false;
  try {
    await bridge(message("httpRequestStart", requestArgs()));
  } catch {
    extraRejected = true;
  }
  releases[0](new Response(new Uint8Array([1])));
  releases[1](new Response(new Uint8Array([2])));
  const retained = await Promise.all([firstPending, secondPending]);

  assert(extraRejected, "pending reservations must reject the extra start");
  assertEquals(fetchCount, 2, "pending capacity failure must not begin Fetch");
  for (let index = 0; index < retained.length; index++) {
    const requestId = retained[index].request_id;
    assertEquals(
      (await bridge(message("httpResponseReadBody", {
        request_id: requestId,
        chunk_len: 1,
      }))).chunk,
      [index + 1],
      `pending response ${index + 1}`,
    );
    await bridge(message("httpResponseEnd", { request_id: requestId }));
  }
});

Deno.test("HTTP bridge releases pending capacity after a retained fetch error", async () => {
  let rejectFirst!: (reason: Error) => void;
  let fetchCount = 0;
  const bridge = createHttpBridge(
    () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Promise<Response>((_resolve, reject) =>
          rejectFirst = reject
        );
      }
      return Promise.resolve(new Response(new Uint8Array([2])));
    },
    { maxResponseBytes: 8, maxRetainedResponses: 1 },
  );
  const firstPending = bridge(message("httpRequestStart", requestArgs()));
  let extraRejected = false;
  try {
    await bridge(message("httpRequestStart", requestArgs()));
  } catch {
    extraRejected = true;
  }
  rejectFirst(new Error("first failed"));
  const first = await firstPending;
  await bridge(message("httpResponseEnd", { request_id: first.request_id }));
  const replacement = await bridge(message("httpRequestStart", requestArgs()));

  assert(extraRejected, "pending error request must reserve capacity");
  assertEquals(
    fetchCount,
    2,
    "released error reservation permits replacement Fetch",
  );
  assertEquals(
    (await bridge(message("httpResponseReadBody", {
      request_id: replacement.request_id,
      chunk_len: 1,
    }))).chunk,
    [2],
    "replacement response",
  );
  await bridge(message("httpResponseEnd", {
    request_id: replacement.request_id,
  }));
});

Deno.test("HTTP bridge allocates before fetch and keeps overlapping offsets isolated", async () => {
  let releaseFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) =>
    releaseFirst = resolve
  );
  let fetchCount = 0;
  const bridge = createHttpBridge(() => {
    fetchCount++;
    if (fetchCount === 1) return firstResponse;
    return Promise.resolve(new Response(new Uint8Array([20, 21, 22])));
  });
  const request = (url: string) =>
    bridge(message("httpRequestStart", {
      method: Array.from(encoder.encode("GET")),
      url: Array.from(encoder.encode(url)),
      headers: [],
      body: [],
    }));

  const firstPending = request("https://example.test/first");
  const second = await request("https://example.test/second");
  assertEquals(second.request_id, 2, "second request ID");
  releaseFirst(new Response(new Uint8Array([10, 11, 12])));
  const first = await firstPending;
  assertEquals(first.request_id, 1, "first request ID");
  assert(
    first.request_id !== 0 && second.request_id !== 0,
    "request IDs must not be zero",
  );

  assertEquals(
    (await bridge(message("httpResponseReadBody", {
      request_id: 1,
      chunk_len: 1,
    }))).chunk,
    [10],
    "first response first chunk",
  );
  assertEquals(
    (await bridge(message("httpResponseReadBody", {
      request_id: 2,
      chunk_len: 2,
    }))).chunk,
    [20, 21],
    "second response chunk",
  );
  assertEquals(
    (await bridge(message("httpResponseReadBody", {
      request_id: 1,
      chunk_len: 2,
    }))).chunk,
    [11, 12],
    "first response independent offset",
  );

  await bridge(message("httpResponseEnd", { request_id: 1 }));
  assertEquals(
    (await bridge(message("httpResponseReadBody", {
      request_id: 2,
      chunk_len: 1,
    }))).chunk,
    [22],
    "ending one request preserves another",
  );
  await assertRejects(
    () =>
      bridge(message("httpResponseReadBody", { request_id: 1, chunk_len: 1 })),
    "ended request ID must fail",
  );
  await assertRejects(
    () => bridge(message("httpResponseEnd", { request_id: 1 })),
    "ending an ended request ID must fail",
  );
  await assertRejects(
    () =>
      bridge(
        message("httpResponseReadHeaders", { request_id: 999, chunk_len: 1 }),
      ),
    "unknown request ID must fail",
  );
});

Deno.test("HTTP bridge retains explicit fetch errors", async () => {
  const bridge = createHttpBridge(() =>
    Promise.reject(new Error("network down"))
  );
  const metadata = await bridge(message("httpRequestStart", {
    method: Array.from(encoder.encode("GET")),
    url: Array.from(encoder.encode("https://example.test/error")),
    headers: [],
    body: [],
  }));
  assertEquals(metadata.status, 0, "error status");
  assertEquals(metadata.headers_len, 0, "error headers length");
  assertEquals(metadata.body_len, 0, "error body length");
  assert(metadata.error_len > 0, "error bytes must be retained");

  const errorChunk = await bridge(message("httpResponseReadError", {
    request_id: metadata.request_id,
    chunk_len: MAX_CHUNK_SIZE + 1,
  }));
  assertEquals(
    decoder.decode(new Uint8Array(errorChunk.chunk)),
    "network down",
    "fetch error",
  );
});

Deno.test("browser and Deno farms route all HTTP messages through the shared bridge", async () => {
  const root = new URL("../", import.meta.url);
  const xterm = await Deno.readTextFile(new URL("page/src/xterm.tsx", root));
  const denoFarm = await Deno.readTextFile(
    new URL("scripts/vfs_debug_shell.ts", root),
  );
  const denoWorker = await Deno.readTextFile(
    new URL("scripts/vfs_debug_shell_worker.ts", root),
  );
  for (const source of [xterm, denoFarm]) {
    assert(
      source.includes("createHttpBridge"),
      "farm must use the shared HTTP bridge",
    );
  }
  assert(
    denoWorker.includes("isHttpBridgeMessage(message)") &&
      denoWorker.includes("animal.call_unknown_fn(_index, message)"),
    "Deno worker must route shared HTTP messages through the farm",
  );
  assert(
    /new WASIFarm\([\s\S]*\[\],[\s\S]*\{[\s\S]*unknown_fn:/.test(denoFarm),
    "Deno WASIFarm must receive unknown_fn in its options argument",
  );
});
