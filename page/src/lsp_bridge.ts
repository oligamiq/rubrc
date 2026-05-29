import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  DataCallback,
  Message,
  createMessageConnection,
  MessageConnection
} from 'vscode-jsonrpc/browser';
import type { Ctx } from "./ctx";

const LSP_SESSION_ID = 0xFFFFFFFF;

class MyMessageReader extends AbstractMessageReader {
  private ctx: Ctx;
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(ctx: Ctx) {
    super();
    this.ctx = ctx;
  }

  private appendToBuffer(data: Uint8Array) {
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer);
    newBuffer.set(data, this.buffer.length);
    this.buffer = newBuffer;
  }

  listen(callback: DataCallback): void {
    console.log("[LSP Bridge] MessageReader listening on ls_id:", this.ctx.ls_id);
    new SharedObject(({ data }: { data: Uint8Array }) => {
      this.appendToBuffer(data);
      this.processBuffer(callback);
    }, this.ctx.ls_id);
  }

  private processBuffer(callback: DataCallback) {
    while (true) {
      const headerEnd = this.findHeaderEnd();
      if (headerEnd === -1) break;

      const header = new TextDecoder().decode(this.buffer.slice(0, headerEnd));
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        console.error("[LSP Bridge] Missing Content-Length in header:", header);
        this.buffer = this.buffer.slice(headerEnd + 4); // Skip broken header
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + contentLength) break;

      const messageData = this.buffer.slice(messageStart, messageStart + contentLength);
      this.buffer = this.buffer.slice(messageStart + contentLength);

      const messageStr = new TextDecoder().decode(messageData);
      console.log("[LSP Bridge] Received message from worker:", messageStr);
      try {
        const message = JSON.parse(messageStr);
        callback(message);
      } catch (e) {
        console.error("[LSP Bridge] Failed to parse LSP message", e, messageStr);
      }
    }
  }

  private findHeaderEnd(): number {
    for (let i = 0; i < this.buffer.length - 3; i++) {
      if (
        this.buffer[i] === 13 && this.buffer[i + 1] === 10 &&
        this.buffer[i + 2] === 13 && this.buffer[i + 3] === 10
      ) {
        return i;
      }
    }
    return -1;
  }
}

class MyMessageWriter extends AbstractMessageWriter {
  private inputStringProxy: any;

  constructor(ctx: Ctx) {
    super();
    console.log("[LSP Bridge] Creating MessageWriter with input_string_id:", ctx.input_string_id);
    this.inputStringProxy = new SharedObjectRef(ctx.input_string_id).proxy<
      (args: { sessionId: number, data: string }) => Promise<void>
    >();
  }

  async write(msg: Message): Promise<void> {
    const jsonStr = JSON.stringify(msg);
    const data = `Content-Length: ${new TextEncoder().encode(jsonStr).length}\r\n\r\n${jsonStr}`;
    if (msg.method !== '$/setTrace' && msg.method !== '$/logTrace') {
      console.log("[LSP Bridge] Writing message to worker (session LSP):", jsonStr);
    }
    await this.inputStringProxy({ sessionId: LSP_SESSION_ID, data });
  }

  end(): void { }
}

export function createLspConnection(ctx: Ctx) {
  const reader = new MyMessageReader(ctx);
  const writer = new MyMessageWriter(ctx);
  return { reader, writer };
}
