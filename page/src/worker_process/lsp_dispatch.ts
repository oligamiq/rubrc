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
