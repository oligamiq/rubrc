# Rust-Analyzer Live Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display embedded rust-analyzer diagnostics as live Monaco squiggles for every open Rust file and clear them when code becomes valid.

**Architecture:** Keep `MonacoLanguageClient` as the owner of LSP text synchronization and Monaco markers. Repair the framed SharedObject transport, start the client only after Monaco and the VFS are ready, and use middleware to mirror complete model text to the Rust-side VFS without delaying incremental `didChange` notifications.

**Tech Stack:** TypeScript, SolidJS, Monaco Editor, `monaco-languageclient` 10.7, `vscode-jsonrpc`, Deno tests, embedded rust-analyzer Wasm, Puppeteer.

## Global Constraints

- Change rubrc only; do not modify rust-analyzer, Cargo, rustc, `wasi_virt_layer`, or browser shim artifacts.
- Use the existing embedded `lsp_opt.wasm` rust-analyzer and `MonacoLanguageClient` marker integration.
- Match only open documents with `{ scheme: "file", language: "rust" }`.
- Retain error, warning, information, and hint severities without custom filtering.
- Keep rust-analyzer Cargo `checkOnSave` and proc macros disabled.
- Debounce only VFS snapshots by 300 ms; never delay or replace the client's incremental `didChange` stream.
- Preserve `rust_file` updates for `/src/main.rs` compatibility and use `EVENT_TYPE_WRITE_FILE` for the Rust-side VFS.
- Treat malformed LSP frames as fatal to that connection; do not guess a resynchronization boundary.
- Do not add a Problems panel or diagnostics for unopened files.
- Do not stage or modify the existing untracked `diff.patch`, `diff2.patch`, or `diff3.patch` files.

---

## File Structure

- Create `page/src/lsp_protocol.ts`: side-effect-free session constants, byte validation, UTF-8 framing, and incremental frame decoder.
- Create `page/src/lsp_protocol_test.ts`: protocol and framing unit tests runnable with Deno.
- Modify `page/src/lsp_bridge.ts`: adapt SharedObject reader/writer to the protocol module and own transport cleanup.
- Create `page/src/worker_process/lsp_dispatch.ts`: side-effect-free terminal routing and synchronous special-input dispatch.
- Create `page/src/worker_process/lsp_dispatch_test.ts`: signed session routing, byte-copy, dispatch ordering, and failure tests.
- Modify `page/src/worker_process/util_cmd.ts`: use the dispatch helper so VFS/LSP proxy completion acknowledges synchronous dispatch.
- Create `page/src/rust_document_sync.ts`: 300 ms VFS mirror and text-synchronization middleware.
- Create `page/src/rust_document_sync_test.ts`: deterministic fake-scheduler middleware tests.
- Create `page/src/lsp_start_gate.ts`: two-readiness, exactly-once startup lifecycle.
- Create `page/src/lsp_start_gate_test.ts`: both readiness orders, duplicate events, failure, and disposal tests.
- Create `page/src/rust_lsp_client.ts`: construct and dispose the language client, transport, middleware, and VFS writer.
- Modify `page/src/App.tsx`: replace eager LSP startup and hard-coded editor change handler with the readiness gate.
- Create `scripts/vfs_lsp_diagnostics_test.ts`: parent WASIFarm with a complete Rust workspace and sysroot.
- Create `scripts/vfs_lsp_diagnostics_worker.ts`: real rust-analyzer invalid-to-valid diagnostics driver.
- Create `page/src/lsp_test_api.ts`: build-time-gated browser test access to Monaco readiness and successful VFS writes.
- Create `scripts/lsp_browser_diagnostics_test.mjs`: Puppeteer marker acceptance test.
- Modify `package.json`: declare Puppeteer 25.3.0 and the browser test command.
- Regenerate `package-lock.json` and `bun.lockb` with their package managers; never edit either lockfile manually.

---

### Task 1: LSP Protocol Codec And Frame Decoder

**Files:**
- Create: `page/src/lsp_protocol.ts`
- Create: `page/src/lsp_protocol_test.ts`

**Interfaces:**
- Produces: `LSP_SESSION_ID`, `VFS_SYNC_SESSION_ID`, `isLspSession(sessionId)`, `toLspBytes(value)`, `encodeLspMessage(message)`, and `LspFrameDecoder.push(chunk)`.
- Consumes: no browser, Monaco, worker, or SharedObject state.

- [ ] **Step 1: Write the failing protocol tests**

Create `page/src/lsp_protocol_test.ts` with local assertion helpers and these cases:

```ts
import {
  LSP_SESSION_ID,
  LspFrameDecoder,
  encodeLspMessage,
  isLspSession,
  toLspBytes,
} from "./lsp_protocol.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("LSP session accepts signed and unsigned Wasm representations", () => {
  assert(isLspSession(-1), "signed -1 must route to LSP");
  assert(isLspSession(LSP_SESSION_ID), "u32::MAX must route to LSP");
  assert(!isLspSession(0), "terminal session 0 must not route to LSP");
});

Deno.test("LSP bytes accept typed and numeric arrays only", () => {
  const source = new Uint8Array([1, 2, 255]);
  const typed = toLspBytes(source);
  const numeric = toLspBytes([1, 2, 255]);
  assert(typed !== source, "typed input must be copied");
  assert(typed.join(",") === "1,2,255", "typed bytes changed");
  assert(numeric.join(",") === "1,2,255", "numeric bytes changed");
  for (const invalid of [{ 0: 1 }, [256], [-1], [1.5], [Number.NaN]]) {
    let threw = false;
    try {
      toLspBytes(invalid);
    } catch {
      threw = true;
    }
    assert(threw, `expected rejection for ${JSON.stringify(invalid)}`);
  }
});

Deno.test("LSP framing uses UTF-8 byte length", () => {
  const frame = encodeLspMessage({ jsonrpc: "2.0", id: 1, result: "日本語" });
  const text = new TextDecoder().decode(frame);
  const [header, body] = text.split("\r\n\r\n");
  const declared = Number(header.match(/Content-Length: (\d+)/)?.[1]);
  assert(declared === new TextEncoder().encode(body).length, "wrong byte length");
});

Deno.test("LSP decoder handles split and coalesced frames exactly once", () => {
  const first = encodeLspMessage({ jsonrpc: "2.0", id: 1, result: {} });
  const second = encodeLspMessage({ jsonrpc: "2.0", method: "ready" });
  const decoder = new LspFrameDecoder();
  assert(decoder.push(first.slice(0, 7)).length === 0, "partial header parsed");
  const joined = new Uint8Array(first.length - 7 + second.length);
  joined.set(first.slice(7));
  joined.set(second, first.length - 7);
  const messages = decoder.push(joined) as Array<{ id?: number; method?: string }>;
  assert(messages.length === 2, `expected 2 messages, got ${messages.length}`);
  assert(messages[0].id === 1 && messages[1].method === "ready", "wrong order");
  assert(decoder.push([]).length === 0, "messages emitted twice");
});

Deno.test("LSP decoder rejects malformed streams", () => {
  for (const bytes of [
    new TextEncoder().encode("Other: 1\r\n\r\n{}"),
    new TextEncoder().encode("Content-Length: 2\r\n\r\n{x"),
  ]) {
    let threw = false;
    try {
      new LspFrameDecoder().push(bytes);
    } catch {
      threw = true;
    }
    assert(threw, "malformed frame must throw");
  }
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `deno test --allow-read page/src/lsp_protocol_test.ts`

Expected: FAIL with `Module not found ".../page/src/lsp_protocol.ts"`.

- [ ] **Step 3: Implement the protocol module**

Create `page/src/lsp_protocol.ts` with these public contracts and private helpers:

```ts
export const LSP_SESSION_ID = 0xffff_ffff;
export const VFS_SYNC_SESSION_ID = 0xeeee_eeee;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

