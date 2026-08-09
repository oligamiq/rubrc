import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createLspConnection } from "./lsp_bridge.ts";
import type { Ctx } from "./ctx.ts";
import { encodeLspMessage } from "./lsp_protocol.ts";

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
    if (type === "message") this.listeners.push(listener);
  }

  removeEventListener(type: string, listener: any) {
    if (type === "message") {
      this.listeners = this.listeners.filter((l) => l !== listener);
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

beforeEach(() => {
  FakeBroadcastChannel.created = [];
  globalThis.BroadcastChannel = FakeBroadcastChannel as any;
});

afterEach(() => {
  globalThis.BroadcastChannel = originalBroadcastChannel;
});

test("lsp_bridge: connection.dispose closes reader and writer channels", () => {
  const ctx = { ls_id: "ls-1", input_string_id: "in-1" } as Ctx;
  const connection = createLspConnection(ctx);
  connection.reader.listen(() => {});

  expect(FakeBroadcastChannel.created.length).toBe(2);
  expect(FakeBroadcastChannel.created[0].closed).toBe(false);
  expect(FakeBroadcastChannel.created[1].closed).toBe(false);

  connection.dispose();

  expect(FakeBroadcastChannel.created[0].closed).toBe(true);
  expect(FakeBroadcastChannel.created[1].closed).toBe(true);
});

test("lsp_bridge: listen after dispose throws without opening a channel", () => {
  const ctx = { ls_id: "ls-2", input_string_id: "in-2" } as Ctx;
  const connection = createLspConnection(ctx);

  const channelsBeforeDispose = FakeBroadcastChannel.created.length;
  connection.reader.dispose();

  expect(() => connection.reader.listen(() => {})).toThrow();
  expect(FakeBroadcastChannel.created.length).toBe(channelsBeforeDispose);
});

test("lsp_bridge: reader disposal emits close exactly once", () => {
  const ctx = { ls_id: "ls-close", input_string_id: "in-close" } as Ctx;
  const connection = createLspConnection(ctx);
  let closes = 0;
  connection.reader.onClose(() => closes++);
  connection.reader.listen(() => {});

  connection.reader.dispose();
  connection.reader.dispose();

  expect(closes).toBe(1);
});

test("lsp_bridge: reader disposal closes its channel when a close listener throws", () => {
  const ctx = {
    ls_id: "ls-throwing-close",
    input_string_id: "in-throwing-close",
  } as Ctx;
  const connection = createLspConnection(ctx);
  const listenerError = new Error("close listener failed");
  let closes = 0;
  connection.reader.onClose(() => {
    closes++;
    throw listenerError;
  });
  connection.reader.listen(() => {});
  const readerChannel = FakeBroadcastChannel.created.find((channel) =>
    channel.name.includes("ls-throwing-close"),
  );
  const consoleError = spyOn(console, "error").mockImplementation((...args) => {
    const error = args.find((value) => value instanceof Error);
    throw error ?? new Error(String(args[0]));
  });

  try {
    expect(() => connection.reader.dispose()).toThrow(listenerError);
    expect(readerChannel?.closed).toBe(true);
  } finally {
    consoleError.mockRestore();
  }
  expect(() => connection.reader.dispose()).not.toThrow();
  expect(closes).toBe(1);
});

test("lsp_bridge: malformed input closes after a throwing error listener", () => {
  const ctx = {
    ls_id: "ls-throwing-error",
    input_string_id: "in-throwing-error",
  } as Ctx;
  const connection = createLspConnection(ctx);
  const listenerError = new Error("error listener failed");
  let closes = 0;
  connection.reader.onError(() => {
    throw listenerError;
  });
  connection.reader.onClose(() => closes++);
  connection.reader.listen(() => {});
  const readerChannel = FakeBroadcastChannel.created.find((channel) =>
    channel.name.includes("ls-throwing-error"),
  );
  expect(readerChannel).toBeDefined();
  const consoleError = spyOn(console, "error").mockImplementation((...args) => {
    const error = args.find((value) => value instanceof Error);
    throw error ?? new Error(String(args[0]));
  });

  try {
    readerChannel!.triggerMessage({
      msg: "func_call::call",
      to: "parent",
      names: [".self"],
      args: [
        { data: new TextEncoder().encode("Content-Length: bad\r\n\r\n{}") },
      ],
    });
    expect(readerChannel!.closed).toBe(true);
    expect(closes).toBe(1);
  } finally {
    consoleError.mockRestore();
  }
  connection.reader.dispose();
  expect(closes).toBe(1);
});

test("lsp_bridge: malformed input fires error and close exactly once and ignores later data", () => {
  const ctx = { ls_id: "ls-3", input_string_id: "in-3" } as Ctx;
  const connection = createLspConnection(ctx);

  let errorCount = 0;
  let closeCount = 0;
  let dataCount = 0;

  connection.reader.onError(() => errorCount++);
  connection.reader.onClose(() => closeCount++);

  connection.reader.listen(() => dataCount++);

  const readerChannel = FakeBroadcastChannel.created.find((c) =>
    c.name.includes("ls-3"),
  );
  expect(readerChannel).toBeDefined();

  // Send malformed data
  readerChannel!.triggerMessage({
    msg: "func_call::call",
    to: "parent",
    names: [".self"],
    args: [{ data: new TextEncoder().encode("Content-Length: bad\r\n\r\n{}") }],
  });

  expect(errorCount).toBe(1);
  expect(closeCount).toBe(1);
  expect(readerChannel!.closed).toBe(true);

  // Attempt to send more valid data (ignored because channel is supposedly closed, and bridge is closed)
  const validFrame = encodeLspMessage({ jsonrpc: "2.0", id: 1 });
  readerChannel!.triggerMessage({
    msg: "func_call::call",
    to: "parent",
    names: [".self"],
    args: [{ data: validFrame }],
  });

  expect(dataCount).toBe(0);
  expect(errorCount).toBe(1);
  expect(closeCount).toBe(1);
});
