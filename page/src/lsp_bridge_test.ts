import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createLspConnection } from "./lsp_bridge.ts";
import type { Ctx } from "./ctx.ts";
import { encodeLspMessage } from "./lsp_protocol.ts";
import type { RuntimeSharedObjectFactories } from "./runtime_command_service.ts";

const originalBroadcastChannel = globalThis.BroadcastChannel;

test("LSP connection acquires both channels through runtime factories", () => {
  const created: string[] = [];
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject: (_value, id) => {
      created.push(`object:${id}`);
      return { bc: { close() {} } };
    },
    createSharedObjectRef: (id) => {
      created.push(`ref:${id}`);
      return {
        proxy: <T>() => (() => Promise.resolve()) as T,
        bc: { close() {} },
      };
    },
  };
  const ctx = { ls_id: "owned-ls", input_string_id: "owned-input" } as Ctx;
  const connection = createLspConnection(ctx, undefined, factories);

  connection.reader.listen(() => {});

  expect(created).toEqual(["ref:owned-input", "object:owned-ls"]);
  connection.dispose();
});

test("LSP writer proxy failure closes its acquired ref", () => {
  let closes = 0;
  const proxyError = new Error("writer proxy failed");
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject: () => ({ bc: { close() {} } }),
    createSharedObjectRef: () => ({
      proxy: <T>() => {
        throw proxyError;
      },
      bc: { close: () => closes++ },
    }),
  };

  expect(() =>
    createLspConnection(
      { ls_id: "rollback-reader", input_string_id: "rollback-writer" } as Ctx,
      undefined,
      factories,
    ),
  ).toThrow(proxyError);
  expect(closes).toBe(1);
});

test("LSP reader construction failure closes the previously acquired writer", () => {
  let writerCloses = 0;
  const readerError = new Error("reader construction failed");
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject: () => {
      throw readerError;
    },
    createSharedObjectRef: () => ({
      proxy: <T>() => (() => Promise.resolve()) as T,
      bc: { close: () => writerCloses++ },
    }),
  };
  const connection = createLspConnection(
    { ls_id: "failed-reader", input_string_id: "owned-writer" } as Ctx,
    undefined,
    factories,
  );

  expect(() => connection.reader.listen(() => {})).toThrow(readerError);
  expect(writerCloses).toBe(1);
});

test("LSP connection disposal attempts reader and writer and aggregates failures", () => {
  const readerError = new Error("reader close failed");
  const writerError = new Error("writer close failed");
  const attempts: string[] = [];
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject: () => ({
      bc: {
        close() {
          attempts.push("reader");
          throw readerError;
        },
      },
    }),
    createSharedObjectRef: () => ({
      proxy: <T>() => (() => Promise.resolve()) as T,
      bc: {
        close() {
          attempts.push("writer");
          throw writerError;
        },
      },
    }),
  };
  const connection = createLspConnection(
    { ls_id: "throwing-reader", input_string_id: "throwing-writer" } as Ctx,
    undefined,
    factories,
  );
  connection.reader.listen(() => {});
  let caught: unknown;

  try {
    connection.dispose();
  } catch (error) {
    caught = error;
  }

  expect(attempts).toEqual(["reader", "writer"]);
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([readerError, writerError]);
});

test("LSP writer invokes base dispose when channel close throws", () => {
  const writerError = new Error("writer close failed");
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject: () => ({ bc: { close() {} } }),
    createSharedObjectRef: () => ({
      proxy: <T>() => (() => Promise.resolve()) as T,
      bc: {
        close: () => {
          throw writerError;
        },
      },
    }),
  };
  const connection = createLspConnection(
    { ls_id: "base-reader", input_string_id: "base-writer" } as Ctx,
    undefined,
    factories,
  );
  const basePrototype = Object.getPrototypeOf(
    Object.getPrototypeOf(connection.writer),
  ) as { dispose(): void };
  const baseDispose = spyOn(basePrototype, "dispose");

  try {
    expect(() => connection.writer.dispose()).toThrow(writerError);
    expect(baseDispose).toHaveBeenCalledTimes(1);
  } finally {
    baseDispose.mockRestore();
  }
});

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

test("lsp_bridge: observer sees each decoded message before the client", () => {
  const ctx = { ls_id: "ls-observe", input_string_id: "in-observe" } as Ctx;
  const deliveries: Array<{ owner: string; message: unknown }> = [];
  const connection = createLspConnection(ctx, (message) => {
    deliveries.push({ owner: "observer", message });
  });
  connection.reader.listen((message) => {
    deliveries.push({ owner: "client", message });
  });
  const readerChannel = FakeBroadcastChannel.created.find((channel) =>
    channel.name.includes("ls-observe"),
  );
  const frame = encodeLspMessage({ jsonrpc: "2.0", method: "ready" });

  readerChannel!.triggerMessage({
    msg: "func_call::call",
    to: "parent",
    names: [".self"],
    args: [{ data: frame }],
  });

  expect(deliveries.map(({ owner }) => owner)).toEqual(["observer", "client"]);
  expect(deliveries[0].message).toEqual(deliveries[1].message);
  expect(deliveries[0].message).not.toBe(deliveries[1].message);
});

test("lsp_bridge: observer errors are reported without closing or consuming the stream", () => {
  const ctx = {
    ls_id: "ls-observer-error",
    input_string_id: "in-observer-error",
  } as Ctx;
  const expected = new Error("observer failed");
  let observedErrors = 0;
  let closes = 0;
  const delivered: number[] = [];
  const connection = createLspConnection(ctx, () => {
    throw expected;
  });
  connection.reader.onError((error) => {
    expect(error).toBe(expected);
    observedErrors++;
  });
  connection.reader.onClose(() => closes++);
  connection.reader.listen((message) => {
    delivered.push((message as unknown as { id: number }).id);
  });
  const readerChannel = FakeBroadcastChannel.created.find((channel) =>
    channel.name.includes("ls-observer-error"),
  );
  const first = encodeLspMessage({ jsonrpc: "2.0", id: 1, result: null });
  const second = encodeLspMessage({ jsonrpc: "2.0", id: 2, result: null });
  const frames = new Uint8Array(first.length + second.length);
  frames.set(first);
  frames.set(second, first.length);

  readerChannel!.triggerMessage({
    msg: "func_call::call",
    to: "parent",
    names: [".self"],
    args: [{ data: frames }],
  });

  expect(observedErrors).toBe(2);
  expect(delivered).toEqual([1, 2]);
  expect(closes).toBe(0);
  expect(readerChannel!.closed).toBe(false);
});