export const isLspSession = (sessionId: number): boolean =>
  (sessionId >>> 0) === LSP_SESSION_ID;

export function toLspBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (!Array.isArray(value)) throw new Error("LSP payload must be a byte array");
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
      const matches = [...header.matchAll(/^Content-Length:[ \t]*(\d+)\r?$/gim)];
      if (matches.length !== 1) throw new Error("invalid LSP Content-Length header");
      const length = Number(matches[0][1]);
      if (!Number.isSafeInteger(length)) throw new Error("invalid LSP body length");
      const bodyStart = headerEnd + HEADER_END.length;
      if (this.buffer.length < bodyStart + length) return messages;
      const body = decoder.decode(this.buffer.slice(bodyStart, bodyStart + length));
      const message = JSON.parse(body);
      if (typeof message !== "object" || message === null) {
        throw new Error("LSP body must be a JSON object");
      }
      messages.push(message);
      this.buffer = this.buffer.slice(bodyStart + length);
    }
  }

  private findHeaderEnd(): number {
    outer: for (let index = 0; index <= this.buffer.length - HEADER_END.length; index++) {
      for (let offset = 0; offset < HEADER_END.length; offset++) {
        if (this.buffer[index + offset] !== HEADER_END[offset]) continue outer;
      }
      return index;
    }
    return -1;
  }
}
```

- [ ] **Step 4: Run tests and formatter**

Run: `deno test --allow-read page/src/lsp_protocol_test.ts && deno fmt --check page/src/lsp_protocol.ts page/src/lsp_protocol_test.ts`

Expected: 5 tests PASS and formatting check PASS.

- [ ] **Step 5: Commit**

```bash
git add page/src/lsp_protocol.ts page/src/lsp_protocol_test.ts
git commit -m "test(lsp): define framed protocol codec"
```

---

### Task 2: SharedObject Reader And Writer

**Files:**
- Modify: `page/src/lsp_bridge.ts:1-109`
- Test: `page/src/lsp_protocol_test.ts`

**Interfaces:**
- Consumes: Task 1 `LspFrameDecoder`, `encodeLspMessage`, and `LSP_SESSION_ID`.
- Produces: `createLspConnection(ctx): { reader, writer, dispose(): void }` with ordered writes and disposable BroadcastChannel ownership.

- [ ] **Step 1: Add a failing ordered-sender test**

First add `OrderedLspSender` to the import list in `page/src/lsp_protocol_test.ts`, then append this test. It verifies that a second concurrent write does not overtake the first and that a rejected write does not poison later writes:

```ts
Deno.test("ordered sender serializes writes and recovers after rejection", async () => {
  const sent: number[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => releaseFirst = resolve);
  const sender = new OrderedLspSender(async (bytes) => {
    const message = new LspFrameDecoder().push(bytes)[0] as { id: number };
    sent.push(message.id);
    if (message.id === 1) await firstBlocked;
    if (message.id === 3) throw new Error("expected rejection");
  });

  const first = sender.write({ jsonrpc: "2.0", id: 1, result: null });
  const second = sender.write({ jsonrpc: "2.0", id: 2, result: null });
  await Promise.resolve();
  assert(sent.join(",") === "1", `second write overtook first: ${sent}`);
  releaseFirst();
  await Promise.all([first, second]);
  await sender.write({ jsonrpc: "2.0", id: 3, result: null }).catch(() => undefined);
  await sender.write({ jsonrpc: "2.0", id: 4, result: null });
  assert(sent.join(",") === "1,2,3,4", `wrong send order: ${sent}`);
});
```

- [ ] **Step 2: Run the ordered-sender test to verify RED**

Run: `deno test --allow-read page/src/lsp_protocol_test.ts`

Expected: FAIL because `OrderedLspSender` is not exported.

- [ ] **Step 3: Implement the ordered sender and replace the bridge's ad-hoc buffering**

Add this class to `page/src/lsp_protocol.ts`:

```ts
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
```

Update `page/src/lsp_bridge.ts` so `MyMessageReader` owns one decoder and one SharedObject subscription:

```ts
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
        for (const message of this.decoder.push(data)) callback(message as Message);
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
```

Import `Disposable` and `Message` from `vscode-jsonrpc/browser`. A malformed frame therefore emits both reader error and close exactly once and cannot be reused.

Update `MyMessageWriter` to construct one `OrderedLspSender` around the SharedObject proxy and delegate `write`:

```ts
private readonly sender: OrderedLspSender;

constructor(ctx: Ctx) {
  super();
  this.inputStringProxy = new SharedObjectRef(ctx.input_string_id).proxy<
    (args: { sessionId: number; data: number[] }) => Promise<void>
  >();
  this.sender = new OrderedLspSender((data) =>
    this.inputStringProxy({ sessionId: LSP_SESSION_ID, data })
  );
}

write(msg: Message): Promise<void> {
  return this.sender.write(msg);
}
```

Change the proxy input type to `string | number[]`, remove unused `createMessageConnection` and `MessageConnection` imports, and return a connection-level disposer:

```ts
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
```

- [ ] **Step 4: Verify protocol tests and page type/build integration**

Run: `deno test --allow-read page/src/lsp_protocol_test.ts && bun run --cwd page build`

Expected: 6 tests PASS and Vite build succeeds without TypeScript/bundling errors.

- [ ] **Step 5: Commit**

```bash
git add page/src/lsp_bridge.ts page/src/lsp_protocol.ts page/src/lsp_protocol_test.ts
git commit -m "fix(lsp): preserve framed SharedObject messages"
```

---

### Task 3: Worker Session Routing And Dispatch Acknowledgement

**Files:**
- Create: `page/src/worker_process/lsp_dispatch.ts`
- Create: `page/src/worker_process/lsp_dispatch_test.ts`
- Modify: `page/src/worker_process/util_cmd.ts:16,360-377,418-470`

**Interfaces:**
- Consumes: Task 1 session constants, `isLspSession`, and `toLspBytes`.
- Produces: `routeTerminalWrite(...)` and `dispatchSpecialInput(...)` whose return value distinguishes special VFS/LSP input from ordinary terminal text.

- [ ] **Step 1: Write failing worker dispatch tests**

Create `page/src/worker_process/lsp_dispatch_test.ts`. Use a fake root with operation recording and a one-page `WebAssembly.Memory`. Test:

```ts
import {
  dispatchSpecialInput,
  routeTerminalWrite,
} from "./lsp_dispatch.ts";
import { LSP_SESSION_ID, VFS_SYNC_SESSION_ID } from "../lsp_protocol.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("signed LSP output routes away from terminal", () => {
  const calls: string[] = [];
  routeTerminalWrite(-1, [1, 2], () => calls.push("lsp"), () => calls.push("terminal"));
  routeTerminalWrite(7, [3], () => calls.push("lsp"), () => calls.push("terminal"));
  assert(calls.join(",") === "lsp,terminal", `wrong routing: ${calls}`);
});

