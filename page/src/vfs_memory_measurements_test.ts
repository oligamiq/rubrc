import { readVfsMemorySnapshot } from "./vfs_memory_measurements.ts";

const PAGE = 65536;
const prefix = "__wasip1_vfs_";
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function fixture(logicalPages = 2, base = 10 * PAGE) {
  const calls: string[] = [];
  let locked = false;
  const guarded = (value: number) => {
    if (!locked) throw new Error("unguarded memory observation");
    return value;
  };
  const exports: Record<string, unknown> = {
    [`${prefix}memory_lock_read_acquire`]: () => { locked = true; calls.push("acquire"); },
    [`${prefix}memory_lock_read_release`]: () => { locked = false; calls.push("release"); },
    [`${prefix}host_own_memory_size_get`]: () => { calls.push("logical"); return guarded(logicalPages); },
    [`${prefix}later_memory_grow_global_alt_get_no_wait`]: () => guarded(30 * PAGE),
    [`${prefix}first_memory_grow_global_alt_get_no_wait`]: () => guarded(base),
  };
  return { calls, exports, memory: { buffer: { byteLength: 50 * PAGE } } };
}

Deno.test("VFS capacity snapshot distinguishes logical pages from physical byte capacity", () => {
  const f = fixture();
  const result = readVfsMemorySnapshot(f.exports, f.memory);
  equal(result.status, "ready");
  equal(result.hostLogicalBytes, 2 * PAGE);
  equal(result.hostPhysicalBytes, 10 * PAGE);
  equal(result.combinedBytes, 50 * PAGE);
  equal(result.guestBaseBytes, { later: 30 * PAGE, first: 10 * PAGE });
  equal(f.calls, ["acquire", "logical", "release"]);
});

Deno.test("unsupported core performs no guest calls", () => {
  const f = fixture();
  delete f.exports[`${prefix}memory_lock_read_release`];
  equal(readVfsMemorySnapshot(f.exports, f.memory).status, "unsupported");
  equal(f.calls, []);
});

Deno.test("uninitialized logical size is not reported as an unsigned memory size", () => {
  const f = fixture(-1);
  equal(readVfsMemorySnapshot(f.exports, f.memory).status, "uninitialized");
  equal(f.calls.at(-1), "release");
});

Deno.test("inconsistent physical geometry is rejected instead of suggesting free capacity", () => {
  for (const [pages, base] of [[2, PAGE], [2, PAGE + 1], [2, 51 * PAGE]]) {
    const f = fixture(pages, base);
    equal(readVfsMemorySnapshot(f.exports, f.memory).status, "invalid");
    equal(f.calls.at(-1), "release");
  }
});

Deno.test("failed getter releases the existing read lock", () => {
  const f = fixture();
  f.exports[`${prefix}host_own_memory_size_get`] = () => { throw new Error("probe getter failure"); };
  let error = "";
  try { readVfsMemorySnapshot(f.exports, f.memory); } catch (caught) { error = String(caught); }
  equal(error.includes("probe getter failure"), true);
  equal(f.calls, ["acquire", "release"]);
});
