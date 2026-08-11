export type HostCommandRequest = {
  args: string[];
  envs?: Record<string, string>;
  cwd?: string;
};

export type HostCommandResult = {
  stdout: unknown;
  stderr: unknown;
  status: number;
  stdoutPtr: number;
  stderrPtr: number;
};

export type ScratchOffsets = {
  stdoutPtr: number;
  stderrPtr: number;
};

export class ScratchAllocator {
  #next: number;
  readonly #end: number;

  constructor(start: number, end: number) {
    assertUnsignedInteger(start, "scratch start");
    assertUnsignedInteger(end, "scratch end");
    if (start > end) throw new Error("scratch start is after scratch end");
    this.#next = align(start, 8);
    this.#end = end;
  }

  allocate(stdoutLength: number, stderrLength: number): ScratchOffsets {
    assertUnsignedInteger(stdoutLength, "stdout length");
    assertUnsignedInteger(stderrLength, "stderr length");
    const stdoutPtr = align(this.#next, 8);
    const stderrPtr = checkedAdd(stdoutPtr, stdoutLength, "scratch allocation");
    const outputEnd = checkedAdd(stderrPtr, stderrLength, "scratch allocation");
    const next = align(Math.max(outputEnd, stdoutPtr + 1), 8);
    if (next > this.#end) {
      throw new Error(
        `scratch exhausted: need ${next - stdoutPtr} bytes, have ${
          this.#end - stdoutPtr
        }`,
      );
    }
    this.#next = next;
    return { stdoutPtr, stderrPtr };
  }
}

export function createHostRunCargoImport(
  memory: WebAssembly.Memory,
  invoke: (request: HostCommandRequest) => unknown,
): (
  reqPtr: number,
  reqLen: number,
  outStdoutPtr: number,
  outStdoutLen: number,
  outStderrPtr: number,
  outStderrLen: number,
  outStatus: number,
) => number {
  return (
    reqPtr,
    reqLen,
    outStdoutPtr,
    outStdoutLen,
    outStderrPtr,
    outStderrLen,
    outStatus,
  ) => {
    const requestRange = checkedRange(memory, reqPtr, reqLen, "request");
    const request = parseHostCommandRequest(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          new Uint8Array(memory.buffer, requestRange.ptr, requestRange.length),
        ),
      ),
    );
    const response = parseResult(invoke(request));
    const stdout = toUint8Array(response.stdout, "stdout");
    const stderr = toUint8Array(response.stderr, "stderr");
    const stdoutRange = checkedRange(
      memory,
      response.stdoutPtr,
      stdout.byteLength,
      "stdout scratch",
    );
    const stderrRange = checkedRange(
      memory,
      response.stderrPtr,
      stderr.byteLength,
      "stderr scratch",
    );
    const memoryBytes = new Uint8Array(memory.buffer);
    memoryBytes.set(stdout, stdoutRange.ptr);
    memoryBytes.set(stderr, stderrRange.ptr);

    const fields = new DataView(memory.buffer);
    writeUint32(
      fields,
      memory,
      outStdoutPtr,
      stdoutRange.ptr,
      "stdout pointer",
    );
    writeUint32(
      fields,
      memory,
      outStdoutLen,
      stdout.byteLength,
      "stdout length",
    );
    writeUint32(
      fields,
      memory,
      outStderrPtr,
      stderrRange.ptr,
      "stderr pointer",
    );
    writeUint32(
      fields,
      memory,
      outStderrLen,
      stderr.byteLength,
      "stderr length",
    );
    writeInt32(fields, memory, outStatus, response.status, "status");
    return 0;
  };
}

export function parseHostCommandRequest(value: unknown): HostCommandRequest {
  if (!isRecord(value) || !Array.isArray(value.args)) {
    throw new Error("host command request must contain an args array");
  }
  if (!value.args.every((arg) => typeof arg === "string")) {
    throw new Error("host command args must contain only strings");
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw new Error("host command cwd must be a string");
  }
  let envs: Record<string, string> | undefined;
  if (value.envs !== undefined) {
    if (!isRecord(value.envs)) {
      throw new Error("host command envs must be an object");
    }
    envs = Object.create(null) as Record<string, string>;
    for (const [name, envValue] of Object.entries(value.envs)) {
      if (typeof envValue !== "string") {
        throw new Error(`host command env ${name} must be a string`);
      }
      envs[name] = envValue;
    }
  }
  return {
    args: value.args,
    ...(envs ? { envs } : {}),
    ...(value.cwd ? { cwd: value.cwd } : {}),
  };
}

function parseResult(value: unknown): HostCommandResult {
  if (!isRecord(value)) {
    throw new Error("host command response must be an object");
  }
  const status = value.status;
  const stdoutPtr = value.stdoutPtr;
  const stderrPtr = value.stderrPtr;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < -2_147_483_648 ||
    status > 2_147_483_647
  ) {
    throw new Error("host command status must be an i32");
  }
  assertUnsignedInteger(stdoutPtr, "stdout scratch pointer");
  assertUnsignedInteger(stderrPtr, "stderr scratch pointer");
  return {
    stdout: value.stdout,
    stderr: value.stderr,
    status,
    stdoutPtr,
    stderrPtr,
  } as HostCommandResult;
}

