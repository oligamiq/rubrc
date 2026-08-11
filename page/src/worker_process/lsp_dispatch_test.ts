import { dispatchSpecialInput, routeTerminalWrite } from "./lsp_dispatch.ts";
import * as lspDispatch from "./lsp_dispatch.ts";
import { LSP_SESSION_ID, VFS_SYNC_SESSION_ID } from "../lsp_protocol.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("signed LSP output routes away from terminal", () => {
  const calls: string[] = [];
  routeTerminalWrite(
    -1,
    [1, 2],
    () => calls.push("lsp"),
    () => calls.push("terminal"),
  );
  routeTerminalWrite(
    7,
    [3],
    () => calls.push("lsp"),
    () => calls.push("terminal"),
  );
  assert(calls.join(",") === "lsp,terminal", `wrong routing: ${calls}`);
});

Deno.test("spawned terminal writes reach LSP transport and preserve terminals", () => {
  const routeWasiTerminalWrite = (
    lspDispatch as unknown as {
      routeWasiTerminalWrite?: (
        args: { session_id: number; data: unknown },
        lsp: (message: { data: unknown }) => void,
        terminal: (sessionId: number, data: unknown) => void,
      ) => void;
    }
  ).routeWasiTerminalWrite;
  assert(
    typeof routeWasiTerminalWrite === "function",
    "spawned terminal routing adapter is missing",
  );

  const calls: string[] = [];
  routeWasiTerminalWrite(
    { session_id: -1, data: [1, 2] },
    ({ data }) => calls.push(`lsp:${data}`),
    (sessionId, data) => calls.push(`terminal:${sessionId}:${data}`),
  );
  routeWasiTerminalWrite(
    { session_id: 7, data: [3] },
    ({ data }) => calls.push(`lsp:${data}`),
    (sessionId, data) => calls.push(`terminal:${sessionId}:${data}`),
  );

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
