export interface VfsDebugTraceRoot {
  allocBuf(len: number): number;
  freeBuf(ptr: number, len: number): void;
  debugSetTerminalCapture(enabled: boolean): void;
  debugTerminalOutputLen(): number;
  debugReadTerminalOutput(ptr: number, len: number): number;
  debugCaptureWaitSnapshot(): void;
}

export const VFS_DEBUG_TRACE_LIMIT_BYTES = 64 * 1024;

interface RetainedTraceChunk {
  text: string;
  bytes: number;
  priority: boolean;
}

export interface VfsDebugTraceSnapshot {
  trace: string;
  droppedChunks: number;
  retainedBytes: number;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes++;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function utf8Suffix(text: string, limitBytes: number): string {
  if (limitBytes <= 0) return "";
  let start = text.length;
  let retainedBytes = 0;
  while (start > 0) {
    let codeUnits = 1;
    let bytes = 3;
    const codeUnit = text.charCodeAt(start - 1);
    if (codeUnit <= 0x7f) {
      bytes = 1;
    } else if (codeUnit <= 0x7ff) {
      bytes = 2;
    } else if (
      codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 1 &&
      text.charCodeAt(start - 2) >= 0xd800 &&
      text.charCodeAt(start - 2) <= 0xdbff
    ) {
      codeUnits = 2;
      bytes = 4;
    }
    if (retainedBytes + bytes > limitBytes) break;
    retainedBytes += bytes;
    start -= codeUnits;
  }
  return text.slice(start);
}

function latestPrioritySnapshot(chunk: string): string {
  const marker = "[vfs-debug] snapshot ";
  const start = chunk.lastIndexOf(marker);
  if (start < 0) return "";
  const newline = chunk.indexOf("\n", start);
  const end = newline < 0 ? chunk.length : newline;
  return chunk.slice(start, end).replace(/\r$/, "");
}

function isPriorityTraceChunk(chunk: string): boolean {
  return chunk.includes("[vfs-debug] snapshot ");
}

export class VfsDebugTraceCollector {
  readonly #limitBytes: number;
  readonly #chunks: RetainedTraceChunk[] = [];
  #retainedBytes = 0;
  #droppedChunks = 0;
  #latestPriority: RetainedTraceChunk | undefined;

  constructor(limitBytes = VFS_DEBUG_TRACE_LIMIT_BYTES) {
    this.#limitBytes = Math.max(0, Math.floor(limitBytes));
  }

