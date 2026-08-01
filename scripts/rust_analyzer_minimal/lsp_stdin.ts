import type { JsonRpcMessage } from "./lsp_stream.ts";

export class AsyncLspInputQueue {
  #chunks: Uint8Array[] = [];
  #chunkIndex = 0;
  #chunkOffset = 0;
  #waiters: Array<{
    maxLength: number;
    resolve: (bytes: number[]) => void;
  }> = [];

  push(message: JsonRpcMessage): void {
    this.#chunks.push(frame(message));
    this.#flush();
  }

  read(maxLength: number): Promise<number[]> {
    assertU32(maxLength, "maximum read length");
    if (maxLength === 0) return Promise.resolve([]);
    if (this.#chunkIndex < this.#chunks.length) {
      return Promise.resolve(Array.from(this.#take(maxLength)));
    }
    return new Promise((resolve) => {
      this.#waiters.push({ maxLength, resolve });
    });
  }

  #flush(): void {
    while (
      this.#waiters.length > 0 && this.#chunkIndex < this.#chunks.length
    ) {
      const waiter = this.#waiters.shift()!;
      waiter.resolve(Array.from(this.#take(waiter.maxLength)));
    }
  }

  #take(maxLength: number): Uint8Array {
    const output = new Uint8Array(maxLength);
    let written = 0;
    while (
      written < maxLength && this.#chunkIndex < this.#chunks.length
    ) {
      const chunk = this.#chunks[this.#chunkIndex];
      const available = chunk.byteLength - this.#chunkOffset;
      const copyLength = Math.min(maxLength - written, available);
      output.set(
        chunk.subarray(this.#chunkOffset, this.#chunkOffset + copyLength),
        written,
      );
      written += copyLength;
      this.#chunkOffset += copyLength;
      if (this.#chunkOffset === chunk.byteLength) {
        this.#chunkIndex++;
        this.#chunkOffset = 0;
      }
    }
    return output.slice(0, written);
  }
}

export function createLspStdinFdRead(
  memory: WebAssembly.Memory,
  originalFdRead: (...args: number[]) => unknown,
  read: (maxLength: number) => unknown,
): (fd: number, iovs: number, iovsLength: number, nread: number) => unknown {
  return (fd, iovs, iovsLength, nread) => {
    if (fd !== 0) return originalFdRead(fd, iovs, iovsLength, nread);

    const iovecCount = iovsLength >>> 0;
    const iovecBytes = checkedMultiply(iovecCount, 8, "iovec array");
    const iovecPtr = checkedRange(memory, iovs, iovecBytes, "iovec array");
    const nreadPtr = checkedRange(memory, nread, 4, "nread");
    const fields = new DataView(memory.buffer);
    const decoded: Array<{ ptr: number; length: number }> = [];
    let maxLength = 0;
    for (let index = 0; index < iovecCount; index++) {
      const offset = iovecPtr + index * 8;
      const ptr = fields.getUint32(offset, true);
      const length = fields.getUint32(offset + 4, true);
      checkedRange(memory, ptr, length, `iovec ${index}`);
      maxLength = checkedAdd(maxLength, length, "total iovec length");
      decoded.push({ ptr, length });
    }

    const bytes = toUint8Array(read(maxLength));
    if (bytes.byteLength > maxLength) {
      throw new Error(
        `LSP stdin returned ${bytes.byteLength} bytes for ${maxLength} bytes of iovec capacity`,
      );
    }
    const memoryBytes = new Uint8Array(memory.buffer);
    let sourceOffset = 0;
    for (const iovec of decoded) {
      const copyLength = Math.min(
        iovec.length,
        bytes.byteLength - sourceOffset,
      );
      if (copyLength <= 0) break;
      memoryBytes.set(
        bytes.subarray(sourceOffset, sourceOffset + copyLength),
        iovec.ptr,
      );
      sourceOffset += copyLength;
    }
    fields.setUint32(nreadPtr, bytes.byteLength, true);
    return 0;
  };
}

function frame(message: JsonRpcMessage): Uint8Array {
  const body = JSON.stringify(message);
  const bodyBytes = new TextEncoder().encode(body);
  const headerBytes = new TextEncoder().encode(
    `Content-Length: ${bodyBytes.byteLength}\r\n\r\n`,
  );
  const framed = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
  framed.set(headerBytes);
  framed.set(bodyBytes, headerBytes.byteLength);
  return framed;
}

function toUint8Array(value: unknown): Uint8Array {
  const values = Array.isArray(value)
    ? value
    : isRecord(value)
    ? Object.values(value)
    : undefined;
  if (
    values === undefined ||
    !values.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new Error("LSP stdin callback must return plain bytes");
  }
  return new Uint8Array(values as number[]);
}

function checkedRange(
  memory: WebAssembly.Memory,
  rawPtr: number,
  length: number,
  label: string,
): number {
  const ptr = rawPtr >>> 0;
  const end = ptr + length;
  if (end > memory.buffer.byteLength || end < ptr) {
    throw new Error(`${label} is outside memory bounds`);
  }
  return ptr;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result > 0xffff_ffff) {
    throw new Error(`${label} length overflow`);
  }
  return result;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > 0xffff_ffff) {
    throw new Error(`${label} overflow`);
  }
  return result;
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be a u32`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

if (Deno.mainModule === import.meta.url) {
  Deno.test("async LSP input waits until a framed message is pushed", async () => {
    const input = new AsyncLspInputQueue();
    let settled = false;
    const pending = input.read(12).then((bytes) => {
      settled = true;
      return bytes;
    });
    await Promise.resolve();
    assert(!settled, "empty read resolved before input was pushed");

    input.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const bytes = await pending;

    assertEquals(
      new TextDecoder().decode(new Uint8Array(bytes)),
      "Content-Leng",
      "first framed bytes",
    );
  });

  Deno.test("stdin fd_read copies plain bytes across guest iovecs", () => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const fields = new DataView(memory.buffer);
    fields.setUint32(32, 100, true);
    fields.setUint32(36, 3, true);
    fields.setUint32(40, 200, true);
    fields.setUint32(44, 4, true);
    let requestedLength = 0;
    const fdRead = createLspStdinFdRead(
      memory,
      () => {
        throw new Error("stdin must not delegate");
      },
      (maxLength) => {
        requestedLength = maxLength;
        return { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5 };
      },
    );

    const ret = fdRead(0, 32, 2, 48);

    assertEquals(ret, 0, "WASI return code");
    assertEquals(requestedLength, 7, "maximum read length");
    assertEquals(
      Array.from(new Uint8Array(memory.buffer, 100, 3)),
      [1, 2, 3],
      "first iovec",
    );
    assertEquals(
      Array.from(new Uint8Array(memory.buffer, 200, 2)),
      [4, 5],
      "second iovec",
    );
    assertEquals(fields.getUint32(48, true), 5, "nread");
  });

  Deno.test("stdin fd_read delegates nonzero descriptors unchanged", () => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    let delegated: number[] | undefined;
    const fdRead = createLspStdinFdRead(
      memory,
      (...args) => {
        delegated = args;
        return 73;
      },
      () => {
        throw new Error("non-stdin read must not call the host callback");
      },
    );

    assertEquals(fdRead(4, 8, 2, 16), 73, "delegated return code");
    assertEquals(delegated, [4, 8, 2, 16], "delegated arguments");
  });
}
