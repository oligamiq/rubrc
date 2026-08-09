import {
  MAX_SYSROOT_CHUNK_LENGTH,
  sysrootMetaStatus,
  takeExactSysrootChunk,
  validateSysrootChunkLength,
} from "./sysroot_protocol.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected)
    throw new Error(`expected ${expected}, got ${actual}`);
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

Deno.test("sysroot meta protocol preserves host failure status", () => {
  assertEquals(sysrootMetaStatus(undefined), 0);
  assertEquals(sysrootMetaStatus({ has_file: false }), 0);
  assertEquals(sysrootMetaStatus({ has_file: true }), 1);
  assertEquals(sysrootMetaStatus({ has_file: -1 }), -1);
});

Deno.test("sysroot chunk protocol accepts only positive lengths through 512 KiB", () => {
  assertEquals(validateSysrootChunkLength(1), 1);
  assertEquals(
    validateSysrootChunkLength(MAX_SYSROOT_CHUNK_LENGTH),
    512 * 1024,
  );
  for (const invalid of [0, -1, 1.5, Number.NaN, "1", 512 * 1024 + 1]) {
    assertThrows(
      () => validateSysrootChunkLength(invalid),
      "sysroot chunk length",
    );
  }
});

Deno.test("sysroot chunk protocol never silently truncates", () => {
  const result = takeExactSysrootChunk(new Uint8Array([1, 2, 3]), 2);
  assertEquals(Array.from(result.chunk).join(","), "1,2");
  assertEquals(Array.from(result.remaining).join(","), "3");
  assertThrows(
    () => takeExactSysrootChunk(new Uint8Array([1]), 2),
    "requested 2 bytes with only 1 available",
  );
});
