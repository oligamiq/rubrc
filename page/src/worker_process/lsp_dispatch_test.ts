import { dispatchSpecialInput, routeTerminalWrite } from "./lsp_dispatch.ts";
import * as lspDispatch from "./lsp_dispatch.ts";
import { LSP_SESSION_ID, VFS_SYNC_SESSION_ID } from "../lsp_protocol.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("signed LSP output routes away from terminal", () => {
  const calls: string[] = [];
  const lspResult = routeTerminalWrite(
    -1,
    [1, 2],
    () => {
      calls.push("lsp");
      return "lsp-result";
    },
    () => {
      calls.push("terminal");
      return "terminal-result";
    },
  );
  const terminalResult = routeTerminalWrite(
    7,
    [3],
    () => {
      calls.push("lsp");
      return "lsp-result";
    },
    () => {
      calls.push("terminal");
      return "terminal-result";
    },
  );
  assert(calls.join(",") === "lsp,terminal", `wrong routing: ${calls}`);
  assert(lspResult === "lsp-result", "LSP result was not propagated");
  assert(terminalResult === "terminal-result", "terminal result was not propagated");
});

Deno.test("spawned terminal writes reach LSP transport and preserve terminals", async () => {
  const routeWasiTerminalWrite = (
    lspDispatch as unknown as {
      routeWasiTerminalWrite?: (
        args: { session_id: number; data: unknown },
        lsp: (message: { data: unknown }) => unknown,
        terminal: (sessionId: number, data: unknown) => unknown,
      ) => unknown;
    }
  ).routeWasiTerminalWrite;
  assert(
    typeof routeWasiTerminalWrite === "function",
    "spawned terminal routing adapter is missing",
  );

  const calls: string[] = [];
  const lspResult = routeWasiTerminalWrite(
    { session_id: -1, data: [1, 2] },
    ({ data }) => {
      calls.push(`lsp:${data}`);
      return Promise.resolve("lsp-delivered");
    },
    (sessionId, data) => calls.push(`terminal:${sessionId}:${data}`),
  );
  const terminalResult = routeWasiTerminalWrite(
    { session_id: 7, data: [3] },
    ({ data }) => calls.push(`lsp:${data}`),
    (sessionId, data) => {
      calls.push(`terminal:${sessionId}:${data}`);
      return "terminal-delivered";
    },
  );

  assert(lspResult instanceof Promise, "spawned LSP promise was not propagated");
  assert(
    await lspResult === "lsp-delivered",
    "spawned LSP delivery result was lost",
  );
  assert(terminalResult === "terminal-delivered", "terminal result was lost");
  assert(
    calls.join("|") === "lsp:1,2|terminal:7:3",
    `wrong spawned terminal routing: ${calls}`,
  );
});

Deno.test("special input copies, dispatches, and frees synchronously", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const calls: string[] = [];
  const root = {
    allocBuf(length: number) {
      calls.push(`alloc:${length}`);
      return 16;
    },
    dispatch(session: number, event: number, ptr: number, length: number) {
      calls.push(`dispatch:${session}:${event}:${ptr}:${length}`);
      assert(
        new Uint8Array(memory.buffer, ptr, length)[0] === 65,
        "bytes not copied",
      );
    },
    freeBuf(ptr: number, length: number) {
      calls.push(`free:${ptr}:${length}`);
    },
  };
  assert(
    dispatchSpecialInput(root, memory, {
      sessionId: LSP_SESSION_ID,
      data: [65],
    }),
    "not handled",
  );
  assert(
    calls.join("|") === `alloc:1|dispatch:${LSP_SESSION_ID}:6:16:1|free:16:1`,
    "wrong order",
  );
});

Deno.test("VFS input uses event 7 and ordinary terminal input is not handled", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let event = -1;
  const root = {
    allocBuf() {
      return 0;
    },
    dispatch(_session: number, value: number) {
      event = value;
    },
    freeBuf() {},
  };
  assert(
    dispatchSpecialInput(root, memory, {
      sessionId: VFS_SYNC_SESSION_ID,
      data: "{}",
    }),
    "VFS not handled",
  );
  assert(event === 7, `expected event 7, got ${event}`);
  assert(
    !dispatchSpecialInput(root, memory, { sessionId: 3, data: "x" }),
    "terminal was consumed",
  );
});

Deno.test("dispatch failure still frees and propagates", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let freed = false;
  const root = {
    allocBuf() {
      return 0;
    },
    dispatch() {
      throw new Error("dispatch failed");
    },
    freeBuf() {
      freed = true;
    },
  };
  let threw = false;
  try {
    dispatchSpecialInput(root, memory, {
      sessionId: VFS_SYNC_SESSION_ID,
      data: "{}",
    });
  } catch {
    threw = true;
  }
  assert(threw && freed, "failure was swallowed or leaked buffer");
});

Deno.test("worker terminal forwarding observes rejected channel calls", async () => {
  const source = await Deno.readTextFile(
    new URL("./util_cmd.ts", import.meta.url),
  );
  assert(
    !source.includes("new SharedObjectRef(ctx.ls_id)"),
    "utility worker still owns a second unordered LSP channel",
  );
  assert(
    /routeTerminalWrite\([\s\S]*?\(\) => animal\.call_unknown_fn\(idx, unknown\)/.test(
      source,
    ),
    "utility LSP output does not delegate through the ordered farm callback",
  );
  assert(
    /observeAsyncFailure\(\s*terminal\(\{\s*sessionId,\s*data: data as any\s*\}\),\s*console\.error,?\s*\)/.test(
      source,
    ),
    "terminal forwarding rejection is not observed",
  );
});
