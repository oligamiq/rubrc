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

export interface ChildProcessStateMetadata {
  state: number;
  status: number;
  error_len: number;
}

export interface ChildProcessRequestMetadata
  extends ChildProcessStateMetadata {
  request_id: number;
}

export interface ChildProcessErrorChunk {
  chunk: number[];
}

export type ChildProcessBridgeResponse =
  | ChildProcessRequestMetadata
  | ChildProcessStateMetadata
  | ChildProcessErrorChunk
  | Record<string, never>
  | undefined;

export interface ChildProcessBridge {
  (
    message: ChildProcessMessage & {
      name: "childProcessStart" | "childProcessWrite" | "childProcessRecover";
    },
  ): Promise<ChildProcessRequestMetadata>;
  (
    message: ChildProcessMessage & { name: "childProcessRun" },
  ): Promise<ChildProcessStateMetadata>;
  (
    message: ChildProcessMessage & { name: "childProcessReadError" },
  ): Promise<ChildProcessErrorChunk>;
  (
    message: ChildProcessMessage & { name: "childProcessEnd" },
  ): Promise<Record<string, never> | undefined>;
  (message: ChildProcessMessage): Promise<ChildProcessBridgeResponse>;
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
  signal?: AbortSignal;
}

export interface ChildProcessBridgeOwner {
  handle: ChildProcessBridge;
  abort(reason?: unknown): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
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
  timer?: TimerHandle;
  worker?: ChildWorker;
  result?: WorkerResult;
  errorBytes?: Uint8Array;
  errorOffset: number;
  resolveRun?: (metadata: StateMetadata) => void;
  rejectRun?: (reason: unknown) => void;
  recovery?: StateMetadata;
  restored?: boolean;
  restoreRequired?: boolean;
  workerSetup?: boolean;
  workerTerminated?: boolean;
}

type StateMetadata = ChildProcessStateMetadata;

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    try {
      if (typeof error.message === "string") return error.message;
    } catch {
      // Fall through to guarded string conversion.
    }
  }
  try {
    return String(error);
  } catch {
    return "Unknown child process error";
  }
}