Deno.test("special input copies, dispatches, and frees synchronously", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const calls: string[] = [];
  const root = {
    allocBuf(length: number) { calls.push(`alloc:${length}`); return 16; },
    dispatch(session: number, event: number, ptr: number, length: number) {
      calls.push(`dispatch:${session}:${event}:${ptr}:${length}`);
      assert(new Uint8Array(memory.buffer, ptr, length)[0] === 65, "bytes not copied");
    },
    freeBuf(ptr: number, length: number) { calls.push(`free:${ptr}:${length}`); },
  };
  assert(dispatchSpecialInput(root, memory, { sessionId: LSP_SESSION_ID, data: [65] }), "not handled");
  assert(calls.join("|") === `alloc:1|dispatch:${LSP_SESSION_ID}:6:16:1|free:16:1`, "wrong order");
});

Deno.test("VFS input uses event 7 and ordinary terminal input is not handled", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let event = -1;
  const root = {
    allocBuf() { return 0; },
    dispatch(_session: number, value: number) { event = value; },
    freeBuf() {},
  };
  assert(dispatchSpecialInput(root, memory, { sessionId: VFS_SYNC_SESSION_ID, data: "{}" }), "VFS not handled");
  assert(event === 7, `expected event 7, got ${event}`);
  assert(!dispatchSpecialInput(root, memory, { sessionId: 3, data: "x" }), "terminal was consumed");
});

Deno.test("dispatch failure still frees and propagates", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let freed = false;
  const root = {
    allocBuf() { return 0; },
    dispatch() { throw new Error("dispatch failed"); },
    freeBuf() { freed = true; },
  };
  let threw = false;
  try {
    dispatchSpecialInput(root, memory, { sessionId: VFS_SYNC_SESSION_ID, data: "{}" });
  } catch {
    threw = true;
  }
  assert(threw && freed, "failure was swallowed or leaked buffer");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `deno test --allow-read page/src/worker_process/lsp_dispatch_test.ts`

Expected: FAIL because `lsp_dispatch.ts` does not exist.

- [ ] **Step 3: Implement the side-effect-free dispatch helper**

Create `page/src/worker_process/lsp_dispatch.ts` with structural root types. `routeTerminalWrite` must normalize only for comparison and preserve the ordinary terminal session value. `dispatchSpecialInput` must accept `string | number[] | Uint8Array`, select event 6 or 7, copy into shared memory, dispatch, and free in `finally`.

```ts
import {
  LSP_SESSION_ID,
  VFS_SYNC_SESSION_ID,
  isLspSession,
  toLspBytes,
} from "../lsp_protocol.ts";

type Root = {
  allocBuf(length: number): number;
  dispatch(sessionId: number, eventType: number, ptr: number, length: number): void;
  freeBuf(ptr: number, length: number): void;
};

export function routeTerminalWrite(
  sessionId: number,
  data: unknown,
  lsp: (data: unknown) => void,
  terminal: (sessionId: number, data: unknown) => void,
): void {
  if (isLspSession(sessionId)) lsp(data);
  else terminal(sessionId, data);
}

export function dispatchSpecialInput(
  root: Root,
  memory: WebAssembly.Memory,
  input: { sessionId: number; data: string | number[] | Uint8Array },
): boolean {
  const sessionId = input.sessionId >>> 0;
  const eventType = isLspSession(sessionId)
    ? 6
    : sessionId === VFS_SYNC_SESSION_ID ? 7 : undefined;
  if (eventType === undefined) return false;
  const bytes = typeof input.data === "string"
    ? new TextEncoder().encode(input.data)
    : toLspBytes(input.data);
  const ptr = root.allocBuf(bytes.length);
  try {
    new Uint8Array(memory.buffer).set(bytes, ptr);
    root.dispatch(sessionId, eventType, ptr, bytes.length);
  } finally {
    root.freeBuf(ptr, bytes.length);
  }
  return true;
}
```

- [ ] **Step 4: Integrate the helper into `util_cmd.ts`**

Import `dispatchSpecialInput` and `routeTerminalWrite`, remove the local `LSP_SESSION_ID`, and replace terminal output routing with:

```ts
if (unknown.name === "terminalWrite") {
  routeTerminalWrite(
    unknown.args.session_id,
    unknown.args.data,
    (data) => { void lsp({ data }); },
    (sessionId, data) => { void terminal({ sessionId, data }); },
  );
} else {
  return animal.call_unknown_fn(idx, unknown);
}
```

Replace the `input_string` SharedObject's unreturned async IIFE with this synchronous handler. Special dispatch exceptions escape so the caller's proxy rejects; ordinary terminal reporting remains fire-and-forget:

```ts
shared.push(
  new SharedObject(
    ({ sessionId, data }: {
      sessionId: number;
      data: string | number[] | Uint8Array;
    }) => {
      if (
        dispatchSpecialInput(
          vfs_root,
          animal.get_share_memory().memory,
          { sessionId, data },
        )
      ) return;

      if (typeof data !== "string") {
        throw new Error("terminal input must be a string");
      }
      try {
        for (const char of data) {
          const codePoint = char.codePointAt(0);
          if (codePoint !== undefined) vfs_root.dispatch(sessionId, 0, codePoint, 0);
        }
      } catch (error) {
        void terminal({
          sessionId,
          data: new TextEncoder().encode(`Error: ${error}\r\n`),
        });
      }
    },
    ctx.input_string_id,
  ),
);
```

- [ ] **Step 5: Run tests and page build**

Run: `deno test --allow-read page/src/worker_process/lsp_dispatch_test.ts && bun run --cwd page build`

Expected: 4 tests PASS and page build succeeds.

- [ ] **Step 6: Commit**

```bash
git add page/src/worker_process/lsp_dispatch.ts page/src/worker_process/lsp_dispatch_test.ts page/src/worker_process/util_cmd.ts
git commit -m "fix(lsp): route and acknowledge worker messages"
```

---

### Task 4: Rust Document VFS Synchronization Middleware

**Files:**
- Create: `page/src/rust_document_sync.ts`
- Create: `page/src/rust_document_sync_test.ts`

**Interfaces:**
- Produces: `RustDocumentSync`, `VfsWriter`, `TimerScheduler`, and `middleware: TextDocumentSynchronizationMiddleware`.
- Consumes later: Task 5 `rust_lsp_client.ts` supplies a real `VfsWriter`.

- [ ] **Step 1: Write deterministic failing synchronization tests**

Create `page/src/rust_document_sync_test.ts` with a fake scheduler that stores callbacks until `runAll()`, fake Rust documents exposing `uri`, `languageId`, `version`, and `getText`, and these assertions:

```ts
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

Deno.test("didChange forwards immediately and debounces only VFS", async () => {
  const writes: Array<[string, string]> = [];
  const scheduler = new FakeScheduler();
  const sync = new RustDocumentSync(async (path, text) => {
    writes.push([path, text]);
  }, { scheduler });
  const calls: string[] = [];
  const first = document("file:///src/main.rs", "fn main(){ let x = ; }", 2);
  await sync.middleware.didChange!({ document: first, contentChanges: [] } as never, async () => {
    calls.push("next");
  });
  assert(calls.join() === "next", "didChange was delayed");
  assert(writes.length === 0, "VFS was not debounced");
  const second = document("file:///src/main.rs", "fn main() {}", 3);
  await sync.middleware.didChange!({ document: second, contentChanges: [] } as never, async () => {});
  scheduler.runAll();
  await sync.dispose();
  assert(writes.length === 1 && writes[0][1] === "fn main() {}", "latest text not coalesced");
});

Deno.test("different Rust file URIs retain independent snapshots", async () => {
  const writes: string[] = [];
  const scheduler = new FakeScheduler();
  const sync = new RustDocumentSync(async (path) => { writes.push(path); }, { scheduler });
  const next = async () => {};
  await sync.middleware.didChange!({
    document: document("file:///src/main.rs", "fn main() {}", 2),
    contentChanges: [],
  } as never, next);
  await sync.middleware.didChange!({
    document: document("file:///src/secondary.rs", "pub fn value() {}", 1),
    contentChanges: [],
  } as never, next);
  scheduler.runAll();
  await sync.dispose();
  assert(writes.sort().join(",") === "/src/main.rs,/src/secondary.rs", `wrong paths: ${writes}`);
});

Deno.test("didClose flushes VFS before standard close", async () => {
  const order: string[] = [];
  const scheduler = new FakeScheduler();
  const sync = new RustDocumentSync(async () => { order.push("write"); }, { scheduler });
  const changed = document("file:///src/main.rs", "fn main() {}", 2);
  await sync.middleware.didChange!({ document: changed, contentChanges: [] } as never, async () => {});
  await sync.middleware.didClose!(changed, async () => { order.push("close"); });
  assert(order.join(",") === "write,close", `wrong close order: ${order}`);
});

Deno.test("non-Rust and non-file models bypass VFS mirroring", async () => {
  let writes = 0;
  const sync = new RustDocumentSync(async () => { writes++; });
  const next = async () => {};
  await sync.middleware.didOpen!(document("untitled:Untitled-1", "fn main() {}", 1), next);
  await sync.middleware.didOpen!(document("file:///src/main.ts", "const x = 1", 1, "typescript"), next);
  assert(writes === 0, `unexpected writes: ${writes}`);
});

Deno.test("writer failure is logged and does not suppress LSP continuation", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const scheduler = new FakeScheduler();
  const sync = new RustDocumentSync(
    async () => { throw new Error("write failed"); },
    { scheduler, logger: (message) => logs.push(message) },
  );
  const opened = document("file:///src/main.rs", "fn main() {}", 1);
  await sync.middleware.didOpen!(opened, async () => { calls.push("open"); });
  await sync.middleware.didChange!({ document: opened, contentChanges: [] } as never, async () => {
    calls.push("change");
  });
  await sync.middleware.didClose!(opened, async () => { calls.push("close"); });
  assert(calls.join(",") === "open,change,close", `suppressed continuation: ${calls}`);
  assert(logs.every((message) => message.includes("/src/main.rs")) && logs.length >= 2, "missing path logs");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `deno test --allow-read page/src/rust_document_sync_test.ts`

Expected: FAIL because `rust_document_sync.ts` does not exist.

- [ ] **Step 3: Implement per-URI snapshot scheduling**

Create `page/src/rust_document_sync.ts` using type-only imports from `vscode` and `vscode-languageclient/browser.js`:

```ts
import type { TextDocument } from "vscode";
import type { TextDocumentSynchronizationMiddleware } from "vscode-languageclient/browser.js";

export type VfsWriter = (path: string, content: string) => Promise<void>;
export type TimerScheduler = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

type Snapshot = { uri: string; path: string; content: string };
type PendingSnapshot = Snapshot & { handle: unknown };

const defaultScheduler: TimerScheduler = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as number),
};

