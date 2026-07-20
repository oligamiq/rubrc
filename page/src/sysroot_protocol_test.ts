import { sysrootMetaStatus } from "./sysroot_protocol.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
};

Deno.test("sysroot meta protocol preserves host failure status", () => {
  assertEquals(sysrootMetaStatus(undefined), 0);
  assertEquals(sysrootMetaStatus({ has_file: false }), 0);
  assertEquals(sysrootMetaStatus({ has_file: true }), 1);
  assertEquals(sysrootMetaStatus({ has_file: -1 }), -1);
});
