import { createHttpImports } from "../page/src/worker_process/vfs_bindings/http_import.ts";

const encoder = new TextEncoder();

function write(memory: WebAssembly.Memory, offset: number, data: Uint8Array) {
  new Uint8Array(memory.buffer, offset, data.length).set(data);
}

function readU32(memory: WebAssembly.Memory, offset: number) {
  return new DataView(memory.buffer).getUint32(offset, true);
}

Deno.test("HTTP imports copy request data and write only scalar response metadata", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const method = encoder.encode("POST");
  const url = encoder.encode("https://example.test/index");
  const headers = encoder.encode("accept: application/octet-stream\nx-test: yes");
  const body = new Uint8Array([0, 255, 17, 128, 42]);
  const inputs = [method, url, headers, body];
  const pointers = [32, 64, 128, 256];
  for (let index = 0; index < inputs.length; index++) {
    write(memory, pointers[index], inputs[index]);
  }

  let request: unknown;
  const Http = createHttpImports({ memory }, (_idx: number, message: unknown) => {
    request = structuredClone(message);
    new Uint8Array(memory.buffer).fill(0);
    return {
      request_id: 73,
      status: 206,
      headers_len: 19,
      body_len: 70000,
      error_len: 0,
    };
  });

  const metadataPointers = [512, 516, 520, 524, 528] as const;
  const result = Http.requestStart(
    pointers[0], method.length,
    pointers[1], url.length,
    pointers[2], headers.length,
    pointers[3], body.length,
    ...metadataPointers,
  );

  if (result !== 0) throw new Error(`requestStart returned ${result}`);
  const expectedRequest = {
    name: "httpRequestStart",
    args: {
      method: Array.from(method),
      url: Array.from(url),
      headers: Array.from(headers),
      body: Array.from(body),
    },
  };
  if (JSON.stringify(request) !== JSON.stringify(expectedRequest)) {
    throw new Error(`unexpected copied request: ${JSON.stringify(request)}`);
  }
  const metadata = metadataPointers.map((pointer) => readU32(memory, pointer));
  if (JSON.stringify(metadata) !== JSON.stringify([73, 206, 19, 70000, 0])) {
    throw new Error(`unexpected metadata: ${JSON.stringify(metadata)}`);
  }
});

Deno.test("HTTP reads are request-scoped, binary-safe, and support 16 KiB", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const calls: unknown[] = [];
  const expectedNames = [
    "httpResponseReadHeaders",
    "httpResponseReadBody",
    "httpResponseReadError",
  ];
  const chunks = [new Uint8Array(16 * 1024), new Uint8Array(16 * 1024), new Uint8Array(16 * 1024)];
  chunks[0].set([104, 58, 32, 118, 10]);
  chunks[1].set([0, 255, 128, 1]);
  chunks[2].set([69, 82, 82]);
  let callIndex = 0;
  const Http = createHttpImports({ memory }, (_idx: number, message: unknown) => {
    calls.push(structuredClone(message));
    return { chunk: Array.from(chunks[callIndex++]) };
  });
  const readers = [
    Http.responseReadHeaders,
    Http.responseReadBody,
    Http.responseReadError,
  ];
  const destinations: number[] = [];

  for (let index = 0; index < readers.length; index++) {
    const destination = 1024 + index * 16 * 1024;
    destinations.push(destination);
    const result = readers[index](91, destination, 16 * 1024);
    if (result !== 0) throw new Error(`${expectedNames[index]} returned ${result}`);
    const actual = new Uint8Array(memory.buffer, destination, chunks[index].length);
    if (JSON.stringify(Array.from(actual)) !== JSON.stringify(Array.from(chunks[index]))) {
      throw new Error(`${expectedNames[index]} did not preserve binary bytes`);
    }
  }

  for (let index = 0; index < destinations.length; index++) {
    const actual = new Uint8Array(memory.buffer, destinations[index], chunks[index].length);
    if (JSON.stringify(Array.from(actual)) !== JSON.stringify(Array.from(chunks[index]))) {
      throw new Error(`${expectedNames[index]} destination was overwritten`);
    }
  }

  for (let index = 0; index < calls.length; index++) {
    const expected = {
      name: expectedNames[index],
      args: { request_id: 91, chunk_len: 16 * 1024 },
    };
    if (JSON.stringify(calls[index]) !== JSON.stringify(expected)) {
      throw new Error(`unexpected read call: ${JSON.stringify(calls[index])}`);
    }
  }
});

Deno.test("HTTP reads reject invalid lengths and treat zero as a no-op", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const destination = 512;
  const bytes = new Uint8Array(memory.buffer, destination, 8);
  bytes.fill(77);
  let calls = 0;
  const Http = createHttpImports({ memory }, () => {
    calls++;
    return { chunk: [] };
  });

  for (const length of [-1, 16 * 1024 + 1]) {
    if (Http.responseReadBody(8, destination, length) === 0) {
      throw new Error(`invalid read length ${length} must fail`);
    }
  }
  if (Http.responseReadBody(8, destination, 0) !== 0) {
    throw new Error("zero-length read must succeed");
  }
  if (calls !== 0) throw new Error(`invalid or zero reads called host ${calls} times`);
  if (Array.from(bytes).some((byte) => byte !== 77)) {
    throw new Error("invalid or zero read mutated memory");
  }
});

Deno.test("HTTP reads reject short chunks instead of silently padding responses", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const Http = createHttpImports({ memory }, () => ({ chunk: [1, 2, 3] }));
  if (Http.responseReadBody(12, 128, 4) === 0) {
    throw new Error("short HTTP chunks must fail");
  }
});