export class RustDocumentSync {
  readonly middleware: TextDocumentSynchronizationMiddleware;
  private readonly debounceMs: number;
  private readonly scheduler: TimerScheduler;
  private readonly logger: (message: string, error: unknown) => void;
  private readonly pending = new Map<string, PendingSnapshot>();
  private readonly writes = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly write: VfsWriter,
    options: {
      debounceMs?: number;
      scheduler?: TimerScheduler;
      logger?: (message: string, error: unknown) => void;
    } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.logger = options.logger ?? ((message, error) => console.error(message, error));
    this.middleware = {
      didOpen: async (document, next) => {
        const snapshot = this.snapshot(document);
        try {
          if (snapshot) await this.queueWrite(snapshot);
        } finally {
          await next(document);
        }
      },
      didChange: (event, next) => {
        const snapshot = this.snapshot(event.document);
        if (snapshot) this.schedule(snapshot);
        return next(event);
      },
      didClose: async (document, next) => {
        try {
          await this.flush(document);
        } finally {
          await next(document);
        }
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const snapshots = [...this.pending.values()];
    this.pending.clear();
    for (const snapshot of snapshots) {
      this.scheduler.clear(snapshot.handle);
    }
    const queued = snapshots.map((snapshot) => this.queueWrite(snapshot));
    await Promise.all(queued);
    await Promise.all([...this.writes.values()]);
  }

  private snapshot(document: TextDocument): Snapshot | undefined {
    const { uri } = document;
    if (
      document.languageId !== "rust" || uri.scheme !== "file" ||
      uri.authority !== "" || !uri.path.startsWith("/")
    ) return undefined;
    return { uri: uri.toString(), path: uri.path, content: document.getText() };
  }

  private schedule(snapshot: Snapshot): void {
    if (this.disposed) return;
    const previous = this.pending.get(snapshot.uri);
    if (previous) this.scheduler.clear(previous.handle);
    let handle: unknown;
    handle = this.scheduler.set(() => {
      const current = this.pending.get(snapshot.uri);
      if (!current || current.handle !== handle) return;
      this.pending.delete(snapshot.uri);
      void this.queueWrite(current);
    }, this.debounceMs);
    this.pending.set(snapshot.uri, { ...snapshot, handle });
  }

  private async flush(document: TextDocument): Promise<void> {
    const snapshot = this.snapshot(document);
    if (!snapshot) return;
    const pending = this.pending.get(snapshot.uri);
    if (pending) {
      this.scheduler.clear(pending.handle);
      this.pending.delete(snapshot.uri);
      await this.queueWrite(snapshot);
    } else {
      await this.writes.get(snapshot.uri);
    }
  }

  private queueWrite(snapshot: Snapshot): Promise<void> {
    const previous = this.writes.get(snapshot.uri) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous
      .then(() => this.write(snapshot.path, snapshot.content))
      .catch((error) => this.logger(`failed to mirror ${snapshot.path}`, error))
      .finally(() => {
        if (this.writes.get(snapshot.uri) === current) this.writes.delete(snapshot.uri);
      });
    this.writes.set(snapshot.uri, current);
    return current;
  }
}
```

- [ ] **Step 4: Run tests and formatting**

Run: `deno test --allow-read page/src/rust_document_sync_test.ts && deno fmt --check page/src/rust_document_sync.ts page/src/rust_document_sync_test.ts`

Expected: 5 tests PASS and formatting check PASS.

- [ ] **Step 5: Commit**

```bash
git add page/src/rust_document_sync.ts page/src/rust_document_sync_test.ts
git commit -m "feat(lsp): mirror open Rust documents"
```

---

### Task 5: Readiness Gate And Application Client Lifecycle

**Files:**
- Create: `page/src/lsp_start_gate.ts`
- Create: `page/src/lsp_start_gate_test.ts`
- Create: `page/src/rust_lsp_client.ts`
- Modify: `page/src/App.tsx:1-100,214-221`

**Interfaces:**
- Consumes: `createLspConnection`, `RustDocumentSync`, `Ctx`, and existing `rust_file`.
- Produces: `LspStartGate<TMonaco>` and `startRustLspClient(ctx): Promise<{ dispose(): Promise<void> }>`.

- [ ] **Step 1: Write failing readiness gate tests**

Create `page/src/lsp_start_gate_test.ts` and cover both readiness orders, repeated notifications, failed startup, and disposal:

```ts
import { LspStartGate } from "./lsp_start_gate.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("gate starts exactly once after both readiness states", async () => {
  for (const order of ["monaco-first", "vfs-first"] as const) {
    let starts = 0;
    let disposals = 0;
    const gate = new LspStartGate<object>(async () => {
      starts++;
      return { async dispose() { disposals++; } };
    });
    if (order === "monaco-first") {
      gate.setMonaco({});
      gate.setVfsReady();
    } else {
      gate.setVfsReady();
      gate.setMonaco({});
    }
    gate.setVfsReady();
    gate.setMonaco({});
    await gate.started();
    assert(starts === 1, `${order} started ${starts} times`);
    await gate.dispose();
    assert(disposals === 1, `${order} disposed ${disposals} times`);
  }
});

