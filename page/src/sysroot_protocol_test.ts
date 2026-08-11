import {
  sysrootMetaStatus,
  takeExactSysrootChunk,
  validateSysrootChunkLength,
} from "./sysroot_protocol.ts";

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

Deno.test("sysroot meta protocol preserves host failure status", () => {
  assertEquals(sysrootMetaStatus(undefined), 0);
  assertEquals(sysrootMetaStatus({ has_file: false }), 0);
  assertEquals(sysrootMetaStatus({ has_file: true }), 1);
  assertEquals(sysrootMetaStatus({ has_file: -1 }), -1);
});

Deno.test("sysroot chunk protocol accepts non-negative safe integer lengths", () => {
  assertEquals(validateSysrootChunkLength(0), 0);
  assertEquals(validateSysrootChunkLength(1), 1);
  assertEquals(validateSysrootChunkLength(50 * 1024 * 1024), 50 * 1024 * 1024);
  assertEquals(
    validateSysrootChunkLength(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  for (const invalid of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
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

Deno.test("sysroot chunk batching has one Rust source parameter", async () => {
  const rustSource = await Deno.readTextFile(
    new URL("../../crates/vfs-shell/src/main.rs", import.meta.url),
  );
  const protocolSource = await Deno.readTextFile(
    new URL("./sysroot_protocol.ts", import.meta.url),
  );
  const fullVfsSource = await Deno.readTextFile(
    new URL("../../scripts/vfs_lsp_diagnostics_test.ts", import.meta.url),
  );

  assertEquals(
    rustSource.includes(
      "const SYSROOT_FILE_CHUNK_SIZE: usize = 50 * 1024 * 1024;",
    ),
    true,
  );
  assertEquals(
    rustSource.includes("std::cmp::min(remaining, SYSROOT_FILE_CHUNK_SIZE)"),
    true,
  );
  assertEquals(rustSource.match(/\bSYSROOT_FILE_CHUNK_SIZE\b/g)?.length, 2);
  assertEquals(/\blet\s+(?:mut\s+)?chunk_size\b/.test(rustSource), false);
  assertEquals(rustSource.includes("512 * 1024"), false);
  assertEquals(protocolSource.includes("MAX_SYSROOT_CHUNK_LENGTH"), false);
  assertEquals(fullVfsSource.includes("MAX_SYSROOT_CHUNK_LENGTH"), false);
  assertEquals(fullVfsSource.includes("takeExactSysrootChunk("), true);
  assertEquals(
    /currentSysrootFile\.data\s*=\s*remaining/.test(fullVfsSource),
    true,
  );
  assertEquals(fullVfsSource.includes("currentSysrootFile.offset"), false);
  assertEquals(fullVfsSource.includes("offset: number"), false);
  assertEquals(
    fullVfsSource.includes("currentSysrootFile.entry.data.slice("),
    false,
  );
  assertEquals(
    fullVfsSource.includes(
      "console.log(`maximum sysroot chunk request: ${maxSysrootChunkLength}`)",
    ),
    true,
  );
});