function toUint8Array(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const values = Array.isArray(value)
    ? value
    : isRecord(value)
    ? Object.values(value)
    : undefined;
  if (
    values === undefined ||
    !values.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new Error(`${label} must contain bytes`);
  }
  return new Uint8Array(values as number[]);
}

function checkedRange(
  memory: WebAssembly.Memory,
  rawPtr: number,
  rawLength: number,
  label: string,
): { ptr: number; length: number } {
  const ptr = rawPtr >>> 0;
  const length = rawLength >>> 0;
  const end = ptr + length;
  if (end > memory.buffer.byteLength || end < ptr) {
    throw new Error(`${label} is outside memory bounds`);
  }
  return { ptr, length };
}

function writeUint32(
  fields: DataView,
  memory: WebAssembly.Memory,
  rawPtr: number,
  value: number,
  label: string,
): void {
  const ptr = checkedFieldPointer(memory, rawPtr, label);
  fields.setUint32(ptr, value, true);
}

function writeInt32(
  fields: DataView,
  memory: WebAssembly.Memory,
  rawPtr: number,
  value: number,
  label: string,
): void {
  const ptr = checkedFieldPointer(memory, rawPtr, label);
  fields.setInt32(ptr, value, true);
}

function checkedFieldPointer(
  memory: WebAssembly.Memory,
  rawPtr: number,
  label: string,
): number {
  const ptr = rawPtr >>> 0;
  if (ptr % 4 !== 0) throw new Error(`${label} is not i32-aligned`);
  checkedRange(memory, ptr, 4, label);
  return ptr;
}

function assertUnsignedInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (
    !Number.isInteger(value) || (value as number) < 0 ||
    (value as number) > 0xffff_ffff
  ) {
    throw new Error(`${label} must be a u32`);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > 0xffff_ffff) {
    throw new Error(`${label} overflow`);
  }
  return result;
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

if (Deno.mainModule === import.meta.url) {
  Deno.test("host_run_cargo decodes requests and writes command results", () => {
    const memory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const request = {
      args: ["rustc", "--print", "cfg"],
      envs: { RUSTUP_TOOLCHAIN: "/sysroot" },
      cwd: "/workspace",
    };
    const requestBytes = new TextEncoder().encode(JSON.stringify(request));
    new Uint8Array(memory.buffer).set(requestBytes, 1024);
    let received: HostCommandRequest | undefined;
    const hostRunCargo = createHostRunCargoImport(memory, (value) => {
      received = value;
      return {
        stdout: { 0: 111, 1: 107 },
        stderr: [101, 114, 114],
        status: 7,
        stdoutPtr: 65_536,
        stderrPtr: 65_544,
      };
    });

    const ret = hostRunCargo(
      1024,
      requestBytes.byteLength,
      64,
      68,
      72,
      76,
      80,
    );

    assertEquals(received, request, "decoded request");
    assertEquals(ret, 0, "ABI return code");
    assertEquals(
      Array.from(new Uint8Array(memory.buffer, 65_536, 2)),
      [111, 107],
      "stdout bytes",
    );
    assertEquals(
      Array.from(new Uint8Array(memory.buffer, 65_544, 3)),
      [101, 114, 114],
      "stderr bytes",
    );
    const fields = new DataView(memory.buffer);
    assertEquals(fields.getUint32(64, true), 65_536, "stdout pointer");
    assertEquals(fields.getUint32(68, true), 2, "stdout length");
    assertEquals(fields.getUint32(72, true), 65_544, "stderr pointer");
    assertEquals(fields.getUint32(76, true), 3, "stderr length");
    assertEquals(fields.getInt32(80, true), 7, "status");
  });

  Deno.test("host_run_cargo rejects out-of-bounds request memory", () => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const hostRunCargo = createHostRunCargoImport(memory, () => {
      throw new Error("callback must not run");
    });

    let error: unknown;
    try {
      hostRunCargo(65_535, 2, 4, 8, 12, 16, 20);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error, "invalid request must throw");
    assert(
      error.message.includes("request") && error.message.includes("bounds"),
      `unexpected error: ${error.message}`,
    );
  });

  Deno.test("scratch allocations are unique and fail on exhaustion", () => {
    const allocator = new ScratchAllocator(64, 80);

    assertEquals(
      allocator.allocate(3, 2),
      { stdoutPtr: 64, stderrPtr: 67 },
      "first allocation",
    );
    assertEquals(
      allocator.allocate(4, 0),
      { stdoutPtr: 72, stderrPtr: 76 },
      "second allocation",
    );

    let error: unknown;
    try {
      allocator.allocate(1, 0);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error, "scratch exhaustion must throw");
    assert(
      error.message.includes("exhausted"),
      `unexpected error: ${error.message}`,
    );
  });
}