Deno.test("gate never starts after disposal", async () => {
  let starts = 0;
  const gate = new LspStartGate<object>(async () => {
    starts++;
    return { async dispose() {} };
  });
  await gate.dispose();
  gate.setMonaco({});
  gate.setVfsReady();
  assert(starts === 0, "disposed gate started");
});

Deno.test("failed startup is not retried within the same mount", async () => {
  let starts = 0;
  const gate = new LspStartGate<object>(async () => {
    starts++;
    throw new Error("start failed");
  });
  gate.setMonaco({});
  gate.setVfsReady();
  await gate.started()?.catch(() => undefined);
  gate.setMonaco({});
  gate.setVfsReady();
  await gate.started()?.catch(() => undefined);
  assert(starts === 1, `failed startup retried ${starts} times`);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `deno test --allow-read page/src/lsp_start_gate_test.ts`

Expected: FAIL because `lsp_start_gate.ts` does not exist.

- [ ] **Step 3: Implement the exactly-once gate**

Create `page/src/lsp_start_gate.ts`:

```ts
export type DisposableLspSession = { dispose(): Promise<void> };

export class LspStartGate<TMonaco> {
  private monaco: TMonaco | undefined;
  private vfsReady = false;
  private startPromise: Promise<DisposableLspSession> | undefined;
  private session: DisposableLspSession | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly start: (monaco: TMonaco) => Promise<DisposableLspSession>,
  ) {}

  setMonaco(monaco: TMonaco): void {
    this.monaco = monaco;
    this.tryStart();
  }

  setVfsReady(): void {
    this.vfsReady = true;
    this.tryStart();
  }

  started(): Promise<void> | undefined {
    return this.startPromise?.then(() => undefined);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      let session: DisposableLspSession | undefined;
      try {
        session = await this.startPromise;
      } catch {
        return;
      }
      if (this.session === session) {
        this.session = undefined;
        await session?.dispose();
      }
    })();
    return this.disposePromise;
  }

  private tryStart(): void {
    if (this.disposed || this.startPromise || !this.vfsReady || !this.monaco) return;
    this.startPromise = this.start(this.monaco).then(async (session) => {
      if (this.disposed) await session.dispose();
      else this.session = session;
      return session;
    });
  }
}
```

- [ ] **Step 4: Construct the real Rust language client**

Create `page/src/rust_lsp_client.ts`:

```ts
import { SharedObjectRef } from "@oligami/shared-object";
import { MonacoLanguageClient } from "monaco-languageclient";
import type { Ctx } from "./ctx";
import { rust_file } from "./config";
import { createLspConnection } from "./lsp_bridge";
import { RustDocumentSync } from "./rust_document_sync";
import { VFS_SYNC_SESSION_ID } from "./lsp_protocol";

export async function startRustLspClient(ctx: Ctx) {
  const input = new SharedObjectRef(ctx.input_string_id).proxy<
    (args: { sessionId: number; data: string }) => Promise<void>
  >();
  const sync = new RustDocumentSync(async (path, content) => {
    if (path === "/src/main.rs") rust_file.data = new TextEncoder().encode(content);
    await input({
      sessionId: VFS_SYNC_SESSION_ID,
      data: JSON.stringify({ path, content }),
    });
  });
  const connection = createLspConnection(ctx);
  const client = new MonacoLanguageClient({
    name: "Rust Language Client",
    clientOptions: {
      documentSelector: [{ scheme: "file", language: "rust" }],
      middleware: sync.middleware,
      initializationOptions: {
        cargo: { sysroot: "/sysroot" },
        linkedProjects: ["/rust-project.json"],
        procMacro: { enable: false },
        checkOnSave: { enable: false },
        diagnostics: { enable: true, experimental: { enable: true } },
      },
    },
    messageTransports: connection,
  });
  try {
    await client.start();
  } catch (error) {
    await sync.dispose();
    connection.dispose();
    throw error;
  }
  return {
    async dispose() {
      await sync.dispose();
      if (client.needsStop()) await client.stop();
      connection.dispose();
    },
  };
}
```

- [ ] **Step 5: Gate startup in `App.tsx`**

Remove the eager `MonacoLanguageClient` and `createLspConnection` imports.
Retain `SharedObjectRef`, which is still used for terminal/session and sysroot
operations. Import `onCleanup`, `LspStartGate`, and `startRustLspClient`.
Replace the old handlers and readiness object with this structure inside `App`:

```ts
import { createSignal, For, lazy, onCleanup, Suspense } from "solid-js";
import { default_value } from "./config";
import { LspStartGate } from "./lsp_start_gate";
import { startRustLspClient } from "./rust_lsp_client";
```

Keep the existing terminal, context, button, sysroot, and SharedObject imports;
the four lines above show the exact changed/new imports.

```ts
const lspGate = new LspStartGate<unknown>(async () =>
  await startRustLspClient(props.ctx)
);

const handleMount = (monaco: unknown) => {
  lspGate.setMonaco(monaco);
};

const [isReady, setIsReady] = createSignal(false);
const sharedReady = new SharedObject(() => {
  setIsReady(true);
  lspGate.setVfsReady();
}, props.ctx.vfs_ready_id);

onCleanup(() => {
  sharedReady.bc.close();
  void lspGate.dispose();
});
```

Delete the previous `let shared_ready` guard, because it was local to one App call and never reusable. Delete `handleEditorChange` entirely.

Keep `path="/src/main.rs"`, `language="rust"`, and the static
`value={default_value}`, but remove `onChange={handleEditorChange}` because
middleware now owns VFS mirroring. `solid-monaco` 0.3.0 has no `defaultValue`
prop; its deferred value effect only rewrites the model if the supplied value
prop itself changes, and this module constant never changes.

The final editor props are:

```tsx
<MonacoEditor
  language="rust"
  path="/src/main.rs"
  value={default_value}
  height="30vh"
  onMount={handleMount}
/>
```

- [ ] **Step 6: Run unit tests and page build**

Run: `deno test --allow-read page/src/lsp_start_gate_test.ts page/src/rust_document_sync_test.ts page/src/lsp_protocol_test.ts page/src/worker_process/lsp_dispatch_test.ts && bun run --cwd page build`

Expected: all focused tests PASS and page build succeeds.

- [ ] **Step 7: Commit**

```bash
git add page/src/lsp_start_gate.ts page/src/lsp_start_gate_test.ts page/src/rust_lsp_client.ts page/src/App.tsx
git commit -m "feat(lsp): start rust-analyzer after VFS readiness"
```

---

### Task 6: Real Embedded Rust-Analyzer Diagnostics Test

**Files:**
- Create: `scripts/vfs_lsp_diagnostics_test.ts`
- Create: `scripts/vfs_lsp_diagnostics_worker.ts`
- Reuse: `scripts/build_preopen.ts`, `scripts/sysroot_cache.ts`, `page/src/lsp_protocol.ts`

**Interfaces:**
- Consumes: built `page/src/worker_process/vfs_bindings/vfs.core.wasm` and Task 1 framing helpers.
- Produces: one command that proves initialize, invalid diagnostics, and valid-code clearing against real `lsp_opt.wasm`.

- [ ] **Step 1: Create the RED parent/worker test with invalid-only assertion**

Create `scripts/vfs_lsp_diagnostics_test.ts` with these exact lifecycle and cleanup requirements:

1. Remove and recreate `./test_workspace_lsp_diagnostics`.
2. Call `prepareCachedSysroot({ workspaceSysroot: "./test_workspace_lsp_diagnostics/sysroot" })`.
3. Write `Cargo.toml`, `src/main.rs`, and `rust-project.json` with root module `/src/main.rs`, edition 2021, no deps, and sysroot source `/sysroot/lib/rustlib/src/rust/library`.
4. Build a `/` preopen with `buildPreopenDirectory`, delete the physical temporary directory in `finally`, and instantiate `WASIFarm` with that preopen.
5. Start `vfs_lsp_diagnostics_worker.ts`, pass `farm.get_ref()`, enforce a 120-second watchdog, terminate the worker, print its detail, and exit 1 when `ok` is false.

Use this complete parent structure:

```ts
import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { buildPreopenDirectory } from "./build_preopen.ts";
import { prepareCachedSysroot } from "./sysroot_cache.ts";

const testDir = "./test_workspace_lsp_diagnostics";
await Deno.remove(testDir, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await prepareCachedSysroot({ workspaceSysroot: `${testDir}/sysroot` });
await Deno.mkdir(`${testDir}/src`, { recursive: true });
await Deno.writeTextFile(
  `${testDir}/Cargo.toml`,
  `[package]\nname = "lsp-diagnostics"\nversion = "0.1.0"\nedition = "2021"\n`,
);
await Deno.writeTextFile(`${testDir}/src/main.rs`, "fn main() {}\n");
await Deno.writeTextFile(
  `${testDir}/rust-project.json`,
  JSON.stringify({
    sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
    crates: [{ root_module: "/src/main.rs", edition: "2021", deps: [] }],
  }),
);
const preopen = await (async () => {
  try {
    return await buildPreopenDirectory("/", testDir);
  } finally {
    await Deno.remove(testDir, { recursive: true });
  }
})();
const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) => console.log(`[stdout] ${message}`)),
  ConsoleStdout.lineBuffered((message) => console.error(`[stderr] ${message}`)),
  [preopen],
  {
    allocator_size: 100 * 1024 * 1024,
    unknown_fn(message: unknown) {
      const name = (message as { name?: string }).name;
      if (name === "terminalWrite" || name === "sysrootStartFetch") return {};
      if (name === "sysrootGetNextFileMeta") {
        return { has_file: false, name_len: 0, data_len: 0 };
      }
      if (name === "sysrootReadFileName") return { name: [] };
      if (name === "sysrootReadFileChunk") return { chunk: [] };
      throw new Error(`unexpected callback: ${name ?? "unknown"}`);
    },
  },
);
const worker = new Worker(
  new URL("./vfs_lsp_diagnostics_worker.ts", import.meta.url),
  { type: "module" },
);
const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
  const timer = setTimeout(() => {
    worker.terminate();
    resolve({ ok: false, detail: "diagnostics worker timed out after 120 seconds" });
  }, 120_000);
  worker.onmessage = (event) => {
    clearTimeout(timer);
    resolve(event.data);
  };
  worker.onerror = (event) => {
    clearTimeout(timer);
    resolve({ ok: false, detail: event.message });
  };
  worker.postMessage({ wasiRef: farm.get_ref() });
});
worker.terminate();
console.log(result.detail);
if (!result.ok) Deno.exit(1);
```

Create `scripts/vfs_lsp_diagnostics_worker.ts` with this complete implementation:

```ts
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "../page/src/worker_process/vfs_bindings/common.ts";
import { custom_instantiate } from "../page/src/worker_process/vfs_bindings/inst.ts";
import {
  LSP_SESSION_ID,
  LspFrameDecoder,
  encodeLspMessage,
  isLspSession,
  toLspBytes,
} from "../page/src/lsp_protocol.ts";

await set_fake_worker();

const bindingsDir = new URL(
  "../page/src/worker_process/vfs_bindings/",
  import.meta.url,
);

globalThis.onmessage = async (event) => {
  try {
    const wasm = await WebAssembly.compile(
      await Deno.readFile(new URL("vfs.core.wasm", bindingsDir)),
    );
    const animal = new WASIFarmAnimal(
      event.data.wasiRef,
      ["vfs-lsp-diagnostics"],
      ["VFS_THREADS=8", "RUST_BACKTRACE=full"],
      {
        can_thread_spawn: true,
        thread_spawn_worker_url: new URL("thread_spawn.ts", bindingsDir).href,
        thread_spawn_wasm: wasm,
        worker_background_worker_url: new URL(
          "worker_background_worker.ts",
          bindingsDir,
        ).href,
        share_memory: {
          memory: new WebAssembly.Memory({
            initial: 1032,
            maximum: 32775,
            shared: true,
          }),
        },
      },
    );
    await animal.wait_worker_background_worker();

    const messages: any[] = [];
    const decoder = new LspFrameDecoder();
    const sharedMemory = animal.get_share_memory().memory;
    const root = await custom_instantiate(
      wasm,
      animal.wasiImport,
      animal.wasiThreadImport,
      animal.get_share_memory(),
      (index, message: { name?: string; args?: Record<string, unknown> }) => {
        if (message.name === "terminalWrite") {
          const args = message.args as { session_id: number; data: unknown };
          if (isLspSession(args.session_id)) {
            messages.push(...decoder.push(toLspBytes(args.data)));
          }
          return;
        }
        return animal.call_unknown_fn(index, message);
      },
    );
    animal.start(root);

    Atomics.store(new Uint32Array(sharedMemory.buffer, 1084028, 1), 0, 1000);
    Atomics.store(new Uint32Array(sharedMemory.buffer, 1083752, 1), 0, 100);
    Atomics.store(new Uint32Array(sharedMemory.buffer, 1083756, 1), 0, 100);

    const send = (message: unknown) => {
      const bytes = encodeLspMessage(message);
      const ptr = root.allocBuf(bytes.length);
      try {
        new Uint8Array(sharedMemory.buffer).set(bytes, ptr);
        root.dispatch(LSP_SESSION_ID, 6, ptr, bytes.length);
      } finally {
        root.freeBuf(ptr, bytes.length);
      }
    };

    const waitForMessage = async (
      predicate: (message: any) => boolean,
      description: string,
    ): Promise<any> => {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for ${description}`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: "file:///",
        capabilities: { textDocument: { publishDiagnostics: {} } },
        initializationOptions: {
          cargo: { sysroot: "/sysroot" },
          linkedProjects: ["/rust-project.json"],
          procMacro: { enable: false },
          checkOnSave: { enable: false },
        },
      },
    });
    await waitForMessage(
      (message) => message.id === 1 && message.result?.capabilities,
      "initialize response",
    );
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    const uri = "file:///src/main.rs";
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: "rust",
          version: 1,
          text: "fn main() { let value = ; }\n",
        },
      },
    });
    const isPublication = (message: any) =>
      message.method === "textDocument/publishDiagnostics" &&
      message.params?.uri === uri;
    await waitForMessage(
      (message) =>
        isPublication(message) &&
        message.params.diagnostics.some((diagnostic: any) =>
          diagnostic.severity === 1 && diagnostic.range?.start?.line === 0
        ),
      "invalid Rust diagnostic",
    );

    for (let index = messages.length - 1; index >= 0; index--) {
      if (isPublication(messages[index])) messages.splice(index, 1);
    }
    send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: "fn main() {}\n" }],
      },
    });
    await waitForMessage(
      (message) =>
        isPublication(message) &&
        !message.params.diagnostics.some((diagnostic: any) =>
          diagnostic.severity === 1
        ),
      "cleared Rust diagnostic",
    );
    globalThis.postMessage({
      ok: true,
      detail: "rust-analyzer published and cleared diagnostics",
    });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};
