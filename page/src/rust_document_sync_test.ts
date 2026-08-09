import { RustDocumentSync, type TimerScheduler } from "./rust_document_sync.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

class FakeScheduler implements TimerScheduler {
  private nextId = 1;
  private callbacks = new Map<number, () => void>();

  set(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

const document = (
  uri: string,
  text: string,
  version: number,
  languageId = "rust",
) => {
  const parsed = new URL(uri);
  return {
    uri: {
      scheme: parsed.protocol.slice(0, -1),
      authority: parsed.host,
      path: decodeURIComponent(parsed.pathname),
      toString: () => uri,
    },
    languageId,
    version,
    getText: () => text,
  } as never;
};

Deno.test("didOpen completion follows the VFS write and LSP continuation", async () => {
  const order: string[] = [];
  let continueDidOpen!: () => void;
  const didOpenContinuation = new Promise<void>((resolve) => {
    continueDidOpen = resolve;
  });
  const sync = new RustDocumentSync(
    async () => {
      order.push("write");
    },
    {
      onDidOpenComplete: (uri: string) => order.push(`complete:${uri}`),
    } as never,
  );

  const opened = document("file:///src/main.rs", "fn main() {}", 1);
  let completionSettled = false;
  const completion = sync.waitForDidOpen("file:///src/main.rs").then(() => {
    completionSettled = true;
    order.push("waiter");
  });
  const didOpen = sync.middleware.didOpen!(opened, async () => {
    order.push("didOpen");
    await didOpenContinuation;
  });

  await Promise.resolve();
  assert(!completionSettled, "didOpen completion resolved before continuation");
  continueDidOpen();
  await didOpen;
  await completion;

  assert(
    order.join(",") === "write,didOpen,complete:file:///src/main.rs,waiter",
    `wrong didOpen completion order: ${order}`,
  );
});

Deno.test("didOpen completion rejects with the original continuation error", async () => {
  const sync = new RustDocumentSync(async () => {});
  const opened = document("file:///src/main.rs", "fn main() {}", 1);
  const original = new Error("didOpen failed");
  const completion = sync.waitForDidOpen("file:///src/main.rs");
  let middlewareError: unknown;
  let completionError: unknown;

  try {
    await sync.middleware.didOpen!(opened, async () => {
      throw original;
    });
  } catch (error) {
    middlewareError = error;
  }
  try {
    await completion;
  } catch (error) {
    completionError = error;
  }

  assert(
    middlewareError === original,
    "middleware replaced the original error",
  );
  assert(
    completionError === original,
    "completion replaced the original error",
  );
});

Deno.test("didChange forwards immediately and debounces only VFS", async () => {
  const writes: Array<[string, string]> = [];
  const scheduler = new FakeScheduler();
  const sync = new RustDocumentSync(
    async (path, text) => {
      writes.push([path, text]);
    },
    { scheduler },
  );
  const calls: string[] = [];
  const first = document("file:///src/main.rs", "fn main(){ let x = ; }", 2);
  await sync.middleware.didChange!(
    { document: first, contentChanges: [] } as never,
    async () => {
      calls.push("next");
    },
  );
  assert(calls.join() === "next", "didChange was delayed");
  assert(writes.length === 0, "VFS was not debounced");
  const second = document("file:///src/main.rs", "fn main() {}", 3);
  await sync.middleware.didChange!(
    { document: second, contentChanges: [] } as never,
    async () => {},
  );
  scheduler.runAll();
  await sync.dispose();
  assert(
    writes.length === 1 && writes[0][1] === "fn main() {}",
    "latest text not coalesced",
  );
});

Deno.test("different Rust file URIs retain independent snapshots", async () => {
  const writes: string[] = [];
  const scheduler = new FakeScheduler();
  const sync = new RustDocumentSync(
    async (path) => {
      writes.push(path);
    },
    { scheduler },
  );
  const next = async () => {};
  await sync.middleware.didChange!(
    {
      document: document("file:///src/main.rs", "fn main() {}", 2),
      contentChanges: [],
    } as never,
    next,
  );
  await sync.middleware.didChange!(
    {
      document: document("file:///src/secondary.rs", "pub fn value() {}", 1),
      contentChanges: [],
    } as never,
    next,
  );
  scheduler.runAll();
  await sync.dispose();
  assert(
    writes.sort().join(",") === "/src/main.rs,/src/secondary.rs",
    `wrong paths: ${writes}`,
  );
});

Deno.test("didClose flushes VFS before standard close", async () => {
  const order: string[] = [];
  const scheduler = new FakeScheduler();
  const sync = new RustDocumentSync(
    async () => {
      order.push("write");
    },
    { scheduler },
  );
  const changed = document("file:///src/main.rs", "fn main() {}", 2);
  await sync.middleware.didChange!(
    { document: changed, contentChanges: [] } as never,
    async () => {},
  );
  await sync.middleware.didClose!(changed, async () => {
    order.push("close");
  });
  assert(order.join(",") === "write,close", `wrong close order: ${order}`);
});

Deno.test("non-Rust and non-file models bypass VFS mirroring", async () => {
  let writes = 0;
  const sync = new RustDocumentSync(async () => {
    writes++;
  });
  const next = async () => {};
  await sync.middleware.didOpen!(
    document("untitled:Untitled-1", "fn main() {}", 1),
    next,
  );
  await sync.middleware.didOpen!(
    document("file:///src/main.ts", "const x = 1", 1, "typescript"),
    next,
  );
  assert(writes === 0, `unexpected writes: ${writes}`);
});

Deno.test("writer failure is logged and does not suppress LSP continuation", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const scheduler = new FakeScheduler();
  const sync = new RustDocumentSync(
    async () => {
      throw new Error("write failed");
    },
    { scheduler, logger: (message) => logs.push(message) },
  );
  const opened = document("file:///src/main.rs", "fn main() {}", 1);
  await sync.middleware.didOpen!(opened, async () => {
    calls.push("open");
  });
  await sync.middleware.didChange!(
    { document: opened, contentChanges: [] } as never,
    async () => {
      calls.push("change");
    },
  );
  await sync.middleware.didClose!(opened, async () => {
    calls.push("close");
  });
  assert(
    calls.join(",") === "open,change,close",
    `suppressed continuation: ${calls}`,
  );
  assert(
    logs.every((message) => message.includes("/src/main.rs")) &&
      logs.length >= 2,
    "missing path logs",
  );
});