export function createChildProcessBridgeOwner(
  options: ChildProcessBridgeOptions,
): ChildProcessBridgeOwner {
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
  const active = new Set<Promise<unknown>>();
  const childRequests = new Map<number, RequestState>();
  const controller = new AbortController();
  let request: RequestState | undefined;
  let nextRequestId = 1;
  let disposePromise: Promise<void> | undefined;

  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    void operation.catch(() => undefined).finally(() => active.delete(operation));
    return operation;
  };

  const settle = async () => {
    await Promise.allSettled([...active]);
  };

  const requestFor = (args: Record<string, unknown>) => {
    const id = u32Arg(args, "request_id");
    if (!request || request.id !== id) {
      throw new Error(`Unknown or ended child process request ID: ${id}`);
    }
    return request;
  };

  const restore = (current: RequestState) => {
    current.restoreRequired = true;
    if (current.restored) return;
    restoreFilesystem(options.filesystemRoot, current.baseline);
    current.restored = true;
  };

  const attemptCleanup = (
    errors: unknown[],
    cleanup: () => void,
  ): boolean => {
    try {
      cleanup();
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  };

  const reportCleanupErrors = (errors: unknown[]) => {
    if (errors.length === 0) return;
    try {
      console.error(
        "child process cleanup failed",
        new AggregateError(errors, "child process cleanup failed"),
      );
    } catch {
      // Reporting must not interrupt the primary abort or setup outcome.
    }
  };

  const clearTimer = (current: RequestState) => {
    if (current.timer === undefined) return;
    const timer = current.timer;
    timers.clearTimeout(timer);
    current.timer = undefined;
  };

  const cleanupResources = (
    current: RequestState,
    errors: unknown[],
    acquiredWorker?: ChildWorker,
  ) => {
    if (acquiredWorker) current.worker = acquiredWorker;
    attemptCleanup(errors, () => clearTimer(current));

    const worker = current.worker;
    if (!worker) return;
    let listenersCleared = true;
    listenersCleared = attemptCleanup(errors, () => worker.onmessage = null) &&
      listenersCleared;
    listenersCleared = attemptCleanup(errors, () => worker.onerror = null) &&
      listenersCleared;
    listenersCleared = attemptCleanup(
      errors,
      () => worker.onmessageerror = null,
    ) && listenersCleared;
    if (!current.workerTerminated) {
      current.workerTerminated = attemptCleanup(
        errors,
        () => worker.terminate(),
      );
    }
    if (
      listenersCleared && current.workerTerminated && !current.workerSetup
    ) {
      current.worker = undefined;
    }
  };

  const cleanupComplete = (current: RequestState) => {
    return current.timer === undefined && current.worker === undefined &&
      (!current.restoreRequired || current.restored);
  };

  const finalizeTerminalRequest = (
    current: RequestState,
    acquiredWorker?: ChildWorker,
  ) => {
    const errors: unknown[] = [];
    cleanupResources(current, errors, acquiredWorker);
    if (current.restoreRequired && !current.restored) {
      attemptCleanup(errors, () => restore(current));
    }
    if (cleanupComplete(current)) childRequests.delete(current.id);
    reportCleanupErrors(errors);
  };

  const finishWorkerSetup = (
    current: RequestState,
    worker: ChildWorker,
    setupSucceeded: boolean,
  ) => {
    current.workerSetup = false;
    if (current.state === 3) {
      finalizeTerminalRequest(current, worker);
      return;
    }
    if (setupSucceeded) return;
    const errors: unknown[] = [];
    cleanupResources(current, errors, worker);
    if (cleanupComplete(current) && request !== current) {
      childRequests.delete(current.id);
    }
    reportCleanupErrors(errors);
  };

  const abortRequest = (
    current: RequestState,
    reason: unknown,
    acquiredWorker?: ChildWorker,
  ) => {
    if (current.state === 3) {
      finalizeTerminalRequest(current, acquiredWorker);
      return;
    }
    const errors: unknown[] = [];
    cleanupResources(current, errors, acquiredWorker);
    attemptCleanup(errors, () => restore(current));
    if (request === current) request = undefined;
    const reject = current.rejectRun;
    current.resolveRun = undefined;
    current.rejectRun = undefined;
    if (reject) attemptCleanup(errors, () => reject(reason));
    if (!reject && cleanupComplete(current)) childRequests.delete(current.id);
    reportCleanupErrors(errors);
  };

  const throwIfAborted = (
    current: RequestState,
    acquiredWorker?: ChildWorker,
  ) => {
    if (!controller.signal.aborted) return;
    abortRequest(current, controller.signal.reason, acquiredWorker);
    if (current.state === 3) return;
    throw controller.signal.reason;
  };

  const abort = (
    reason: unknown = new DOMException("runtime disposed", "AbortError"),
  ) => {
    if (!controller.signal.aborted) controller.abort(reason);
    const primary = controller.signal.reason;
    for (const current of childRequests.values()) {
      abortRequest(current, primary);
    }
  };

  const abortFromSignal = () => abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", abortFromSignal, { once: true });
  }

  const refreshUploadTimer = (current: RequestState) => {
    try {
      clearTimer(current);
      throwIfAborted(current);
      const timer = timers.setTimeout(() => {
        current.timer = undefined;
        if (
          request !== current || current.state !== 1 || current.recovery
        ) return;
        const errors: unknown[] = [];
        attemptCleanup(errors, () => restore(current));
        request = undefined;
        if (cleanupComplete(current)) childRequests.delete(current.id);
        reportCleanupErrors(errors);
      }, options.uploadTimeoutMs);
      current.timer = timer;
      throwIfAborted(current);
    } catch (error) {
      abortRequest(
        current,
        controller.signal.aborted ? controller.signal.reason : error,
      );
      throw controller.signal.aborted ? controller.signal.reason : error;
    }
  };

  const complete = (current: RequestState, result: WorkerResult) => {
    if (request !== current || current.state !== 2 || current.recovery) return;
    const errors: unknown[] = [];
    cleanupResources(current, errors);
    if (!result.graceful) attemptCleanup(errors, () => restore(current));
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
    current.rejectRun = undefined;
    if (resolve) {
      attemptCleanup(errors, () => resolve(stateMetadata(current)));
    }
    reportCleanupErrors(errors);
  };

  const abortActive = (current: RequestState) => {
    const errors: unknown[] = [];
    cleanupResources(current, errors);
    attemptCleanup(errors, () => restore(current));
    request = undefined;
    const resolve = current.resolveRun;
    current.resolveRun = undefined;
    current.rejectRun = undefined;
    if (resolve) {
      attemptCleanup(
        errors,
        () => resolve({ state: 3, status: 126, error_len: 0 }),
      );
    }
    if (!resolve && cleanupComplete(current)) childRequests.delete(current.id);
    reportCleanupErrors(errors);
  };

  const retainActiveRecovery = (current: RequestState) => {
    if (current.recovery) return;
    current.recovery = stateMetadata(current);
    const errors: unknown[] = [];
    cleanupResources(current, errors);
    attemptCleanup(errors, () => restore(current));
    const resolve = current.resolveRun;
    current.resolveRun = undefined;
    current.rejectRun = undefined;
    if (resolve) {
      attemptCleanup(
        errors,
        () => resolve({ state: 3, status: 126, error_len: 0 }),
      );
    }
    if (!resolve && cleanupComplete(current)) childRequests.delete(current.id);
    reportCleanupErrors(errors);
  };

  const dispatch = async (
    message: ChildProcessMessage,
  ): Promise<ChildProcessBridgeResponse> => {
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
        errorOffset: 0,
      };
      request = current;
      childRequests.set(id, current);
      refreshUploadTimer(current);
      return { request_id: id, ...stateMetadata(current) };
    }

    if (message.name === "childProcessWrite") {
      const current = requestFor(args);
      if (current.state !== 1 || current.recovery) {
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
      if (current.state !== 1 || current.recovery) {
        throw new Error("child process is not uploading");
      }
      if (current.uploadedModuleBytes !== current.expectedModuleBytes) {
        const error = new RangeError(
          "child module uploaded length does not match declaration",
        );
        abortActive(current);
        throw error;
      }
      clearTimer(current);
      throwIfAborted(current);
      const module = current.module;
      current.module = new Uint8Array();
      current.state = 2;
      const runResult = new Promise<StateMetadata>((resolve, reject) => {
        current.resolveRun = resolve;
        current.rejectRun = reject;
      });
      void runResult.catch(() => undefined);
      let acquiredWorker: ChildWorker | undefined;
      let setupSucceeded = false;
      try {
        const worker = createWorker(options.workerUrl, { type: "module" });
        acquiredWorker = worker;
        current.worker = worker;
        current.workerSetup = true;
        current.workerTerminated = false;
        throwIfAborted(current, worker);
        worker.onmessage = (event) => {
          try {
            complete(current, normalizeWorkerResult(event.data));
          } catch (error) {
            complete(current, {
              status: 126,
              error: errorMessage(error),
              graceful: false,
            });
          }
        };
        throwIfAborted(current, worker);
        worker.onerror = (event) => {
          event.preventDefault?.();
          complete(current, {
            status: 126,
            error: event.message || "child Worker failed",
            graceful: false,
          });
        };
        throwIfAborted(current, worker);
        worker.onmessageerror = () => {
          complete(current, {
            status: 126,
            error: "child Worker returned an unreadable message",
            graceful: false,
          });
        };
        throwIfAborted(current, worker);
        const timer = timers.setTimeout(() => {
          current.timer = undefined;
          complete(current, {
            status: 124,
            error: `child execution exceeded ${options.executionTimeoutMs} ms`,
            graceful: false,
          });
        }, options.executionTimeoutMs);
        current.timer = timer;
        throwIfAborted(current, worker);
        const wasiRef = options.getWasiRef();
        throwIfAborted(current, worker);
        worker.postMessage(
          {
            module: module.buffer,
            wasiRef,
            args: current.args,
            env: current.env,
          },
          [module.buffer],
        );
        throwIfAborted(current, worker);
        setupSucceeded = true;
      } catch (error) {
        if ((current.state as number) === 3) {
          finalizeTerminalRequest(current, acquiredWorker);
        } else if (controller.signal.aborted) {
          abortRequest(current, controller.signal.reason, acquiredWorker);
        } else {
          abortRequest(current, error, acquiredWorker);
        }
      } finally {
        if (acquiredWorker) {
          finishWorkerSetup(current, acquiredWorker, setupSucceeded);
        } else {
          current.workerSetup = false;
        }
      }
      try {
        return await runResult;
      } finally {
        if (cleanupComplete(current)) childRequests.delete(current.id);
      }
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
      if (!current.recovery && current.state !== 3) {
        retainActiveRecovery(current);
      }
      return {
        request_id: current.id,
        ...(current.recovery ?? stateMetadata(current)),
      };
    }

    if (message.name === "childProcessEnd") {
      const id = u32Arg(args, "request_id");
      if (!request) return {};
      if (request.id !== id) {
        throw new Error(`Unknown child process request ID: ${id}`);
      }
      const current = request;
      if (current.recovery) {
        request = undefined;
      } else if (current.state === 3) {
        const errors: unknown[] = [];
        cleanupResources(current, errors);
        request = undefined;
        if (cleanupComplete(current)) childRequests.delete(current.id);
        reportCleanupErrors(errors);
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

  const handle = ((message: ChildProcessMessage) => {
    controller.signal.throwIfAborted();
    return track(dispatch(message));
  }) as ChildProcessBridge;

  const dispose = () => {
    if (!disposePromise) {
      disposePromise = (async () => {
        abort();
        await settle();
        abort();
        options.signal?.removeEventListener("abort", abortFromSignal);
        for (const [id, current] of childRequests) {
          if (cleanupComplete(current)) childRequests.delete(id);
        }
        request = undefined;
      })();
    }
    return disposePromise;
  };

  return { handle, abort, settle, dispose };
}

export function createChildProcessBridge(
  options: ChildProcessBridgeOptions,
): ChildProcessBridge {
  return createChildProcessBridgeOwner(options).handle;
}