```

- [ ] **Step 2: Run the real invalid-to-valid integration test**

Run: `deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts`

Expected: exit 0 with `rust-analyzer published and cleared diagnostics`.

- [ ] **Step 3: Commit**

```bash
git add scripts/vfs_lsp_diagnostics_test.ts scripts/vfs_lsp_diagnostics_worker.ts
git commit -m "test(lsp): verify embedded diagnostics lifecycle"
```

---

### Task 7: Browser Marker Acceptance Test

**Files:**
- Create: `page/src/lsp_test_api.ts`
- Modify: `page/src/App.tsx`
- Modify: `page/src/rust_lsp_client.ts`
- Create: `scripts/lsp_browser_diagnostics_test.mjs`
- Modify: `package.json`
- Modify: `page/vite.config.ts`
- Regenerate: `package-lock.json` with npm
- Regenerate: `bun.lockb` with Bun

**Interfaces:**
- Consumes: the real App, Monaco, language client readiness, and successful VFS writer acknowledgements.
- Produces: `bun run test:lsp-browser` and a build-time-gated `window.__rubrcLspTest` object only when `VITE_RUBRC_LSP_TEST=1`.

- [ ] **Step 1: Add Puppeteer and the failing browser command**

Run: `npm install --save-dev --save-exact puppeteer@25.3.0 && bun install`

Expected: `package.json` contains `"puppeteer": "25.3.0"`; npm regenerates `package-lock.json`, Bun regenerates `bun.lockb`, and neither lockfile is edited manually.

Add this root script:

```json
"test:lsp-browser": "VITE_RUBRC_LSP_TEST=1 bun run --cwd page build && node scripts/lsp_browser_diagnostics_test.mjs"
```

Create `scripts/lsp_browser_diagnostics_test.mjs` with this complete test. It is
intentionally RED until Step 3 exposes the gated API:

```js
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";

