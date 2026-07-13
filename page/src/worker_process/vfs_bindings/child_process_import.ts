type MemoryImport = { [key: string]: WebAssembly.Memory };
type CallUnknownFn = (index: number, message: unknown) => unknown;

const MAX_MODULE_CHUNK_SIZE = 256 * 1024;
const MAX_ERROR_CHUNK_SIZE = 64 * 1024;

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  let values: unknown[];
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new TypeError("child process bridge returned sparse bytes");
    }
    values = value;
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.some(([key], index) => key !== String(index))) {
      throw new TypeError("child process bridge returned sparse bytes");
    }
    values = entries.map(([, byte]) => byte);
  } else {
    throw new TypeError("child process bridge returned invalid bytes");
  }

  if (
    values.some((byte) =>
      !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255
    )
  ) {
    throw new TypeError("child process bridge returned invalid bytes");
  }
  return new Uint8Array(values as number[]);
}

export function createChildProcessImports(
  memory: MemoryImport,
  callUnknownFn: CallUnknownFn,
) {
  const toU32 = (value: unknown) => {
    if (
      !Number.isInteger(value) || (value as number) < 0 ||
      (value as number) > 0xffff_ffff
    ) {
      throw new RangeError(
        "child process bridge returned invalid scalar metadata",
      );
    }
    return value as number;
  };

  const requestId = (value: unknown) => {
    const id = toU32(value);
    if (id === 0) {
      throw new RangeError("child process request ID 0 is reserved");
    }
    return id;
  };

  const checkedRange = (pointer: number, length: number) => {
    const byteLength = memory.memory.buffer.byteLength;
    if (
      !Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 ||
      length < 0 ||
      pointer > byteLength || length > byteLength - pointer
    ) {
      throw new RangeError("child process memory range is out of bounds");
    }
  };

  const copyInput = (pointer: number, length: number) => {
    checkedRange(pointer, length);
    return Array.from(new Uint8Array(memory.memory.buffer, pointer, length));
  };

  const writeMetadata = (pointers: number[], values: number[]) => {
    const view = new DataView(memory.memory.buffer);
    for (const pointer of pointers) {
      if (
        !Number.isInteger(pointer) || pointer < 0 ||
        pointer > view.byteLength - Uint32Array.BYTES_PER_ELEMENT
      ) {
        throw new RangeError(
          "child process metadata output pointer is out of bounds",
        );
      }
    }
    pointers.forEach((pointer, index) =>
      view.setUint32(pointer, values[index], true)
    );
  };

  const stateMetadata = (response: Record<string, unknown> | undefined) => {
    if (!response) {
      throw new TypeError("child process bridge returned no metadata");
    }
    return [
      toU32(response.state),
      toU32(response.status),
      toU32(response.error_len),
    ];
  };

  return {
    requestStart: (
      argvPointer: number,
      argvLength: number,
      envPointer: number,
      envLength: number,
      moduleLength: number,
      outRequestId: number,
    ) => {
      let startedRequestId: number | undefined;
      try {
        const argv = copyInput(argvPointer, argvLength);
        const env = copyInput(envPointer, envLength);
        const response = callUnknownFn(0, {
          name: "childProcessStart",
          args: { argv, env, module_len: toU32(moduleLength) },
        }) as Record<string, unknown> | undefined;
        if (!response) return 1;
        startedRequestId = requestId(response.request_id);
        stateMetadata(response);
        writeMetadata([outRequestId], [startedRequestId]);
        return 0;
      } catch {
        if (startedRequestId !== undefined) {
          try {
            callUnknownFn(0, {
              name: "childProcessEnd",
              args: { request_id: startedRequestId },
            });
          } catch {
            // Cleanup is best-effort after the bridge has already failed.
          }
        }
        return 1;
      }
    },
    requestWrite: (
      id: number,
      pointer: number,
      length: number,
    ) => {
      try {
        const validId = requestId(id);
        if (
          !Number.isInteger(length) || length < 0 ||
          length > MAX_MODULE_CHUNK_SIZE
        ) return 1;
        const chunk = copyInput(pointer, length);
        const response = callUnknownFn(0, {
          name: "childProcessWrite",
          args: { request_id: validId, chunk },
        }) as Record<string, unknown> | undefined;
        if (!response || requestId(response.request_id) !== validId) return 1;
        stateMetadata(response);
        return 0;
      } catch {
        return 1;
      }
    },
    requestRun: (
      id: number,
      outStatus: number,
      outErrorLength: number,
    ) => {
      try {
        const validId = requestId(id);
        const response = callUnknownFn(0, {
          name: "childProcessRun",
          args: { request_id: validId },
        }) as Record<string, unknown> | undefined;
        const [, status, errorLength] = stateMetadata(response);
        writeMetadata([outStatus, outErrorLength], [status, errorLength]);
        return 0;
      } catch {
        return 1;
      }
    },
    requestReadError: (id: number, pointer: number, length: number) => {
      try {
        const validId = requestId(id);
        if (
          !Number.isInteger(length) || length < 0 ||
          length > MAX_ERROR_CHUNK_SIZE
        ) return 1;
        checkedRange(pointer, length);
        if (length === 0) return 0;
        const response = callUnknownFn(0, {
          name: "childProcessReadError",
          args: { request_id: validId, chunk_len: length },
        }) as { chunk?: unknown } | undefined;
        const chunk = toBytes(response?.chunk);
        if (chunk.length !== length) return 1;
        new Uint8Array(memory.memory.buffer, pointer, length).set(chunk);
        return 0;
      } catch {
        return 1;
      }
    },
    requestRecover: (
      outRequestId: number,
      outState: number,
      outStatus: number,
      outErrorLength: number,
    ) => {
      try {
        const response = callUnknownFn(0, {
          name: "childProcessRecover",
          args: {},
        }) as Record<string, unknown> | undefined;
        if (!response) return 1;
        const recoveredId = toU32(response.request_id);
        const values = [recoveredId, ...stateMetadata(response)];
        writeMetadata(
          [outRequestId, outState, outStatus, outErrorLength],
          values,
        );
        return 0;
      } catch {
        return 1;
      }
    },
    requestEnd: (id: number) => {
      try {
        callUnknownFn(0, {
          name: "childProcessEnd",
          args: { request_id: requestId(id) },
        });
        return 0;
      } catch {
        return 1;
      }
    },
  };
}
