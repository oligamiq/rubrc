import { createChildProcessImports } from "../page/src/worker_process/vfs_bindings/child_process_import.ts";

function write(memory: WebAssembly.Memory, offset: number, data: Uint8Array) {
  new Uint8Array(memory.buffer, offset, data.length).set(data);
}

function readU32(memory: WebAssembly.Memory, offset: number) {
  return new DataView(memory.buffer).getUint32(offset, true);
}

Deno.test("child process imports copy only bounded VFS-owned ranges", () => {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const argv = new Uint8Array([91, 34, 0xff, 34, 93]);
  const env = new Uint8Array([65, 61, 0, 66, 61, 0xfe, 0]);
  const moduleChunk = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  write(memory, 32, argv);
  write(memory, 96, env);
  write(memory, 160, moduleChunk);

  const calls: unknown[] = [];
  const imports = createChildProcessImports(
    { memory },
    (_index, message) => {
      calls.push(structuredClone(message));
      const name = (message as { name: string }).name;
      if (name === "childProcessStart") {
        new Uint8Array(memory.buffer).fill(0);
        return { request_id: 7, state: 1, status: 0, error_len: 0 };
      }
      return { request_id: 7, state: 1, status: 0, error_len: 0 };
    },
  );
  const outRequestId = 256;

  if (
    imports.requestStart(
      32,
      argv.length,
      96,
      env.length,
      moduleChunk.length,
      outRequestId,
    ) !== 0
  ) {
    throw new Error("requestStart failed");
  }
  write(memory, 160, moduleChunk);
  if (imports.requestWrite(7, 160, moduleChunk.length) !== 0) {
    throw new Error("requestWrite failed");
  }

  const expectedCalls = [
    {
      name: "childProcessStart",
      args: {
        argv: Array.from(argv),
        env: Array.from(env),
        module_len: moduleChunk.length,
      },
    },
    {
      name: "childProcessWrite",
      args: { request_id: 7, chunk: Array.from(moduleChunk) },
    },
  ];
  if (JSON.stringify(calls) !== JSON.stringify(expectedCalls)) {
    throw new Error(`unexpected copied calls: ${JSON.stringify(calls)}`);
  }
  if (readU32(memory, outRequestId) !== 7) {
    throw new Error(`unexpected request ID: ${readU32(memory, outRequestId)}`);
  }
});

Deno.test("child process imports reject invalid ranges and request IDs", () => {
  const memory = new WebAssembly.Memory({ initial: 8 });
  let calls = 0;
  const imports = createChildProcessImports({ memory }, () => {
    calls++;
    return { request_id: 1, state: 1, status: 0, error_len: 0 };
  });
  const outRequestId = 16;

  const invalidStarts = [
    [-1, 0],
    [memory.buffer.byteLength, 1],
    [memory.buffer.byteLength - 1, 2],
    [0xffff_ffff, 2],
  ] as const;
  for (const [pointer, length] of invalidStarts) {
    if (imports.requestStart(pointer, length, 0, 0, 0, outRequestId) === 0) {
      throw new Error(`invalid start range ${pointer}:${length} succeeded`);
    }
  }
  for (const requestId of [0, -1, 0x1_0000_0000, 1.5]) {
    if (imports.requestWrite(requestId, 0, 0) === 0) {
      throw new Error(`invalid request ID ${requestId} succeeded`);
    }
    if (imports.requestRun(requestId, 32, 36) === 0) {
      throw new Error(`invalid request ID ${requestId} ran`);
    }
    if (imports.requestEnd(requestId) === 0) {
      throw new Error(`invalid request ID ${requestId} ended`);
    }
  }
  if (calls !== 0) throw new Error(`invalid inputs called host ${calls} times`);
});

Deno.test("child process module writes enforce the 256 KiB bound", () => {
  const memory = new WebAssembly.Memory({ initial: 8 });
  let calls = 0;
  const imports = createChildProcessImports({ memory }, () => {
    calls++;
    return { request_id: 9, state: 1, status: 0, error_len: 0 };
  });

  if (imports.requestWrite(9, 0, 256 * 1024 + 1) === 0) {
    throw new Error("oversized module chunk succeeded");
  }
  if (calls !== 0) throw new Error("oversized module chunk reached host");
});

