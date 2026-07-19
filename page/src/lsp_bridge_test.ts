if (!globalThis.Deno) {
  (globalThis as any).Deno = {
    test: (args: any) => {
      console.log(`Running: ${args.name || args}`);
      const fn = typeof args === "function" ? args : args.fn;
      try { 
        const result = fn(); 
        if (result instanceof Promise) {
           console.error("Async tests not supported by this simple polyfill");
           process.exit(1);
        }
        console.log(`PASS: ${args.name || 'test'}`); 
      }
      catch (e) { console.error(`FAIL: ${args.name || 'test'}`, e); process.exit(1); }
    }
  };
}

import { createLspConnection } from "./lsp_bridge.ts";
import type { Ctx } from "./ctx.ts";
import { encodeLspMessage } from "./lsp_protocol.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const originalBroadcastChannel = globalThis.BroadcastChannel;

class FakeBroadcastChannel {
  name: string;
  closed = false;
  onmessage: ((ev: any) => any) | null = null;
  listeners: ((ev: any) => any)[] = [];
  static created: FakeBroadcastChannel[] = [];

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.created.push(this);
  }

  postMessage() {}

  addEventListener(type: string, listener: any) {
    if (type === 'message') this.listeners.push(listener);
  }

  removeEventListener(type: string, listener: any) {
    if (type === 'message') {
      this.listeners = this.listeners.filter(l => l !== listener);
    }
  }

  triggerMessage(data: any) {
    if (this.onmessage) this.onmessage({ data });
    for (const listener of this.listeners) listener({ data });
  }

  close() {
    this.closed = true;
  }
}

Deno.test({
  name: "lsp_bridge: connection.dispose closes reader and writer channels",
  fn: () => {
    FakeBroadcastChannel.created = [];
    globalThis.BroadcastChannel = FakeBroadcastChannel as any;
    try {
      const ctx = { ls_id: "ls-1", input_string_id: "in-1" } as Ctx;
      const connection = createLspConnection(ctx);
      connection.reader.listen(() => {});

      assert(FakeBroadcastChannel.created.length === 2, "Expected exactly 2 channels created (one for reader, one for writer proxy)");
      assert(!FakeBroadcastChannel.created[0].closed, "Channel 0 should be open");
      assert(!FakeBroadcastChannel.created[1].closed, "Channel 1 should be open");

      connection.dispose();

      assert(FakeBroadcastChannel.created[0].closed, "Channel 0 should be closed after connection.dispose()");
      assert(FakeBroadcastChannel.created[1].closed, "Channel 1 should be closed after connection.dispose()");
    } finally {
      globalThis.BroadcastChannel = originalBroadcastChannel;
    }
  },
});

Deno.test({
  name: "lsp_bridge: listen after dispose throws without opening a channel",
  fn: () => {
    FakeBroadcastChannel.created = [];
    globalThis.BroadcastChannel = FakeBroadcastChannel as any;
    try {
      const ctx = { ls_id: "ls-2", input_string_id: "in-2" } as Ctx;
      const connection = createLspConnection(ctx);
      
      const channelsBeforeDispose = FakeBroadcastChannel.created.length;
      connection.reader.dispose();

      let threw = false;
      try {
        connection.reader.listen(() => {});
      } catch (e: any) {
        threw = true;
      }
      assert(threw, "Expected listen to throw after dispose");
      assert(FakeBroadcastChannel.created.length === channelsBeforeDispose, "No new channel should be opened when listen throws");
    } finally {
      globalThis.BroadcastChannel = originalBroadcastChannel;
    }
  },
});

Deno.test({
  name: "lsp_bridge: malformed input fires error and close exactly once and ignores later data",
  fn: () => {
    FakeBroadcastChannel.created = [];
    globalThis.BroadcastChannel = FakeBroadcastChannel as any;
    try {
      const ctx = { ls_id: "ls-3", input_string_id: "in-3" } as Ctx;
      const connection = createLspConnection(ctx);
      
      let errorCount = 0;
      let closeCount = 0;
      let dataCount = 0;

      connection.reader.onError(() => errorCount++);
      connection.reader.onClose(() => closeCount++);
      
      connection.reader.listen(() => dataCount++);

      const readerChannel = FakeBroadcastChannel.created.find(c => c.name.includes("ls-3"));
      assert(!!readerChannel, "Expected reader channel to be found");

      // Send malformed data
      readerChannel!.triggerMessage({
        msg: "func_call::call",
        to: "parent",
        names: [".self"],
        args: [{ data: new TextEncoder().encode("Content-Length: bad\r\n\r\n{}") }]
      });

      assert(errorCount === 1, "Expected exactly 1 error event for malformed input");
      assert(closeCount === 1, "Expected exactly 1 close event for malformed input");
      assert(readerChannel!.closed, "Reader channel should be closed upon fatal error");

      // Attempt to send more valid data (ignored because channel is supposedly closed, and bridge is closed)
      const validFrame = encodeLspMessage({ jsonrpc: "2.0", id: 1 });
      readerChannel!.triggerMessage({
        msg: "func_call::call",
        to: "parent",
        names: [".self"],
        args: [{ data: validFrame }]
      });

      assert(dataCount === 0, "Expected subsequent data to be ignored after malformed input");
      assert(errorCount === 1, "Error count should remain 1");
      assert(closeCount === 1, "Close count should remain 1");
    } finally {
      globalThis.BroadcastChannel = originalBroadcastChannel;
    }
  },
});