Deno.test("HTTP reads accept raw ArrayBuffers and ArrayBuffer views", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const raw = new Uint8Array([0, 255, 17, 128]).buffer;
  const viewedBuffer = new Uint8Array([99, 7, 8, 77]).buffer;
  const view = new DataView(viewedBuffer, 1, 2);
  const chunks: unknown[] = [raw, view];
  const Http = createHttpImports({ memory }, () => ({ chunk: chunks.shift() }));

  if (Http.responseReadBody(3, 512, 4) !== 0) {
    throw new Error("raw ArrayBuffer read failed");
  }
  if (Http.responseReadBody(3, 516, 2) !== 0) {
    throw new Error("ArrayBuffer view read failed");
  }
  const actual = Array.from(new Uint8Array(memory.buffer, 512, 6));
  if (JSON.stringify(actual) !== JSON.stringify([0, 255, 17, 128, 7, 8])) {
    throw new Error(`buffer conversion corrupted bytes: ${actual}`);
  }
});

Deno.test("HTTP end clears one request and bridge failures are reported", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const calls: unknown[] = [];
  const Http = createHttpImports({ memory }, (_idx: number, message: unknown) => {
    calls.push(structuredClone(message));
    if ((message as { name?: string }).name === "httpResponseEnd") return {};
    throw new Error("transport failed");
  });

  if (Http.responseEnd(44) !== 0) throw new Error("responseEnd failed");
  const expectedEnd = {
    name: "httpResponseEnd",
    args: { request_id: 44 },
  };
  if (JSON.stringify(calls[0]) !== JSON.stringify(expectedEnd)) {
    throw new Error(`unexpected end call: ${JSON.stringify(calls[0])}`);
  }
  if (Http.responseReadBody(44, 0, 1) === 0) {
    throw new Error("transport failure must return nonzero");
  }
});

Deno.test("HTTP start cleans retained state when metadata cannot be written", () => {
  for (const invalid of ["scalar", "pointer"] as const) {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const metadataPointers = [256, 260, 264, 268, 272] as const;
    const metadataBefore = [101, 102, 103, 104, 105];
    const metadataView = new DataView(memory.buffer);
    metadataPointers.forEach((pointer, index) => {
      metadataView.setUint32(pointer, metadataBefore[index], true);
    });
    const calls: unknown[] = [];
    const Http = createHttpImports({ memory }, (_idx: number, message: unknown) => {
      calls.push(structuredClone(message));
      return {
        request_id: 27,
        status: 200,
        headers_len: 1,
        body_len: 2,
        error_len: invalid === "scalar" ? -1 : 3,
      };
    });
    const outputPointers: readonly [number, number, number, number, number] = invalid === "pointer"
      ? [metadataPointers[0], metadataPointers[1], metadataPointers[2], metadataPointers[3], 70000]
      : metadataPointers;

    const result = Http.requestStart(
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...outputPointers,
    );
    if (result === 0) throw new Error(`invalid ${invalid} must fail`);
    const metadataAfter = metadataPointers.map((pointer) =>
      metadataView.getUint32(pointer, true)
    );
    if (JSON.stringify(metadataAfter) !== JSON.stringify(metadataBefore)) {
      throw new Error(`${invalid} failure partially wrote metadata: ${metadataAfter}`);
    }
    const expectedCalls = [
      {
        name: "httpRequestStart",
        args: { method: [], url: [], headers: [], body: [] },
      },
      {
        name: "httpResponseEnd",
        args: { request_id: 27 },
      },
    ];
    if (JSON.stringify(calls) !== JSON.stringify(expectedCalls)) {
      throw new Error(`${invalid} failure cleanup was not exact: ${JSON.stringify(calls)}`);
    }
  }
});

Deno.test("both VFS WIT worlds declare the exact same HTTP resource", async () => {
  const primary = await Deno.readTextFile(
    new URL("../crates/vfs/wit/vfs-host.wit", import.meta.url),
  );
  const twice = await Deno.readTextFile(
    new URL("../crates/vfs-rustc-twice/wit/vfs-host.wit", import.meta.url),
  );
  const resourcePattern = /\n  resource http \{[\s\S]*?\n  \}/;
  const primaryHttp = primary.match(resourcePattern)?.[0];
  const twiceHttp = twice.match(resourcePattern)?.[0];
  if (!primaryHttp) throw new Error("primary VFS WIT is missing resource http");
  if (primaryHttp !== twiceHttp) throw new Error("HTTP WIT resources differ");
  if (/\blist\s*</.test(primaryHttp)) throw new Error("WIT lists are prohibited");
});

Deno.test("failed HTTP start cleanup is owned only by the JS adapter", async () => {
  const source = await Deno.readTextFile(
    new URL("../crates/vfs/src/lib.rs", import.meta.url),
  );
  const fetchStart = source.indexOf('pub extern "C" fn wasi_ext_fetch(');
  const failureStart = source.indexOf("if start_result != 0", fetchStart);
  const guardStart = source.indexOf("let response_guard", failureStart);
  if (fetchStart < 0 || failureStart < 0 || guardStart < 0) {
    throw new Error("could not locate wasi_ext_fetch start-failure branch");
  }
  const failureBranch = source.slice(failureStart, guardStart);
  if (failureBranch.includes("response_end")) {
    throw new Error("Rust must not duplicate JS cleanup after request_start failure");
  }
});