Deno.test("child process error reads reject oversized, sparse, and short chunks", () => {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const chunks: unknown[] = [new Array(4), [1, 2, 3]];
  let calls = 0;
  const imports = createChildProcessImports({ memory }, () => {
    calls++;
    return { chunk: chunks.shift() };
  });

  if (imports.requestReadError(4, 0, 64 * 1024 + 1) === 0) {
    throw new Error("oversized error read succeeded");
  }
  if (calls !== 0) throw new Error("oversized error read reached host");
  if (imports.requestReadError(4, 64, 4) === 0) {
    throw new Error("sparse error chunk succeeded");
  }
  if (imports.requestReadError(4, 64, 4) === 0) {
    throw new Error("short error chunk succeeded");
  }
  if (
    Array.from(new Uint8Array(memory.buffer, 64, 4)).some((byte) => byte !== 0)
  ) {
    throw new Error("rejected error chunk mutated memory");
  }
});

Deno.test("child process imports reject malformed byte and scalar responses", () => {
  const malformedChunks: unknown[] = [
    [1, Number.NaN],
    { 0: 1, 2: 3 },
  ];
  for (const chunk of malformedChunks) {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = createChildProcessImports({ memory }, () => ({ chunk }));
    if (imports.requestReadError(2, 32, 2) === 0) {
      throw new Error(`malformed chunk succeeded: ${JSON.stringify(chunk)}`);
    }
  }

  const memory = new WebAssembly.Memory({ initial: 1 });
  const before = [41, 42];
  const pointers = [32, 36] as const;
  const view = new DataView(memory.buffer);
  pointers.forEach((pointer, index) =>
    view.setUint32(pointer, before[index], true)
  );
  const imports = createChildProcessImports({ memory }, () => ({
    state: 3,
    status: -1,
    error_len: 0,
  }));
  if (imports.requestRun(2, ...pointers) === 0) {
    throw new Error("malformed scalar metadata succeeded");
  }
  const after = pointers.map((pointer) => readU32(memory, pointer));
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`malformed response partially wrote metadata: ${after}`);
  }
});

Deno.test("child process imports reject lifecycle state 4 before writing metadata", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const metadataPointers = [32, 36, 40, 44] as const;
  const metadataBefore = [101, 102, 103, 104];
  const view = new DataView(memory.buffer);
  metadataPointers.forEach((pointer, index) =>
    view.setUint32(pointer, metadataBefore[index], true)
  );
  const calls: unknown[] = [];
  const imports = createChildProcessImports({ memory }, (_index, message) => {
    calls.push(structuredClone(message));
    const name = (message as { name: string }).name;
    if (name === "childProcessRun") {
      return { state: 4, status: 9, error_len: 3 };
    }
    if (name === "childProcessRecover") {
      return { request_id: 8, state: 4, status: 9, error_len: 3 };
    }
    return { request_id: 8, state: 4, status: 0, error_len: 0 };
  });

  if (imports.requestStart(0, 0, 0, 0, 0, metadataPointers[0]) === 0) {
    throw new Error("start accepted lifecycle state 4");
  }
  if (imports.requestWrite(8, 0, 0) === 0) {
    throw new Error("write accepted lifecycle state 4");
  }
  if (imports.requestRun(8, metadataPointers[1], metadataPointers[2]) === 0) {
    throw new Error("run accepted lifecycle state 4");
  }
  if (imports.requestRecover(...metadataPointers) === 0) {
    throw new Error("recover accepted lifecycle state 4");
  }

  const metadataAfter = metadataPointers.map((pointer) =>
    readU32(memory, pointer)
  );
  if (JSON.stringify(metadataAfter) !== JSON.stringify(metadataBefore)) {
    throw new Error(`state 4 partially wrote metadata: ${metadataAfter}`);
  }
  const cleanupCalls = calls.filter((call) =>
    (call as { name: string }).name === "childProcessEnd"
  );
  if (cleanupCalls.length !== 1) {
    throw new Error(
      `invalid start cleanup calls: ${JSON.stringify(cleanupCalls)}`,
    );
  }
});

