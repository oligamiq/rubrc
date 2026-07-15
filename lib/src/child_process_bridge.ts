import { Directory, File, type Inode } from "@bjorn3/browser_wasi_shim";

const MAX_MODULE_BYTES = 16 * 1024 * 1024;
const MAX_MODULE_CHUNK_BYTES = 256 * 1024;
const MAX_ARGV_BYTES = 256 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_ERROR_CHUNK_BYTES = 64 * 1024;
const MAX_FILESYSTEM_ENTRIES = 10_000;
const MAX_FILESYSTEM_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export const CHILD_PROCESS_MESSAGE_NAMES = [
  "childProcessStart",
  "childProcessWrite",
  "childProcessRun",
  "childProcessReadError",
  "childProcessRecover",
  "childProcessEnd",
] as const;

type ChildProcessMessageName = typeof CHILD_PROCESS_MESSAGE_NAMES[number];

export interface ChildProcessMessage {
  name: ChildProcessMessageName;
  args: Record<string, unknown>;
}

interface ChildWorker {
  onmessage: ((event: MessageEvent<WorkerResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

type TimerHandle = number | ReturnType<typeof setTimeout>;

interface ChildProcessTimers {
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(id: TimerHandle): void;
}

export interface ChildProcessBridgeOptions {
  getWasiRef: () => unknown;
  workerUrl: string | URL;
  filesystemRoot: Directory;
  uploadTimeoutMs: number;
  executionTimeoutMs: number;
  createWorker?: (url: string | URL, options: WorkerOptions) => ChildWorker;
  timers?: ChildProcessTimers;
}

interface FileSnapshot {
  kind: "file";
  inode: File;
  data: Uint8Array;
  readonly: boolean;
}

interface DirectorySnapshot {
  kind: "directory";
  inode: Directory;
  entries: Map<string, SnapshotEntry>;
}

interface ExcludedSnapshot {
  kind: "excluded";
  inode: Inode;
}

type SnapshotEntry = FileSnapshot | DirectorySnapshot | ExcludedSnapshot;

interface WorkerResult {
  status: number;
  error?: string;
  graceful: boolean;
}

interface RequestState {
  id: number;
  state: 1 | 2 | 3;
  args: string[];
  env: string[];
  expectedModuleBytes: number;
  module: Uint8Array<ArrayBuffer>;
  uploadedModuleBytes: number;
  baseline: DirectorySnapshot;
  timer: TimerHandle;
  worker?: ChildWorker;
  result?: WorkerResult;
  errorBytes?: Uint8Array;
  errorOffset: number;
  resolveRun?: (metadata: StateMetadata) => void;
}

interface StateMetadata {
  state: number;
  status: number;
  error_len: number;
}

export function isChildProcessMessage(
  value: unknown,
): value is ChildProcessMessage {
  if (!value || typeof value !== "object") return false;
  const { name, args } = value as { name?: unknown; args?: unknown };
  return typeof name === "string" && !!args && typeof args === "object" &&
    !Array.isArray(args) &&
    CHILD_PROCESS_MESSAGE_NAMES.some((candidate) => candidate === name);
}

function byteArray(
  value: unknown,
  field: string,
  maxBytes: number,
  maxLabel: string,
): Uint8Array<ArrayBuffer> {
  if (!Array.isArray(value)) {
    throw new TypeError(`child process ${field} must be a dense byte array`);
  }
  const length = value.length;
  if (
    typeof length !== "number" || !Number.isSafeInteger(length) || length < 0
  ) {
    throw new TypeError(`child process ${field} length must be a number`);
  }
  if (length > maxBytes) {
    throw new RangeError(`child process ${field} exceeds ${maxLabel}`);
  }
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    const byte = value[index];
    if (
      !Object.hasOwn(value, index) || !Number.isInteger(byte) || byte < 0 ||
      byte > 255
    ) {
      throw new TypeError(`child process ${field} must be a dense byte array`);
    }
    result[index] = byte;
  }
  return result;
}

function u32Arg(args: Record<string, unknown>, field: string): number {
  const value = args[field];
  if (
    !Number.isInteger(value) || (value as number) < 0 ||
    (value as number) > 0xffff_ffff
  ) {
    throw new TypeError(`child process ${field} must be a u32`);
  }
  return value as number;
}

function decodeList(value: unknown, field: string): string[] {
  const maxBytes = field === "argv" ? MAX_ARGV_BYTES : MAX_ENV_BYTES;
  const bytes = byteArray(value, field, maxBytes, "256 KiB");
  // Zero bytes encode no entries; producers must reject empty strings before joining.
  if (bytes.length === 0) return [];
  const entries = decoder.decode(bytes).split("\0");
  if (entries.some((entry) => entry.length === 0)) {
    throw new TypeError(`child process ${field} contains an empty entry`);
  }
  return entries;
}

function snapshotFilesystem(root: Directory): DirectorySnapshot {
  let entries = 0;
  let bytes = 0;
  const rootSnapshot: DirectorySnapshot = {
    kind: "directory",
    inode: root,
    entries: new Map(),
  };
  const visited = new Set<Inode>([root]);
  const pending: Array<[Directory, DirectorySnapshot]> = [[root, rootSnapshot]];

  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    const [directory, directorySnapshot] = next;
    for (const [name, entry] of directory.contents) {
      if (directorySnapshot === rootSnapshot && name === "sysroot") {
        directorySnapshot.entries.set(name, { kind: "excluded", inode: entry });
        continue;
      }
      entries++;
      if (entries > MAX_FILESYSTEM_ENTRIES) {
        throw new RangeError("child filesystem exceeds 10,000 entries");
      }
      if (visited.has(entry)) {
        throw new TypeError(
          "child filesystem contains a cyclic or shared inode",
        );
      }
      visited.add(entry);

      let entrySnapshot: SnapshotEntry;
      if (entry instanceof File) {
        bytes += entry.data.byteLength;
        if (bytes > MAX_FILESYSTEM_BYTES) {
          throw new RangeError("child filesystem exceeds 64 MiB");
        }
        entrySnapshot = {
          kind: "file",
          inode: entry,
          data: entry.data.slice(),
          readonly: entry.readonly,
        };
      } else if (entry instanceof Directory) {
        entrySnapshot = {
          kind: "directory",
          inode: entry,
          entries: new Map(),
        };
        pending.push([entry, entrySnapshot]);
      } else {
        throw new TypeError("child filesystem contains an unsupported inode");
      }
      directorySnapshot.entries.set(name, entrySnapshot);
    }
  }

  return rootSnapshot;
}

function restoreFilesystem(root: Directory, snapshot: DirectorySnapshot) {
  const pending: Array<[Directory, DirectorySnapshot]> = [[root, snapshot]];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    const [directory, directorySnapshot] = next;
    directory.contents.clear();
    for (const [name, entry] of directorySnapshot.entries) {
      if (entry.kind === "file") {
        entry.inode.data = entry.data.slice();
        entry.inode.readonly = entry.readonly;
      } else if (entry.kind === "directory") {
        pending.push([entry.inode, entry]);
      }
      directory.contents.set(name, entry.inode);
    }
  }
}

