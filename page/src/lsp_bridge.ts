import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  DataCallback,
  Message,
  Disposable,
} from "vscode-jsonrpc/browser";
import type { Ctx } from "./ctx";
import {
  LspFrameDecoder,
  LSP_SESSION_ID,
  OrderedLspSender,
} from "./lsp_protocol";

class MyMessageReader extends AbstractMessageReader {
  private readonly decoder = new LspFrameDecoder();
  private shared: SharedObject | undefined;
  private closed = false;

  constructor(private readonly ctx: Ctx) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    if (this.shared) throw new Error("LSP reader already listening");
    this.shared = new SharedObject(({ data }: { data: unknown }) => {
      if (this.closed) return;
      try {
        for (const message of this.decoder.push(data)) {
          callback(message as Message);
        }
      } catch (error) {
        this.closed = true;
        this.fireError(error);
        this.fireClose();
        this.shared?.bc.close();
        this.shared = undefined;
      }
    }, this.ctx.ls_id);
    return { dispose: () => this.dispose() };
  }

  override dispose(): void {
    if (!this.closed) {
      this.closed = true;
      this.shared?.bc.close();
      this.shared = undefined;
    }
    super.dispose();
  }
}

class MyMessageWriter extends AbstractMessageWriter {
  private readonly inputStringProxy: (args: {
    sessionId: number;
    data: string | number[];
  }) => Promise<void>;
  private readonly sender: OrderedLspSender;

  constructor(ctx: Ctx) {
    super();
    this.inputStringProxy = new SharedObjectRef(ctx.input_string_id).proxy<
      (args: { sessionId: number; data: string | number[] }) => Promise<void>
    >();
    this.sender = new OrderedLspSender((data) =>
      this.inputStringProxy({ sessionId: LSP_SESSION_ID, data })
    );
  }

  write(msg: Message): Promise<void> {
    return this.sender.write(msg);
  }

  end(): void {}
}

export function createLspConnection(ctx: Ctx) {
  const reader = new MyMessageReader(ctx);
  const writer = new MyMessageWriter(ctx);
  return {
    reader,
    writer,
    dispose() {
      reader.dispose();
      writer.dispose();
    },
  };
}
