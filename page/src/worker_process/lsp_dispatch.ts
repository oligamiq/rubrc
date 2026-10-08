import {
  isLspSession,
  LSP_SESSION_ID,
  STDLIB_CACHE_SESSION_ID,
  toLspBytes,
  VFS_SYNC_SESSION_ID,
} from "../lsp_protocol.ts";

type Root = {
  allocBuf(length: number): number;
  dispatch(
    sessionId: number,
    eventType: number,
    ptr: number,
    length: number,
  ): void;
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

export function routeWasiTerminalWrite(
  args: { session_id: number; data: unknown },
  lsp: (message: { data: unknown }) => void,
  terminal: (sessionId: number, data: unknown) => void,
): void {
  routeTerminalWrite(
    args.session_id,
    args.data,
    (data) => lsp({ data }),
    terminal,
  );
}

export function dispatchSpecialInput(
  root: Root,
  memory: WebAssembly.Memory,
  input: { sessionId: number; data: string | number[] | Uint8Array },
): boolean {
  const sessionId = input.sessionId >>> 0;
  if (sessionId === STDLIB_CACHE_SESSION_ID) {
    if (!(input.data instanceof Uint8Array)) {
      throw new Error("cache payload must be binary");
    }
    const length = input.data.length + 4;
    const ptr = root.allocBuf(length);
    try {
      new DataView(memory.buffer).setUint32(ptr, 1, true);
      new Uint8Array(memory.buffer).set(input.data, ptr + 4);
      root.dispatch(sessionId, 11, ptr, length);
      if (new DataView(memory.buffer).getUint32(ptr, true) !== 0) {
        throw new Error("binary cache installation failed");
      }
    } finally {
      root.freeBuf(ptr, length);
    }
    return true;
  }
  const eventType = isLspSession(sessionId)
    ? 6
    : sessionId === VFS_SYNC_SESSION_ID
    ? 7
    : undefined;
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
