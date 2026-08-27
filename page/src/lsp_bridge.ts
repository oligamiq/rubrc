import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
} from "vscode-jsonrpc/browser.js";
import type { Ctx } from "./ctx";
import {
  LSP_SESSION_ID,
  LspFrameDecoder,
  OrderedLspSender,
  observeAndDeliverLspMessage,
} from "./lsp_protocol";
import type { RuntimeSharedObjectFactories } from "./runtime_command_service.ts";

import { closeUnderlyingChannel } from "./shared_object_channel.ts";

const defaultFactories: RuntimeSharedObjectFactories = {
  createSharedObject: (value, id) => new SharedObject(value, id),
  createSharedObjectRef: (id) => new SharedObjectRef(id),
};

class MyMessageReader extends AbstractMessageReader {
  private readonly decoder = new LspFrameDecoder();
  private shared: SharedObject | undefined;
  private closed = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly observeMessage?: (message: unknown) => void,
    private readonly factories: RuntimeSharedObjectFactories = defaultFactories,
    private readonly rollbackConnection?: () => void,
  ) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    if (this.closed) throw new Error("LSP reader is disposed");
    if (this.shared) throw new Error("LSP reader already listening");
    try {
      this.shared = this.factories.createSharedObject(
        ({ data }: { data: unknown }) => {
          if (this.closed) return;
          try {
            for (const message of this.decoder.push(data)) {
              observeAndDeliverLspMessage(
                message,
                this.observeMessage,
                (decoded) => callback(decoded as Message),
                (error) => this.fireError(error),
              );
            }
          } catch (error) {
            this.closed = true;
            try {
              this.fireError(error);
            } finally {
              try {
                this.fireClose();
              } finally {
                closeUnderlyingChannel(this.shared);
                this.shared = undefined;
              }
            }
          }
        },
        this.ctx.ls_id,
      ) as SharedObject;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      this.closed = true;
      try {
        this.rollbackConnection?.();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        super.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "LSP reader construction cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
    return { dispose: () => this.dispose() };
  }

  override dispose(): void {
    try {
      if (!this.closed) {
        this.closed = true;
        try {
          this.fireClose();
        } finally {
          closeUnderlyingChannel(this.shared);
          this.shared = undefined;
        }
      }
    } finally {
      super.dispose();
    }
  }
}

class MyMessageWriter extends AbstractMessageWriter {
  private readonly inputStringProxy: (args: {
    sessionId: number;
    data: string | number[];
  }) => Promise<void>;
  private readonly sender: OrderedLspSender;
  private readonly sharedRef: SharedObjectRef;
  private closed = false;

  constructor(
    ctx: Ctx,
    factories: RuntimeSharedObjectFactories = defaultFactories,
  ) {
    super();
    let sharedRef: SharedObjectRef | undefined;
    try {
      sharedRef = factories.createSharedObjectRef(
        ctx.input_string_id,
      ) as SharedObjectRef;
      this.sharedRef = sharedRef;
      this.inputStringProxy =
        sharedRef.proxy<
          (args: {
            sessionId: number;
            data: string | number[];
          }) => Promise<void>
        >();
      this.sender = new OrderedLspSender((data) =>
        this.inputStringProxy({ sessionId: LSP_SESSION_ID, data }),
      );
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        closeUnderlyingChannel(sharedRef);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        super.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "LSP writer construction cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  write(msg: Message): Promise<void> {
    if (this.closed) return Promise.reject(new Error("LSP writer is disposed"));
    return this.sender.write(msg);
  }

  end(): void {}

  override dispose(): void {
    const errors: unknown[] = [];
    if (!this.closed) {
      this.closed = true;
      try {
        closeUnderlyingChannel(this.sharedRef);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      super.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "LSP writer cleanup failed");
    }
  }
}

export function createLspConnection(
  ctx: Ctx,
  observeMessage?: (message: unknown) => void,
  factories: RuntimeSharedObjectFactories = defaultFactories,
) {
  const writer = new MyMessageWriter(ctx, factories);
  const reader = new MyMessageReader(ctx, observeMessage, factories, () =>
    writer.dispose(),
  );
  return {
    reader,
    writer,
    dispose() {
      const errors: unknown[] = [];
      try {
        reader.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        writer.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "LSP connection cleanup failed");
      }
    },
  };
}