const url = "http://127.0.0.1:4173";
const invalidMain = "fn main() { let value = ; }\n";
const validMain = "fn main() {}\n";
const invalidSecondary = "pub fn secondary() { let value = ; }\n";
let browser;
let preview;

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite preview did not start within 30 seconds");
}

try {
  preview = spawn(
    "bun",
    ["run", "--cwd", "page", "serve", "--host", "127.0.0.1", "--port", "4173"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  preview.stdout.resume();
  preview.stderr.resume();
  await waitForServer();

  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.__rubrcLspTest?.ready && window.__rubrcLspTest.monaco,
    { timeout: 120_000 },
  );

  await page.evaluate((text) => {
    const { monaco } = window.__rubrcLspTest;
    const uri = monaco.Uri.parse("file:///src/main.rs");
    const model = monaco.editor.getModel(uri);
    if (!model) throw new Error("main.rs Monaco model is missing");
    model.setValue(text);
  }, invalidMain);
  await page.waitForFunction(
    () => {
      const { monaco } = window.__rubrcLspTest;
      const uri = monaco.Uri.parse("file:///src/main.rs");
      return monaco.editor.getModelMarkers({ resource: uri }).some((marker) =>
        marker.severity === monaco.MarkerSeverity.Error && marker.startLineNumber === 1
      );
    },
    { timeout: 15_000 },
  );

  await page.evaluate((text) => {
    const { monaco } = window.__rubrcLspTest;
    monaco.editor.getModel(monaco.Uri.parse("file:///src/main.rs")).setValue(text);
  }, validMain);
  await page.waitForFunction(
    () => {
      const { monaco } = window.__rubrcLspTest;
      const uri = monaco.Uri.parse("file:///src/main.rs");
      return !monaco.editor.getModelMarkers({ resource: uri }).some((marker) =>
        marker.severity === monaco.MarkerSeverity.Error
      );
    },
    { timeout: 15_000 },
  );

  await page.evaluate((text) => {
    const { monaco } = window.__rubrcLspTest;
    const uri = monaco.Uri.parse("file:///src/secondary.rs");
    monaco.editor.getModel(uri)?.dispose();
    monaco.editor.createModel(text, "rust", uri);
  }, invalidSecondary);
  await page.waitForFunction(
    ({ expectedText }) => {
      const { monaco, vfsWrites } = window.__rubrcLspTest;
      const uri = monaco.Uri.parse("file:///src/secondary.rs");
      const marked = monaco.editor.getModelMarkers({ resource: uri }).some((marker) =>
        marker.severity === monaco.MarkerSeverity.Error
      );
      const mirrored = vfsWrites.some(({ path, content }) =>
        path === "/src/secondary.rs" && content === expectedText
      );
      return marked && mirrored;
    },
    { timeout: 15_000 },
    { expectedText: invalidSecondary },
  );

  const terminalText = await page.evaluate(() => document.body.innerText);
  if (terminalText.includes("textDocument/publishDiagnostics") || terminalText.includes("Content-Length:")) {
    throw new Error("LSP JSON-RPC was routed to the terminal");
  }
  if (browserErrors.length > 0) {
    throw new Error(`browser errors:\n${browserErrors.join("\n")}`);
  }
  await page.evaluate(() => {
    const { monaco } = window.__rubrcLspTest;
    monaco.editor.getModel(monaco.Uri.parse("file:///src/secondary.rs"))?.dispose();
  });
  console.log("browser displayed and cleared rust-analyzer markers");
} finally {
  await browser?.close();
  if (preview && preview.exitCode === null) {
    preview.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        preview.kill("SIGKILL");
        resolve();
      }, 2_000);
      preview.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
```

- [ ] **Step 2: Run browser test to verify RED**

Run: `bun run test:lsp-browser`

Expected: FAIL because `window.__rubrcLspTest` is absent.

- [ ] **Step 3: Add the gated test API**

Create `page/src/lsp_test_api.ts`:

```ts
import type * as Monaco from "monaco-editor";

type TestApi = {
  ready: boolean;
  monaco?: typeof Monaco;
  vfsWrites: Array<{ path: string; content: string }>;
};

declare global {
  interface Window {
    __rubrcLspTest?: TestApi;
  }
}

const enabled = import.meta.env.VITE_RUBRC_LSP_TEST === "1";

export function exposeMonaco(monaco: typeof Monaco): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.monaco = monaco;
}

