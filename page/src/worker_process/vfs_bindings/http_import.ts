type MemoryImport = { [key: string]: WebAssembly.Memory };
type CallUnknownFn = (index: number, message: unknown) => unknown;

const MAX_CHUNK_SIZE = 16 * 1024;

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value && typeof value === "object") {
    return new Uint8Array(Object.values(value) as number[]);
  }
  throw new TypeError("HTTP bridge returned invalid bytes");
}

export function createHttpImports(
  memory: MemoryImport,
  callUnknownFn: CallUnknownFn,
) {
  const copyInput = (pointer: number, length: number) =>
    Array.from(new Uint8Array(memory.memory.buffer, pointer, length));

  const toU32 = (value: unknown) => {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
      throw new RangeError("HTTP bridge returned invalid scalar metadata");
    }
    return value as number;
  };

  const read = (name: string, requestId: number, pointer: number, length: number) => {
    if (!Number.isInteger(length) || length < 0 || length > MAX_CHUNK_SIZE) return 1;
    if (length === 0) return 0;
    try {
      const response = callUnknownFn(0, {
        name,
        args: { request_id: requestId, chunk_len: length },
      }) as { chunk?: unknown } | undefined;
      const chunk = toBytes(response?.chunk);
      if (chunk.length !== length) return 1;
      new Uint8Array(memory.memory.buffer, pointer, chunk.length).set(chunk);
      return 0;
    } catch {
      return 1;
    }
  };

  return {
    requestStart: (
      methodPointer: number,
      methodLength: number,
      urlPointer: number,
      urlLength: number,
      headersPointer: number,
      headersLength: number,
      bodyPointer: number,
      bodyLength: number,
      outRequestId: number,
      outStatus: number,
      outHeadersLength: number,
      outBodyLength: number,
      outErrorLength: number,
    ) => {
      let requestId: number | undefined;
      try {
        const request = {
          method: copyInput(methodPointer, methodLength),
          url: copyInput(urlPointer, urlLength),
          headers: copyInput(headersPointer, headersLength),
          body: copyInput(bodyPointer, bodyLength),
        };
        const response = callUnknownFn(0, {
          name: "httpRequestStart",
          args: request,
        }) as Record<string, unknown> | undefined;
        if (!response) return 1;

        requestId = toU32(response.request_id);
        if (requestId === 0) throw new RangeError("HTTP request ID 0 is reserved");

        const view = new DataView(memory.memory.buffer);
        const values = [
          requestId,
          toU32(response.status),
          toU32(response.headers_len),
          toU32(response.body_len),
          toU32(response.error_len),
        ];
        const pointers = [
          outRequestId,
          outStatus,
          outHeadersLength,
          outBodyLength,
          outErrorLength,
        ];
        for (const pointer of pointers) {
          if (
            !Number.isInteger(pointer) || pointer < 0 ||
            pointer > view.byteLength - Uint32Array.BYTES_PER_ELEMENT
          ) {
            throw new RangeError("HTTP metadata output pointer is out of bounds");
          }
        }
        pointers.forEach((pointer, index) => {
          view.setUint32(pointer, values[index], true);
        });
        return 0;
      } catch {
        if (requestId !== undefined) {
          try {
            callUnknownFn(0, {
              name: "httpResponseEnd",
              args: { request_id: requestId },
            });
          } catch {
            // The bridge is already failing; cleanup remains best-effort.
          }
        }
        return 1;
      }
    },
    responseReadHeaders: (requestId: number, pointer: number, length: number) =>
      read("httpResponseReadHeaders", requestId, pointer, length),
    responseReadBody: (requestId: number, pointer: number, length: number) =>
      read("httpResponseReadBody", requestId, pointer, length),
    responseReadError: (requestId: number, pointer: number, length: number) =>
      read("httpResponseReadError", requestId, pointer, length),
    responseEnd: (requestId: number) => {
      try {
        callUnknownFn(0, {
          name: "httpResponseEnd",
          args: { request_id: requestId },
        });
        return 0;
      } catch {
        return 1;
      }
    },
  };
}
