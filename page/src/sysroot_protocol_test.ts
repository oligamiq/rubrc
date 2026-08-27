import {
  sysrootArchiveMetaStatus,
  takeExactSysrootChunk,
  validateSysrootChunkLength,
} from "./sysroot_protocol.ts";
import {
  createSysrootArchiveCallbackAdapter,
  SysrootArchiveStore,
} from "./sysroot_archive_store.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
};

const assertThrows = (fn: () => unknown, expected: string) => {
  let message = "";
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes(expected)) {
    throw new Error(`expected error containing ${expected}, got ${message}`);
  }
};

const assertNotPromise = (value: unknown) => {
  const then = value !== null &&
      (typeof value === "object" || typeof value === "function")
    ? (value as { then?: unknown }).then
    : undefined;
  assertEquals(typeof then, "undefined");
};

Deno.test("sysroot meta protocol preserves host failure status", () => {
  assertEquals(sysrootArchiveMetaStatus(undefined), 0);
  assertEquals(sysrootArchiveMetaStatus({ has_archive: false }), 0);
  assertEquals(sysrootArchiveMetaStatus({ has_archive: true }), 1);
  assertEquals(sysrootArchiveMetaStatus({ has_archive: -1 }), -1);
});

Deno.test("sysroot chunk protocol accepts non-negative safe integer lengths", () => {
  assertEquals(validateSysrootChunkLength(0), 0);
  assertEquals(validateSysrootChunkLength(1), 1);
  assertEquals(validateSysrootChunkLength(50 * 1024 * 1024), 50 * 1024 * 1024);
  assertEquals(
    validateSysrootChunkLength(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  for (
    const invalid of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1",
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    assertThrows(
      () => validateSysrootChunkLength(invalid),
      "sysroot chunk length",
    );
  }
});

Deno.test("sysroot chunk protocol never silently truncates", () => {
  const data = new Uint8Array([1, 2, 3]);
  const probe = takeExactSysrootChunk(data, 0);
  assertEquals(probe.chunk.length, 0);
  assertEquals(probe.chunk.buffer, data.buffer);
  assertEquals(probe.remaining, data);
  assertEquals(probe.remaining.buffer, data.buffer);
  assertEquals(probe.remaining.byteOffset, data.byteOffset);
  assertEquals(probe.remaining.length, data.length);
  assertEquals(Array.from(probe.remaining).join(","), "1,2,3");

  const result = takeExactSysrootChunk(data, 2);
  assertEquals(Array.from(result.chunk).join(","), "1,2");
  assertEquals(Array.from(result.remaining).join(","), "3");
  assertEquals(result.chunk.buffer, data.buffer);
  assertEquals(result.remaining.buffer, data.buffer);
  assertThrows(
    () => takeExactSysrootChunk(new Uint8Array([1]), 2),
    "requested 2 bytes with only 1 available",
  );
});

Deno.test("sysroot bridge requires an exact chunk response", async () => {
  const protocol = (await import("./sysroot_protocol.ts")) as unknown as {
    validateExactSysrootChunk: (
      data: Uint8Array,
      requestedLength: unknown,
    ) => Uint8Array;
  };
  assertEquals(typeof protocol.validateExactSysrootChunk, "function");
  const data = new Uint8Array([1, 2]);
  assertEquals(protocol.validateExactSysrootChunk(data, 2), data);
  assertThrows(
    () => protocol.validateExactSysrootChunk(new Uint8Array([1]), 2),
    "returned 1 bytes for a 2-byte request",
  );
  assertThrows(
    () => protocol.validateExactSysrootChunk(new Uint8Array([1, 2, 3]), 2),
    "returned 3 bytes for a 2-byte request",
  );
});

Deno.test("sysroot callback adapter synchronously streams exact chunks", async () => {
  const store = new SysrootArchiveStore({
    loadBytes: async () => new Uint8Array([1, 2, 3]),
    parseEntries: async () => [],
  });
  await store.prefetch(
    ["wasm32-wasip1"],
    new AbortController().signal,
  );
  const callback = createSysrootArchiveCallbackAdapter(store);

  const started = callback({
    name: "sysrootStartFetch",
    args: { triple: "wasm32-wasip1" },
  });
  assertNotPromise(started);
  const meta = callback({ name: "sysrootArchiveGetMeta", args: {} });
  assertNotPromise(meta);
  assertEquals((meta as { has_archive: unknown }).has_archive, true);
  assertEquals((meta as { data_len: unknown }).data_len, 3);

  const first = callback({
    name: "sysrootReadArchiveChunk",
    args: { chunk_len: 2 },
  });
  assertNotPromise(first);
  assertEquals((first as { chunk: number[] }).chunk.join(","), "1,2");
  const final = callback({
    name: "sysrootReadArchiveChunk",
    args: { chunk_len: 1 },
  });
  assertNotPromise(final);
  assertEquals((final as { chunk: number[] }).chunk.join(","), "3");

  const released = callback({ name: "sysrootArchiveGetMeta", args: {} });
  assertNotPromise(released);
  assertEquals((released as { has_archive: unknown }).has_archive, false);
  assertThrows(
    () =>
      callback({
        name: "sysrootReadArchiveChunk",
        args: { chunk_len: 1 },
      }),
    "No current sysroot archive",
  );
  store.dispose();
});

Deno.test("sysroot callback adapter transports beginRead errors synchronously", () => {
  const store = new SysrootArchiveStore({
    loadBytes: async () => new Uint8Array(),
    parseEntries: async () => [],
  });
  const callback = createSysrootArchiveCallbackAdapter(store);
  const expected = "sysroot archive missing-target is not ready";

  const started = callback({
    name: "sysrootStartFetch",
    args: { triple: "missing-target" },
  });
  assertNotPromise(started);
  assertEquals(
    (started as { error: unknown }).error,
    expected,
  );
  const meta = callback({ name: "sysrootArchiveGetMeta", args: {} });
  assertNotPromise(meta);
  assertEquals((meta as { has_archive: unknown }).has_archive, -1);
  assertEquals((meta as { error: unknown }).error, expected);
  store.dispose();
});

Deno.test("sysroot archive extraction does not allocate the complete archive", async () => {
  const rustSource = await Deno.readTextFile(
    new URL("../../crates/vfs-shell/src/main.rs", import.meta.url),
  );
  const extractionSource = await Deno.readTextFile(
    new URL(
      "../../crates/vfs-shell/src/sysroot_extraction.rs",
      import.meta.url,
    ),
  );
  const protocolSource = await Deno.readTextFile(
    new URL("./sysroot_protocol.ts", import.meta.url),
  );
  const fullVfsSource = await Deno.readTextFile(
    new URL("../../scripts/vfs_lsp_diagnostics_test.ts", import.meta.url),
  );

  assertEquals(rustSource.includes("vec![0u8; archive_len]"), false);
  assertEquals(
    /SysrootArchiveReader::new\(\s*archive_len,/.test(rustSource),
    true,
  );
  assertEquals(
    /impl<C,\s*F>\s+std::io::Read\s+for\s+SysrootArchiveReader<C,\s*F>/.test(
      extractionSource,
    ),
    true,
  );
  assertEquals(
    extractionSource.includes(
      "const MAX_SYSROOT_ARCHIVE_READ_LEN: usize = 512 * 1024;",
    ),
    true,
  );
  assertEquals(
    extractionSource.includes("buffer.len(), MAX_SYSROOT_ARCHIVE_READ_LEN"),
    true,
  );
  assertEquals(protocolSource.includes("MAX_SYSROOT_CHUNK_LENGTH"), false);
  assertEquals(fullVfsSource.includes("MAX_SYSROOT_CHUNK_LENGTH"), false);
  assertEquals(fullVfsSource.includes("takeExactSysrootChunk("), true);
  assertEquals(
    /currentSysrootArchive\s*=\s*remaining/.test(fullVfsSource),
    true,
  );
  assertEquals(fullVfsSource.includes("currentSysrootArchive.offset"), false);
  assertEquals(fullVfsSource.includes("offset: number"), false);
  assertEquals(
    fullVfsSource.includes("currentSysrootArchive.entry.data.slice("),
    false,
  );
  assertEquals(
    fullVfsSource.includes(
      "console.log(`maximum sysroot chunk request: ${maxSysrootChunkLength}`)",
    ),
    true,
  );
});