  push(chunk: string): void {
    if (chunk === "") return;
    let text = chunk;
    let bytes = utf8ByteLength(text);
    if (bytes > this.#limitBytes) {
      const prioritySnapshot = latestPrioritySnapshot(text);
      const priorityBytes = utf8ByteLength(prioritySnapshot);
      text = utf8Suffix(text, this.#limitBytes);
      if (
        prioritySnapshot !== "" && priorityBytes <= this.#limitBytes &&
        !text.includes(prioritySnapshot)
      ) {
        const separatorBytes = priorityBytes < this.#limitBytes ? 1 : 0;
        const recent = utf8Suffix(
          chunk,
          this.#limitBytes - priorityBytes - separatorBytes,
        );
        text = `${prioritySnapshot}${recent === "" ? "" : `\n${recent}`}`;
      }
      bytes = utf8ByteLength(text);
      this.#droppedChunks++;
    }
    if (text === "") return;

    const retained = {
      text,
      bytes,
      priority: isPriorityTraceChunk(text),
    };
    this.#chunks.push(retained);
    this.#retainedBytes += bytes;
    if (retained.priority) this.#latestPriority = retained;

    while (this.#retainedBytes > this.#limitBytes) {
      let evictIndex = this.#chunks.findIndex((item) =>
        item !== this.#latestPriority
      );
      if (evictIndex < 0) evictIndex = 0;
      const [evicted] = this.#chunks.splice(evictIndex, 1);
      this.#retainedBytes -= evicted.bytes;
      this.#droppedChunks++;
      if (evicted === this.#latestPriority) this.#latestPriority = undefined;
    }
  }

  snapshot(): VfsDebugTraceSnapshot {
    return {
      trace: this.#chunks.map((chunk) => chunk.text).join(""),
      droppedChunks: this.#droppedChunks,
      retainedBytes: this.#retainedBytes,
    };
  }
}

function safeEmit(
  emit: (chunk: string) => void,
  chunk: string,
): { ok: true } | { ok: false; error: unknown } {
  try {
    emit(chunk);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function vfsDebugTraceErrorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "Unknown";
    const name = error.name;
    return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(name)
      ? name
      : "Unknown";
  } catch {
    return "Unknown";
  }
}

function traceError(scope: string, operation: string, error: unknown): string {
  return `trace-error scope=${scope} operation=${operation} error=${
    vfsDebugTraceErrorName(error)
  }\n`;
}

export function drainVfsDebugTrace(
  root: VfsDebugTraceRoot,
  memory: WebAssembly.Memory,
): string {
  const len = root.debugTerminalOutputLen();
  if (len === 0) return "";
  const ptr = root.allocBuf(len);
  try {
    const read = root.debugReadTerminalOutput(ptr, len);
    return read === 0 ? "" : new TextDecoder().decode(
      new Uint8Array(memory.buffer, ptr, read).slice(),
    );
  } finally {
    root.freeBuf(ptr, len);
  }
}

export function startVfsDebugTracePump({
  root,
  memory,
  emit,
  intervalMs = 250,
  snapshotEvery = 20,
}: {
  root: VfsDebugTraceRoot;
  memory: WebAssembly.Memory;
  emit: (chunk: string) => void;
  intervalMs?: number;
  snapshotEvery?: number;
}): { stop(): void; captureSnapshot(): string } {
  let drainCount = 0;
  let stopped = false;
  root.debugSetTerminalCapture(true);

  const captureSnapshot = () => {
    root.debugCaptureWaitSnapshot();
    return drainVfsDebugTrace(root, memory);
  };
  const drain = () => {
    if (stopped) return;
    drainCount++;
    const errors: Array<{ operation: string; error: unknown }> = [];
    if (drainCount % snapshotEvery === 0) {
      try {
        root.debugCaptureWaitSnapshot();
      } catch (error) {
        errors.push({ operation: "snapshot", error });
      }
    }
    try {
      const chunk = drainVfsDebugTrace(root, memory);
      if (chunk !== "") {
        const emitted = safeEmit(emit, chunk);
        if (emitted.ok === false) {
          errors.push({ operation: "emit", error: emitted.error });
        }
      }
    } catch (error) {
      errors.push({ operation: "drain", error });
    }
    for (const error of errors) {
      safeEmit(emit, traceError("interval", error.operation, error.error));
    }
  };
  const timer = setInterval(drain, intervalMs);

  return {
    captureSnapshot,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const errors: Array<{ operation: string; error: unknown }> = [];
      let hasFailure = false;
      let primaryFailure: unknown;
      try {
        root.debugCaptureWaitSnapshot();
      } catch (error) {
        hasFailure = true;
        primaryFailure = error;
        errors.push({ operation: "snapshot", error });
      }
      try {
        const chunk = drainVfsDebugTrace(root, memory);
        if (chunk !== "") {
          const emitted = safeEmit(emit, chunk);
          if (emitted.ok === false) {
            errors.push({ operation: "emit", error: emitted.error });
          }
        }
      } catch (error) {
        if (!hasFailure) {
          hasFailure = true;
          primaryFailure = error;
        }
        errors.push({ operation: "drain", error });
      } finally {
        for (const error of errors) {
          safeEmit(emit, traceError("stop", error.operation, error.error));
        }
      }
      if (hasFailure) throw primaryFailure;
    },
  };
}

export function traceVfsHostCall<T>(
  id: number,
  name: string,
  emit: (line: string) => void,
  call: () => Promise<T>,
): Promise<T>;
export function traceVfsHostCall<T>(
  id: number,
  name: string,
  emit: (line: string) => void,
  call: () => T,
): T;
export function traceVfsHostCall(
  id: number,
  name: string,
  emit: (line: string) => void,
  call: () => unknown,
): unknown {
  const prefix = `host-call id=${id} name=${name}`;
  safeEmit(emit, `${prefix} phase=request\n`);
  try {
    const result = call();
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          safeEmit(emit, `${prefix} phase=response\n`);
          return value;
        },
        (error) => {
          safeEmit(
            emit,
            `${prefix} phase=reject error=${vfsDebugTraceErrorName(error)}\n`,
          );
          throw error;
        },
      );
    }
    safeEmit(emit, `${prefix} phase=response\n`);
    return result;
  } catch (error) {
    safeEmit(
      emit,
      `${prefix} phase=reject error=${vfsDebugTraceErrorName(error)}\n`,
    );
    throw error;
  }
}
