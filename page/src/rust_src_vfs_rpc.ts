export const RUST_SRC_MOUNT_PATH = "/sysroot/lib/rustlib/src/rust/library";

const EVENT_TYPE_RUST_SRC_FS_RPC = 10;
const HEADER_LEN = 48;
const OP_STAT = 1;
const OP_READ = 2;
const OP_READDIR = 3;
const STATUS_OK = 0;
const STATUS_INVALID = 1;
const STATUS_NOT_MOUNTED = 2;
const STATUS_ERROR = 3;
const STATUS_BUFFER_TOO_SMALL = 4;
const KIND_FILE = 1;
const KIND_DIRECTORY = 2;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export type RustSrcStat = {
  type: "file" | "directory";
  size: number;
  mtime: number;
};

export type RustSrcFsRequest =
  | { operation: "stat"; path: string }
  | { operation: "readFile"; path: string }
  | { operation: "readdir"; path: string };
export type RustSrcFsResponse =
  | { operation: "stat"; stat: RustSrcStat }
  | { operation: "readFile"; data: Uint8Array }
  | { operation: "readdir"; entries: string[] };

export type RustSrcFsEndpoint = (
  request: RustSrcFsRequest,
) => Promise<RustSrcFsResponse> | RustSrcFsResponse;

export type RustSrcRpcRoot = {
  dispatch(
    sessionId: number,
    eventType: number,
    arg1: number,
    arg2: number,
  ): void;
  allocBuf(len: number): number;
  freeBuf(ptr: number, len: number): void;
};

export class RustSrcVfsError extends Error {
  constructor(readonly code: "Invalid" | "NotMounted" | "NotFound", path: string) {
    super(`${code}: ${path}`);
    this.name = "RustSrcVfsError";
  }
}
type RawResponse = {
  status: number;
  kind: number;
  outputLength: number;
  size: number;
  mtime: number;
  output: Uint8Array;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function checkedOutputLength(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OUTPUT_BYTES) {
    throw new RustSrcVfsError("Invalid", path);
  }
  return value;
}

function rpc(
  root: RustSrcRpcRoot,
  memory: WebAssembly.Memory,
  operation: number,
  path: string,
  offset: number,
  capacity: number,
): RawResponse {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RustSrcVfsError("Invalid", path);
  }
  const outputCapacity = checkedOutputLength(capacity, path);
  const pathBytes = textEncoder.encode(path);
  const totalLength = HEADER_LEN + pathBytes.byteLength + outputCapacity;
  if (!Number.isSafeInteger(totalLength) || totalLength > 0xffff_ffff) {
    throw new RustSrcVfsError("Invalid", path);
  }

  const ptr = root.allocBuf(totalLength);
  try {
    const request = new Uint8Array(memory.buffer, ptr, totalLength);
    const header = new DataView(memory.buffer, ptr, HEADER_LEN);
    header.setUint32(0, operation, true);
    header.setUint32(4, pathBytes.byteLength, true);
    header.setBigUint64(8, BigInt(offset), true);
    header.setUint32(16, outputCapacity, true);
    request.set(pathBytes, HEADER_LEN);

    root.dispatch(0, EVENT_TYPE_RUST_SRC_FS_RPC, ptr, totalLength);
    const responseHeader = new DataView(memory.buffer, ptr, HEADER_LEN);
    const outputLength = checkedOutputLength(
      responseHeader.getUint32(28, true),
      path,
    );
    if (outputLength > outputCapacity) {
      return {
        status: responseHeader.getUint32(20, true),
        kind: responseHeader.getUint32(24, true),
        outputLength,
        size: Number(responseHeader.getBigUint64(32, true)),
        mtime: Number(responseHeader.getBigUint64(40, true)),
        output: new Uint8Array(),
      };
    }
    const outputStart = HEADER_LEN + pathBytes.byteLength;
    const responseBytes = new Uint8Array(memory.buffer, ptr, totalLength);
    return {
      status: responseHeader.getUint32(20, true),
      kind: responseHeader.getUint32(24, true),
      outputLength,
      size: Number(responseHeader.getBigUint64(32, true)),
      mtime: Number(responseHeader.getBigUint64(40, true)),
      output: responseBytes.slice(outputStart, outputStart + outputLength),
    };
  } finally {
    root.freeBuf(ptr, totalLength);
  }
}