function stateMetadata(request: RequestState): StateMetadata {
  return {
    state: request.state,
    status: request.result?.status ?? 0,
    error_len: request.errorBytes?.length ?? 0,
  };
}

function validDuration(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fff_ffff) {
    throw new RangeError(`${field} must fit a non-negative platform timer`);
  }
}

function normalizeWorkerResult(value: unknown): WorkerResult {
  if (!value || typeof value !== "object") {
    throw new TypeError("child Worker returned invalid result");
  }
  const { status, error, graceful } = value as Record<string, unknown>;
  if (
    !Number.isInteger(status) || (status as number) < 0 ||
    (status as number) > 0xffff_ffff || typeof graceful !== "boolean" ||
    (error !== undefined && typeof error !== "string")
  ) {
    throw new TypeError("child Worker returned invalid result");
  }
  return {
    status: status as number,
    error: error as string | undefined,
    graceful,
  };
}

export function createChildProcessBridge(options: ChildProcessBridgeOptions) {
  validDuration(options.uploadTimeoutMs, "uploadTimeoutMs");
  validDuration(options.executionTimeoutMs, "executionTimeoutMs");
  const timers: ChildProcessTimers = options.timers ?? {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (id) =>
      globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const createWorker = options.createWorker ??
    ((url: string | URL, workerOptions: WorkerOptions) =>
      new Worker(url, workerOptions));
  let request: RequestState | undefined;
  let nextRequestId = 1;

  const requestFor = (args: Record<string, unknown>) => {
    const id = u32Arg(args, "request_id");
    if (!request || request.id !== id) {
      throw new Error(`Unknown or ended child process request ID: ${id}`);
    }
    return request;
  };

  const restore = (current: RequestState) => {
    restoreFilesystem(options.filesystemRoot, current.baseline);
  };

  const refreshUploadTimer = (current: RequestState) => {
    timers.clearTimeout(current.timer);
    current.timer = timers.setTimeout(() => {
      if (request !== current || current.state !== 1) return;
      restore(current);
      request = undefined;
    }, options.uploadTimeoutMs);
  };

  const complete = (current: RequestState, result: WorkerResult) => {
    if (request !== current || current.state !== 2) return;
    timers.clearTimeout(current.timer);
    current.worker?.terminate();
    current.worker = undefined;
    if (!result.graceful) restore(current);
    current.result = { status: result.status, graceful: result.graceful };
    const errorBytes = result.error === undefined
      ? new Uint8Array()
      : encoder.encode(result.error);
    current.errorBytes = errorBytes.length <= MAX_ERROR_CHUNK_BYTES
      ? errorBytes
      : errorBytes.slice(0, MAX_ERROR_CHUNK_BYTES);
    current.errorOffset = 0;
    current.state = 3;
    const resolve = current.resolveRun;
    current.resolveRun = undefined;
    resolve?.(stateMetadata(current));
  };

  const abortActive = (current: RequestState) => {
    timers.clearTimeout(current.timer);
    current.worker?.terminate();
    current.worker = undefined;
    restore(current);
    request = undefined;
    if (current.resolveRun) {
      const resolve = current.resolveRun;
      current.resolveRun = undefined;
      resolve({ state: 3, status: 126, error_len: 0 });
    }
  };

  return async (message: ChildProcessMessage): Promise<unknown> => {
    const { args } = message;
    if (message.name === "childProcessStart") {
      if (request) {
        throw new RangeError("A child process request is already active");
      }
      if (nextRequestId > 0xffff_ffff) {
        throw new RangeError("child process request IDs exhausted");
      }
      const expectedModuleBytes = u32Arg(args, "module_len");
      if (expectedModuleBytes > MAX_MODULE_BYTES) {
        throw new RangeError("child module exceeds 16 MiB");
      }
      const decodedArgs = decodeList(args.argv, "argv");
      const decodedEnv = decodeList(args.env, "env");
      const baseline = snapshotFilesystem(options.filesystemRoot);
      const id = nextRequestId++;
      const current: RequestState = {
        id,
        state: 1,
        args: decodedArgs,
        env: decodedEnv,
        expectedModuleBytes,
        module: new Uint8Array(expectedModuleBytes),
        uploadedModuleBytes: 0,
        baseline,
        timer: 0,
        errorOffset: 0,
      };
      request = current;
      refreshUploadTimer(current);
      return { request_id: id, ...stateMetadata(current) };
    }

    if (message.name === "childProcessWrite") {
      const current = requestFor(args);
      if (current.state !== 1) {
        throw new Error("child process is not uploading");
      }
      try {
        const chunk = byteArray(
          args.chunk,
          "module chunk",
          MAX_MODULE_CHUNK_BYTES,
          "256 KiB",
        );
        if (chunk.length === 0) {
          throw new RangeError("child module chunk must not be empty");
        }
        if (
          chunk.length >
            current.expectedModuleBytes - current.uploadedModuleBytes
        ) {
          throw new RangeError("child module upload exceeds declared length");
        }
        current.module.set(chunk, current.uploadedModuleBytes);
        current.uploadedModuleBytes += chunk.length;
        refreshUploadTimer(current);
        return { request_id: current.id, ...stateMetadata(current) };
      } catch (error) {
        abortActive(current);
        throw error;
      }
    }

    if (message.name === "childProcessRun") {
      const current = requestFor(args);
      if (current.state !== 1) {
        throw new Error("child process is not uploading");
      }
      if (current.uploadedModuleBytes !== current.expectedModuleBytes) {
        const error = new RangeError(
          "child module uploaded length does not match declaration",
        );
        abortActive(current);
        throw error;
      }
      timers.clearTimeout(current.timer);
      const module = current.module;
      current.module = new Uint8Array();
      current.state = 2;
      const runResult = new Promise<StateMetadata>((resolve) => {
        current.resolveRun = resolve;
      });
      try {
        const worker = createWorker(options.workerUrl, { type: "module" });
        current.worker = worker;
        worker.onmessage = (event) => {
          try {
            complete(current, normalizeWorkerResult(event.data));
          } catch (error) {
            complete(current, {
              status: 126,
              error: String(error),
              graceful: false,
            });
          }
        };
        worker.onerror = (event) => {
          event.preventDefault?.();
          complete(current, {
            status: 126,
            error: event.message || "child Worker failed",
            graceful: false,
          });
        };
        worker.onmessageerror = () => {
          complete(current, {
            status: 126,
            error: "child Worker returned an unreadable message",
            graceful: false,
          });
        };
        current.timer = timers.setTimeout(() => {
          complete(current, {
            status: 124,
            error: `child execution exceeded ${options.executionTimeoutMs} ms`,
            graceful: false,
          });
        }, options.executionTimeoutMs);
        worker.postMessage(
          {
            module: module.buffer,
            wasiRef: options.getWasiRef(),
            args: current.args,
            env: current.env,
          },
          [module.buffer],
        );
      } catch (error) {
        complete(current, {
          status: 126,
          error: String(error),
          graceful: false,
        });
      }
      return await runResult;
    }

    if (message.name === "childProcessReadError") {
      const current = requestFor(args);
      if (current.state !== 3 || !current.errorBytes) {
        throw new Error("child process has no completed error result");
      }
      const chunkLength = u32Arg(args, "chunk_len");
      if (chunkLength > MAX_ERROR_CHUNK_BYTES) {
        throw new RangeError("child error chunk exceeds 64 KiB");
      }
      const remaining = current.errorBytes.length - current.errorOffset;
      if (chunkLength > remaining) {
        throw new RangeError("child error chunk exceeds remaining bytes");
      }
      const start = current.errorOffset;
      current.errorOffset += chunkLength;
      return {
        chunk: Array.from(
          current.errorBytes.subarray(start, current.errorOffset),
        ),
      };
    }

    if (message.name === "childProcessRecover") {
      if (!request) return { request_id: 0, state: 0, status: 0, error_len: 0 };
      const current = request;
      const recovered = { request_id: current.id, ...stateMetadata(current) };
      if (current.state !== 3) {
        abortActive(current);
      }
      return recovered;
    }

    if (message.name === "childProcessEnd") {
      const id = u32Arg(args, "request_id");
      if (!request) return {};
      if (request.id !== id) {
        throw new Error(`Unknown child process request ID: ${id}`);
      }
      const current = request;
      if (current.state === 3) {
        timers.clearTimeout(current.timer);
        current.worker?.terminate();
        request = undefined;
      } else {
        abortActive(current);
      }
      return {};
    }

    throw new Error(
      `Unknown child process bridge message: ${
        (message as { name: string }).name
      }`,
    );
  };
}