Deno.test("child process run, recovery, reads, and end use scalar request state", () => {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const calls: unknown[] = [];
  const imports = createChildProcessImports({ memory }, (_index, message) => {
    calls.push(structuredClone(message));
    switch ((message as { name: string }).name) {
      case "childProcessRun":
        return { state: 3, status: 17, error_len: 4 };
      case "childProcessRecover":
        return { request_id: 15, state: 3, status: 17, error_len: 4 };
      case "childProcessReadError":
        return { chunk: new Uint8Array([0xff, 0, 91, 125]) };
      default:
        return {};
    }
  });

  if (imports.requestRun(15, 32, 36) !== 0) throw new Error("run failed");
  if (imports.requestRecover(44, 48, 52, 56) !== 0) {
    throw new Error("recover failed");
  }
  if (imports.requestReadError(15, 64, 4) !== 0) throw new Error("read failed");
  if (imports.requestReadError(15, 68, 0) !== 0) {
    throw new Error("empty read failed");
  }
  if (imports.requestEnd(15) !== 0) throw new Error("end failed");

  if (
    JSON.stringify([readU32(memory, 32), readU32(memory, 36)]) !==
      JSON.stringify([17, 4])
  ) {
    throw new Error("run metadata was not written");
  }
  if (
    JSON.stringify([
      readU32(memory, 44),
      readU32(memory, 48),
      readU32(memory, 52),
      readU32(memory, 56),
    ]) !== JSON.stringify([15, 3, 17, 4])
  ) {
    throw new Error("recovery metadata was not written");
  }
  if (
    JSON.stringify(Array.from(new Uint8Array(memory.buffer, 64, 4))) !==
      JSON.stringify([255, 0, 91, 125])
  ) {
    throw new Error("runner error bytes were corrupted");
  }
  const expectedNames = [
    "childProcessRun",
    "childProcessRecover",
    "childProcessReadError",
    "childProcessEnd",
  ];
  const names = calls.map((call) => (call as { name: string }).name);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(`unexpected lifecycle calls: ${JSON.stringify(calls)}`);
  }
});

Deno.test("child process start cleans retained state after atomic metadata failure", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const pointer = 64;
  const view = new DataView(memory.buffer);
  view.setUint32(pointer, 100, true);
  const calls: unknown[] = [];
  const imports = createChildProcessImports({ memory }, (_index, message) => {
    calls.push(structuredClone(message));
    return { request_id: 23, state: 1, status: 0, error_len: 0 };
  });

  if (
    imports.requestStart(0, 0, 0, 0, 0, 70000) === 0
  ) {
    throw new Error("invalid metadata pointer succeeded");
  }
  if (readU32(memory, pointer) !== 100) {
    throw new Error(
      `request ID was unexpectedly written: ${readU32(memory, pointer)}`,
    );
  }
  const expectedCalls = [
    {
      name: "childProcessStart",
      args: { argv: [], env: [], module_len: 0 },
    },
    { name: "childProcessEnd", args: { request_id: 23 } },
  ];
  if (JSON.stringify(calls) !== JSON.stringify(expectedCalls)) {
    throw new Error(`cleanup was not exact: ${JSON.stringify(calls)}`);
  }
});

Deno.test("both VFS WIT worlds declare the exact same scalar child-process resource", async () => {
  const primary = await Deno.readTextFile(
    new URL("../crates/vfs/wit/vfs-host.wit", import.meta.url),
  );
  const twice = await Deno.readTextFile(
    new URL("../crates/vfs-rustc-twice/wit/vfs-host.wit", import.meta.url),
  );
  const resourcePattern = /\n  resource child-process \{[\s\S]*?\n  \}/;
  const primaryResource = primary.match(resourcePattern)?.[0];
  const twiceResource = twice.match(resourcePattern)?.[0];
  if (!primaryResource) {
    throw new Error("primary VFS WIT is missing resource child-process");
  }
  if (primaryResource !== twiceResource) {
    throw new Error("child-process WIT resources differ");
  }
  if (/\blist\s*</.test(primaryResource)) {
    throw new Error("WIT lists are prohibited");
  }
});
