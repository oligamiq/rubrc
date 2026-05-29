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

    constructor(ctx: Ctx) {
        super();
        this.ctx = ctx;
    }

    listen(callback: DataCallback): void {
        new SharedObject(({ data }: { data: Uint8Array }) => {
            const messageStr = new TextDecoder().decode(data);
            try {
                const message = JSON.parse(messageStr);
                callback(message);
            } catch (e) {
                console.error("Failed to parse LSP message", e, messageStr);
            }
        }, this.ctx.ls_id);
    }
}

class MyMessageWriter extends AbstractMessageWriter {
    private inputStringProxy: any;

    constructor(ctx: Ctx) {
        super();
        this.inputStringProxy = new SharedObjectRef(ctx.input_string_id).proxy<
            (args: { sessionId: number, data: string }) => Promise<void>
        >();
    }

    async write(msg: Message): Promise<void> {
        const data = JSON.stringify(msg);
        await this.inputStringProxy({ sessionId: LSP_SESSION_ID, data });
    }

    end(): void {}
}

export function createLspConnection(ctx: Ctx): MessageConnection {
    const reader = new MyMessageReader(ctx);
    const writer = new MyMessageWriter(ctx);
    return createMessageConnection(reader, writer);
}