export function markLspReady(): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.ready = true;
}

export function recordVfsWrite(path: string, content: string): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.vfsWrites.push({ path, content });
}
```

Import and call the test hooks at these exact success points:

```ts
// App.tsx
import { exposeMonaco } from "./lsp_test_api";

const handleMount = (monaco: typeof import("monaco-editor")) => {
  exposeMonaco(monaco);
  lspGate.setMonaco(monaco);
};
```

```ts
// rust_lsp_client.ts
import { markLspReady, recordVfsWrite } from "./lsp_test_api";

const sync = new RustDocumentSync(async (path, content) => {
  if (path === "/src/main.rs") rust_file.data = new TextEncoder().encode(content);
  await input({
    sessionId: VFS_SYNC_SESSION_ID,
    data: JSON.stringify({ path, content }),
  });
  recordVfsWrite(path, content);
});

await client.start();
markLspReady();
```

Do not record failed writes and do not set `ready` before `client.start()`
resolves.

Define one shared header object in `page/vite.config.ts` and apply it to both
development and preview servers so Puppeteer's page can construct shared Wasm
memory:

```ts
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";

const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig({
  plugins: [solidPlugin(), tailwindcss()],
  optimizeDeps: {
    exclude: ["brotli-dec-wasm"],
    esbuildOptions: { plugins: [importMetaUrlPlugin] },
  },
  server: { port: 3000, headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  build: {
    target: "esnext",
    minify: process.env.NODE_ENV === "production" ? true : false,
  },
  worker: { format: "es" },
  base: "./",
});
```

- [ ] **Step 4: Complete marker assertions in Puppeteer**

Run the complete script created in Step 1. Keep its predicate polling, terminal
routing assertion, secondary-model disposal, and `finally` cleanup unchanged;
do not replace them with fixed sleeps or screenshots.

- [ ] **Step 5: Run browser acceptance test**

Run: `bun run test:lsp-browser`

Expected: exit 0 with `browser displayed and cleared rust-analyzer markers`.

- [ ] **Step 6: Verify the production build omits the test API behavior**

Run: `bun run --cwd page build`

Expected: build succeeds without `VITE_RUBRC_LSP_TEST`; loading the normal bundle does not create `window.__rubrcLspTest`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json bun.lockb page/vite.config.ts page/src/lsp_test_api.ts page/src/App.tsx page/src/rust_lsp_client.ts scripts/lsp_browser_diagnostics_test.mjs
git commit -m "test(lsp): verify Monaco diagnostic markers"
```

---

### Task 8: Full Verification And Review

**Files:**
- Modify only if verification exposes a defect in the files owned by Tasks 1-7.

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: fresh evidence that focused tests, real rust-analyzer, browser markers, existing VFS tests, formatting, and builds pass together.

- [ ] **Step 1: Run all focused TypeScript tests**

Run:

```bash
deno test --allow-read \
  page/src/lsp_protocol_test.ts \
  page/src/worker_process/lsp_dispatch_test.ts \
  page/src/rust_document_sync_test.ts \
  page/src/lsp_start_gate_test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run existing bridge and configuration regression tests**

Run:

```bash
deno test --allow-read --allow-env --allow-write --allow-net \
  scripts/vfs_child_process_import_test.ts \
  scripts/vfs_http_import_test.ts \
  scripts/vfs_child_process_bridge_test.ts \
  scripts/vfs_http_bridge_test.ts \
  scripts/vfs_default_env_test.ts \
  scripts/vfs_unwind_config_test.ts
```

Expected: all existing tests PASS.

- [ ] **Step 3: Rebuild VFS and run real diagnostics**

Run: `bun run vfs:build && deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts`

Expected: VFS build succeeds and embedded rust-analyzer publishes then clears diagnostics.

- [ ] **Step 4: Run browser acceptance and page production build**

Run: `bun run test:lsp-browser && bun run --cwd page build`

Expected: browser marker lifecycle passes and production page build succeeds.

- [ ] **Step 5: Run formatting and repository checks**

Run:

```bash
deno fmt --check \
  page/src/lsp_protocol.ts \
  page/src/lsp_protocol_test.ts \
  page/src/lsp_bridge.ts \
  page/src/worker_process/lsp_dispatch.ts \
  page/src/worker_process/lsp_dispatch_test.ts \
  page/src/worker_process/util_cmd.ts \
  page/src/rust_document_sync.ts \
  page/src/rust_document_sync_test.ts \
  page/src/lsp_start_gate.ts \
  page/src/lsp_start_gate_test.ts \
  page/src/rust_lsp_client.ts \
  page/src/lsp_test_api.ts \
  page/src/App.tsx \
  scripts/vfs_lsp_diagnostics_test.ts \
  scripts/vfs_lsp_diagnostics_worker.ts \
  scripts/lsp_browser_diagnostics_test.mjs
git diff --check
```

Expected: formatting and whitespace checks PASS.

- [ ] **Step 6: Request code review and address only concrete findings**

Review against `docs/superpowers/specs/2026-07-19-rust-analyzer-live-diagnostics-design.md`, focusing on transport framing, event ordering, cleanup, stale markers, and browser-test determinism. If fixes are needed, add a RED regression test first, implement the smallest correction, and rerun the affected task plus Steps 1-5.

- [ ] **Step 7: Commit verification-only corrections if any**

If review required source changes:

```bash
git add \
  page/src/lsp_protocol.ts page/src/lsp_protocol_test.ts \
  page/src/lsp_bridge.ts \
  page/src/worker_process/lsp_dispatch.ts \
  page/src/worker_process/lsp_dispatch_test.ts \
  page/src/worker_process/util_cmd.ts \
  page/src/rust_document_sync.ts page/src/rust_document_sync_test.ts \
  page/src/lsp_start_gate.ts page/src/lsp_start_gate_test.ts \
  page/src/rust_lsp_client.ts page/src/lsp_test_api.ts page/src/App.tsx \
  scripts/vfs_lsp_diagnostics_test.ts scripts/vfs_lsp_diagnostics_worker.ts \
  scripts/lsp_browser_diagnostics_test.mjs \
  package.json package-lock.json bun.lockb
git commit -m "fix(lsp): address diagnostics review findings"
```

If no source changes were required, do not create an empty commit.