function throwStatus(status: number, path: string): never {
  if (status === STATUS_INVALID) throw new RustSrcVfsError("Invalid", path);
  if (status === STATUS_NOT_MOUNTED) throw new RustSrcVfsError("NotMounted", path);
  throw new RustSrcVfsError("NotFound", path);
}
function readStat(
  root: RustSrcRpcRoot,
  memory: WebAssembly.Memory,
  path: string,
): RustSrcStat {
  const response = rpc(root, memory, OP_STAT, path, 0, 0);
  if (response.status !== STATUS_OK) throwStatus(response.status, path);
  if (!Number.isSafeInteger(response.size) || response.size < 0) {
    throw new RustSrcVfsError("Invalid", path);
  }
  if (!Number.isSafeInteger(response.mtime) || response.mtime < 0) {
    throw new RustSrcVfsError("Invalid", path);
  }
  const type = response.kind === KIND_FILE
    ? "file"
    : response.kind === KIND_DIRECTORY
    ? "directory"
    : undefined;
  if (type === undefined) throw new RustSrcVfsError("Invalid", path);
  return { type, size: response.size, mtime: response.mtime };
}

function readFile(
  root: RustSrcRpcRoot,
  memory: WebAssembly.Memory,
  path: string,
): Uint8Array {
  const stat = readStat(root, memory, path);
  if (stat.type !== "file") throw new RustSrcVfsError("Invalid", path);
  const capacity = checkedOutputLength(stat.size, path);
  const response = rpc(root, memory, OP_READ, path, 0, capacity);
  if (response.status !== STATUS_OK) throwStatus(response.status, path);
  if (response.outputLength !== capacity) {
    throw new RustSrcVfsError("Invalid", path);
  }
  return response.output;
}

function readDirectory(
  root: RustSrcRpcRoot,
  memory: WebAssembly.Memory,
  path: string,
): string[] {
  const probe = rpc(root, memory, OP_READDIR, path, 0, 0);
  if (
    probe.status !== STATUS_BUFFER_TOO_SMALL &&
    probe.status !== STATUS_OK
  ) {
    throwStatus(probe.status, path);
  }
  const capacity = checkedOutputLength(probe.outputLength, path);
  const response = capacity === 0
    ? probe
    : rpc(root, memory, OP_READDIR, path, 0, capacity);
  if (response.status !== STATUS_OK) throwStatus(response.status, path);
  if (response.outputLength !== capacity) {
    throw new RustSrcVfsError("Invalid", path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(response.output));
  } catch {
    throw new RustSrcVfsError("Invalid", path);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) =>
      typeof entry !== "string" || entry.length === 0 || entry.includes("/") ||
      entry === "." || entry === ".."
    )
  ) {
    throw new RustSrcVfsError("Invalid", path);
  }
  return parsed as string[];
}

export function createRustSrcFsEndpoint(
  root: RustSrcRpcRoot,
  memory: WebAssembly.Memory,
): (request: RustSrcFsRequest) => RustSrcFsResponse {
  return (request) => {
    if (request.operation === "stat") {
      return { operation: "stat", stat: readStat(root, memory, request.path) };
    }
    if (request.operation === "readFile") {
      return { operation: "readFile", data: readFile(root, memory, request.path) };
    }
    return {
      operation: "readdir",
      entries: readDirectory(root, memory, request.path),
    };
  };
}

export function rustSrcRelativePath(path: string): string | undefined {
  if (path === RUST_SRC_MOUNT_PATH) return "";
  const prefix = `${RUST_SRC_MOUNT_PATH}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}
type ActiveRustSrcEndpoint = {
  generation: string;
  endpoint: RustSrcFsEndpoint;
};

let activeEndpoint: ActiveRustSrcEndpoint | undefined;

export function activateRustSrcFsEndpoint(
  generation: string,
  endpoint: RustSrcFsEndpoint,
): void {
  activeEndpoint = { generation, endpoint };
}

export function clearRustSrcFsEndpoint(generation: string): void {
  if (activeEndpoint?.generation === generation) activeEndpoint = undefined;
}

export function getActiveRustSrcFsEndpoint(): RustSrcFsEndpoint | undefined {
  return activeEndpoint?.endpoint;
}
