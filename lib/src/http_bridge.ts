const MAX_CHUNK_SIZE = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_RESPONSES = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export const HTTP_BRIDGE_MESSAGE_NAMES = [
  "httpRequestStart",
  "httpResponseReadHeaders",
  "httpResponseReadBody",
  "httpResponseReadError",
  "httpResponseEnd",
] as const;

type HttpBridgeMessageName = typeof HTTP_BRIDGE_MESSAGE_NAMES[number];

export interface HttpBridgeMessage {
  name: HttpBridgeMessageName;
  args: Record<string, unknown>;
}

interface HttpStartResult {
  request_id: number;
  status: number;
  headers_len: number;
  body_len: number;
  error_len: number;
}

interface HttpBridge {
  (
    message: HttpBridgeMessage & { name: "httpRequestStart" },
  ): Promise<HttpStartResult>;
  (
    message: HttpBridgeMessage & {
      name:
        | "httpResponseReadHeaders"
        | "httpResponseReadBody"
        | "httpResponseReadError";
    },
  ): Promise<{ chunk: number[] }>;
  (
    message: HttpBridgeMessage & { name: "httpResponseEnd" },
  ): Promise<Record<string, never>>;
  (
    message: HttpBridgeMessage,
  ): Promise<HttpStartResult | { chunk: number[] } | Record<string, never>>;
}

interface ResponseState {
  headers: Uint8Array;
  body: Uint8Array;
  error: Uint8Array;
  headersOffset: number;
  bodyOffset: number;
  errorOffset: number;
}

export interface HttpBridgeOptions {
  maxResponseBytes?: number;
  maxRetainedResponses?: number;
  signal?: AbortSignal;
}

export interface HttpBridgeOwner {
  handle: HttpBridge;
  abort(reason?: unknown): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

export function isHttpBridgeMessage(
  value: unknown,
): value is HttpBridgeMessage {
  if (!value || typeof value !== "object") return false;
  const { name, args } = value as { name?: unknown; args?: unknown };
  return typeof name === "string" &&
    !!args && typeof args === "object" && !Array.isArray(args) &&
    HTTP_BRIDGE_MESSAGE_NAMES.some((candidate) => candidate === name);
}

function bytes(value: unknown, field: string): Uint8Array<ArrayBuffer> {
  if (!Array.isArray(value)) {
    throw new TypeError(`HTTP ${field} must be a byte array`);
  }
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!Number.isInteger(item) || item < 0 || item > 255) {
      throw new TypeError(`HTTP ${field} must be a byte array`);
    }
  }
  return Uint8Array.from(value as number[]);
}

function requestHeaders(value: unknown): Headers {
  const headers = new Headers();
  const encoded = decoder.decode(bytes(value, "headers"));
  for (const encodedLine of encoded.split("\n")) {
    const line = encodedLine.endsWith("\r")
      ? encodedLine.slice(0, -1)
      : encodedLine;
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new TypeError("HTTP request header is malformed");
    headers.append(line.slice(0, separator), line.slice(separator + 1));
  }
  return headers;
}

function responseHeaders(headers: Headers): Uint8Array {
  let encoded = "";
  for (const [key, value] of headers) encoded += `${key}:${value}\n`;
  return encoder.encode(encoded);
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
  reason: string,
) {
  try {
    await body?.cancel(reason);
  } catch {
    // Cancellation is best-effort after the response has already been rejected.
  }
}

async function responseBody(
  response: Response,
  maxBytes: number,
  readers: Set<ReadableStreamDefaultReader<Uint8Array>>,
  signal: AbortSignal,
) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null && /^\d+$/.test(contentLength) &&
    BigInt(contentLength) > BigInt(maxBytes)
  ) {
    const message = `HTTP response body exceeds ${maxBytes} bytes`;
    await cancelBody(response.body, message);
    throw new RangeError(message);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  readers.add(reader);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > maxBytes - total) {
        const message = `HTTP response body exceeds ${maxBytes} bytes`;
        try {
          await reader.cancel(message);
        } catch {
          // Cancellation is best-effort after the size limit has been exceeded.
        }
        throw new RangeError(message);
      }
      chunks.push(value.slice());
      total += value.length;
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // A failed or closed stream may reject cancellation.
    }
    throw error;
  } finally {
    reader.releaseLock();
    readers.delete(reader);
  }

  signal.throwIfAborted();

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function integerArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`HTTP ${name} must be a non-negative integer`);
  }
  return value as number;
}

