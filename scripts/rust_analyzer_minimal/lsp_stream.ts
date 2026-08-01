import { Fd, wasi } from "@bjorn3/browser_wasi_shim";

export type JsonRpcMessage = Record<string, unknown>;

export class LspInputFd extends Fd {
  #chunks: Uint8Array[] = [];
  #chunkIndex = 0;
  #chunkOffset = 0;

  push(message: JsonRpcMessage): void {
    this.#chunks.push(frame(message));
  }

  pushMany(messages: JsonRpcMessage[]): void {
    for (const message of messages) this.#chunks.push(frame(message));
  }

  override fd_read(size: number): { ret: number; data: Uint8Array } {
    const data = new Uint8Array(size);
    let written = 0;
    while (written < size && this.#chunkIndex < this.#chunks.length) {
      const chunk = this.#chunks[this.#chunkIndex];
      const available = chunk.byteLength - this.#chunkOffset;
      const copyLength = Math.min(size - written, available);
      data.set(
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
    return { ret: wasi.ERRNO_SUCCESS, data: data.slice(0, written) };
  }

  override fd_fdstat_get(): ReturnType<Fd["fd_fdstat_get"]> {
    return {
      ret: wasi.ERRNO_SUCCESS,
      fdstat: new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0),
    };
  }
}

export class LspOutputFd extends Fd {
  #buffer = new Uint8Array();
  #messages: JsonRpcMessage[] = [];
  #waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  override fd_write(
    data: Uint8Array,
  ): { ret: number; nwritten: number } {
    this.#buffer = concatBytes(this.#buffer, data);
    this.#parseMessages();
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }

  override fd_fdstat_get(): ReturnType<Fd["fd_fdstat_get"]> {
    return {
      ret: wasi.ERRNO_SUCCESS,
      fdstat: new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0),
    };
  }

  waitFor(
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs: number,
  ): Promise<JsonRpcMessage> {
    const existing = this.#messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new Error(`Timed out waiting for LSP message after ${timeoutMs}ms`),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #parseMessages(): void {
    while (true) {
      const headerEnd = findHeaderEnd(this.#buffer);
      if (headerEnd === -1) return;

      const header = new TextDecoder().decode(
        this.#buffer.subarray(0, headerEnd),
      );
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(
        header,
      );
      if (!match) throw new Error("LSP message is missing Content-Length");

      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const messageEnd = bodyStart + contentLength;
      if (this.#buffer.byteLength < messageEnd) return;

      const body = this.#buffer.subarray(bodyStart, messageEnd);
      const message = JSON.parse(
        new TextDecoder().decode(body),
      ) as JsonRpcMessage;
      this.#buffer = this.#buffer.slice(messageEnd);
      this.#messages.push(message);

      for (const waiter of this.#waiters) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timeout);
        this.#waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function findHeaderEnd(data: Uint8Array): number {
  for (let index = 0; index <= data.byteLength - 4; index++) {
    if (
      data[index] === 13 && data[index + 1] === 10 &&
      data[index + 2] === 13 && data[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

function frame(message: JsonRpcMessage): Uint8Array {
  const body = JSON.stringify(message);
  return new TextEncoder().encode(
    `Content-Length: ${
      new TextEncoder().encode(body).byteLength
    }\r\n\r\n${body}`,
  );
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

if (Deno.mainModule === import.meta.url) {
  Deno.test("LspInputFd batches multiple framed messages", () => {
    const input = new LspInputFd();
    const first = { jsonrpc: "2.0", method: "initialized", params: {} };
    const second = {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 99 },
    };
    input.pushMany([first, second]);

    const expected = concatBytes(frame(first), frame(second));
    assertEquals(input.fd_read(expected.byteLength).data, expected);
  });

  Deno.test("LspOutputFd buffers a split Content-Length header", async () => {
    const output = new LspOutputFd();
    const message = { jsonrpc: "2.0", id: 1, result: { capabilities: {} } };
    const bytes = frame(message);
    const headerSplit = 10;

    output.fd_write(bytes.subarray(0, headerSplit));
    output.fd_write(bytes.subarray(headerSplit));

    assertEquals(await output.waitFor((value) => value.id === 1, 100), message);
  });

  Deno.test("LspOutputFd buffers a split JSON-RPC body", async () => {
    const output = new LspOutputFd();
    const message = {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { diagnostics: [{ message: "expected expression" }] },
    };
    const bytes = frame(message);
    const bodyStart = new TextDecoder().decode(bytes).indexOf("\r\n\r\n") +
      4;
    const bodySplit = bodyStart + 7;

    output.fd_write(bytes.subarray(0, bodySplit));
    output.fd_write(bytes.subarray(bodySplit));

    assertEquals(
      await output.waitFor(
        (value) => value.method === "textDocument/publishDiagnostics",
        100,
      ),
      message,
    );
  });

  Deno.test("LspOutputFd parses multiple messages from one write", async () => {
    const output = new LspOutputFd();
    const first = { jsonrpc: "2.0", id: 1, result: null };
    const second = { jsonrpc: "2.0", id: 2, result: { ok: true } };
    const firstBytes = frame(first);
    const secondBytes = frame(second);
    const combined = new Uint8Array(
      firstBytes.byteLength + secondBytes.byteLength,
    );
    combined.set(firstBytes);
    combined.set(secondBytes, firstBytes.byteLength);

    output.fd_write(combined);

    assertEquals(await output.waitFor((value) => value.id === 1, 100), first);
    assertEquals(await output.waitFor((value) => value.id === 2, 100), second);
  });
}
