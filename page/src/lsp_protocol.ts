export const LSP_SESSION_ID = 0xffff_ffff;
export const VFS_SYNC_SESSION_ID = 0xeeee_eeee;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

export const isLspSession = (sessionId: number): boolean =>
  (sessionId >>> 0) === LSP_SESSION_ID;

export function toLspBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (!Array.isArray(value)) {
    throw new Error("LSP payload must be a byte array");
  }
  const result = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`invalid LSP byte at index ${index}`);
    }
    result[index] = byte;
  }
  return result;
}

export function encodeLspMessage(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header);
  frame.set(body, header.length);
  return frame;
}

export class LspFrameDecoder {
  private buffer = new Uint8Array();

  push(chunk: unknown): unknown[] {
    const bytes = toLspBytes(chunk);
    const combined = new Uint8Array(this.buffer.length + bytes.length);
    combined.set(this.buffer);
    combined.set(bytes, this.buffer.length);
    this.buffer = combined;

    const messages: unknown[] = [];
    while (true) {
      const headerEnd = this.findHeaderEnd();
      if (headerEnd < 0) return messages;
      const header = decoder.decode(this.buffer.slice(0, headerEnd));
      const matches = [
        ...header.matchAll(/^Content-Length:[ \t]*(\d+)\r?$/gim),
      ];
      if (matches.length !== 1) {
        throw new Error("invalid LSP Content-Length header");
      }
      const length = Number(matches[0][1]);
      if (!Number.isSafeInteger(length)) {
        throw new Error("invalid LSP body length");
      }
      const bodyStart = headerEnd + HEADER_END.length;
      if (this.buffer.length < bodyStart + length) return messages;
      const body = decoder.decode(
        this.buffer.slice(bodyStart, bodyStart + length),
      );
      const message = JSON.parse(body);
      if (typeof message !== "object" || message === null) {
        throw new Error("LSP body must be a JSON object");
      }
      messages.push(message);
      this.buffer = this.buffer.slice(bodyStart + length);
    }
  }

  private findHeaderEnd(): number {
    outer: for (
      let index = 0;
      index <= this.buffer.length - HEADER_END.length;
      index++
    ) {
      for (let offset = 0; offset < HEADER_END.length; offset++) {
        if (this.buffer[index + offset] !== HEADER_END[offset]) continue outer;
      }
      return index;
    }
    return -1;
  }
}

export class OrderedLspSender {
  private pending = Promise.resolve();

  constructor(
    private readonly send: (bytes: number[]) => Promise<void>,
  ) {}

  write(message: unknown): Promise<void> {
    const bytes = Array.from(encodeLspMessage(message));
    const write = this.pending.then(() => this.send(bytes));
    this.pending = write.catch(() => undefined);
    return write;
  }
}