export function createHttpBridgeOwner(
  fetchImpl: typeof fetch = fetch,
  options: HttpBridgeOptions = {},
): HttpBridgeOwner {
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxRetainedResponses = options.maxRetainedResponses ??
    MAX_RETAINED_RESPONSES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0) {
    throw new RangeError(
      "maxResponseBytes must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(maxRetainedResponses) || maxRetainedResponses < 1) {
    throw new RangeError(
      "maxRetainedResponses must be a positive safe integer",
    );
  }
  const responses = new Map<number, ResponseState>();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const active = new Set<Promise<unknown>>();
  const controller = new AbortController();
  let nextRequestId = 1;
  let pendingRequests = 0;
  let disposePromise: Promise<void> | undefined;

  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    void operation.catch(() => undefined).finally(() => active.delete(operation));
    return operation;
  };

  const settle = async () => {
    await Promise.allSettled([...active]);
  };

  const abort = (
    reason: unknown = new DOMException("runtime disposed", "AbortError"),
  ) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    for (const reader of readers) {
      void reader.cancel(reason).catch(() => undefined);
    }
  };

  const abortFromSignal = () => abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", abortFromSignal, { once: true });
  }

  const stateFor = (requestId: number) => {
    const state = responses.get(requestId);
    if (!state) {
      throw new Error(`Unknown or ended HTTP request ID: ${requestId}`);
    }
    return state;
  };

  const read = (
    args: Record<string, unknown>,
    field: "headers" | "body" | "error",
    offsetField: "headersOffset" | "bodyOffset" | "errorOffset",
  ) => {
    const state = stateFor(integerArg(args, "request_id"));
    const requested = integerArg(args, "chunk_len");
    const start = state[offsetField];
    const end = Math.min(
      start + requested,
      start + MAX_CHUNK_SIZE,
      state[field].length,
    );
    state[offsetField] = end;
    return { chunk: Array.from(state[field].subarray(start, end)) };
  };

  const dispatch = async (message: HttpBridgeMessage) => {
    const { args } = message;
    if (message.name === "httpRequestStart") {
      if (pendingRequests + responses.size >= maxRetainedResponses) {
        throw new RangeError("HTTP response capacity exhausted");
      }
      pendingRequests++;
      try {
        if (nextRequestId > 0xffff_ffff) {
          throw new RangeError("HTTP request IDs exhausted");
        }
        const requestId = nextRequestId++;
        try {
          const method = decoder.decode(bytes(args.method, "method"));
          const url = decoder.decode(bytes(args.url, "URL"));
          const parsedUrl = new URL(url);
          if (
            parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:"
          ) {
            throw new TypeError(
              `Unsupported HTTP URL protocol: ${parsedUrl.protocol}`,
            );
          }
          const body = bytes(args.body, "body");
          if (
            (method.toUpperCase() === "GET" ||
              method.toUpperCase() === "HEAD") &&
            body.length > 0
          ) {
            throw new TypeError(
              `${method.toUpperCase()} request body must be empty`,
            );
          }
          const response = await fetchImpl(url, {
            method,
            headers: requestHeaders(args.headers),
            body: body.length === 0 ? undefined : body as unknown as BodyInit,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          const headers = responseHeaders(response.headers);
          const responseBodyBytes = await responseBody(
            response,
            maxResponseBytes,
            readers,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          responses.set(requestId, {
            headers,
            body: responseBodyBytes,
            error: new Uint8Array(),
            headersOffset: 0,
            bodyOffset: 0,
            errorOffset: 0,
          });
          return {
            request_id: requestId,
            status: response.status,
            headers_len: headers.length,
            body_len: responseBodyBytes.length,
            error_len: 0,
          };
        } catch (error) {
          if (controller.signal.aborted) {
            throw controller.signal.reason;
          }
          const encodedError = encoder.encode(
            error instanceof Error ? error.message : String(error),
          );
          responses.set(requestId, {
            headers: new Uint8Array(),
            body: new Uint8Array(),
            error: encodedError,
            headersOffset: 0,
            bodyOffset: 0,
            errorOffset: 0,
          });
          return {
            request_id: requestId,
            status: 0,
            headers_len: 0,
            body_len: 0,
            error_len: encodedError.length,
          };
        }
      } finally {
        pendingRequests--;
      }
    }
    if (message.name === "httpResponseReadHeaders") {
      return read(args, "headers", "headersOffset");
    }
    if (message.name === "httpResponseReadBody") {
      return read(args, "body", "bodyOffset");
    }
    if (message.name === "httpResponseReadError") {
      return read(args, "error", "errorOffset");
    }
    if (message.name === "httpResponseEnd") {
      const requestId = integerArg(args, "request_id");
      stateFor(requestId);
      responses.delete(requestId);
      return {};
    }
    throw new Error(
      `Unknown HTTP bridge message: ${(message as { name: string }).name}`,
    );
  };

  const handle = ((message: HttpBridgeMessage) => {
    controller.signal.throwIfAborted();
    return track(dispatch(message));
  }) as HttpBridge;

  const dispose = () => {
    if (!disposePromise) {
      disposePromise = (async () => {
        abort();
        await settle();
        options.signal?.removeEventListener("abort", abortFromSignal);
        readers.clear();
        responses.clear();
      })();
    }
    return disposePromise;
  };

  return { handle, abort, settle, dispose };
}

export function createHttpBridge(
  fetchImpl: typeof fetch = fetch,
  options: HttpBridgeOptions = {},
): HttpBridge {
  return createHttpBridgeOwner(fetchImpl, options).handle;
}
