export function readVfsMemorySnapshot(
  exports: Record<string, unknown>,
  memory: { readonly buffer: { readonly byteLength: number } },
): Record<string, unknown> {
  const prefix = "__wasip1_vfs_";
  const required = ["memory_lock_read_acquire", "memory_lock_read_release", "host_own_memory_size_get"];
  const functions = required.map(name => exports[`${prefix}${name}`]);
  const missing = required.filter((_, index) => typeof functions[index] !== "function");
  const bases = Object.entries(exports).flatMap(([name, getter]) => {
    const match = /^__wasip1_vfs_(.+)_memory_grow_global_alt_get_no_wait$/.exec(name);
    return match && typeof getter === "function" ? [{ name: match[1], get: getter as () => number }] : [];
  });
  if (missing.length || !bases.length) return { status: "unsupported", missing, baseGetters: bases.length };

  const [acquire, release, getLogical] = functions as [() => void, () => void, () => number];
  let combinedBytes: number;
  let hostLogicalPages: number;
  let guestBaseBytes: Record<string, number>;
  // These calls must only run from a JS startup boundary/timer, never from a
  // Rust-to-JS callback. Use the existing guard to prevent relocation while
  // reading offsets, then release it before formatting/logging the snapshot.
  acquire();
  try {
    combinedBytes = memory.buffer.byteLength;
    hostLogicalPages = getLogical();
    guestBaseBytes = Object.fromEntries(bases.map(({ name, get }) => {
      const value = get();
      if (!Number.isInteger(value) || value < -2147483648 || value > 4294967295) {
        throw new Error(`invalid base getter result: ${name}`);
      }
      return [name, value >>> 0];
    }));
  } finally { release(); }

  const pageBytes = 65536;
  const raw = { combinedBytes, hostLogicalPages, guestBaseBytes };
  if (!Number.isSafeInteger(hostLogicalPages) || !Number.isSafeInteger(combinedBytes) ||
    combinedBytes <= 0 || combinedBytes % pageBytes !== 0) return { status: "invalid" };
  const offsets = Object.values(guestBaseBytes);
  if (offsets.some(offset => offset > combinedBytes || offset % pageBytes !== 0)) {
    return { status: "invalid", ...raw };
  }
  const positiveOffsets = offsets.filter(offset => offset > 0);
  if (hostLogicalPages === -1 || !positiveOffsets.length) return { status: "uninitialized", ...raw };

  // In this WVL single-memory layout __self starts at zero. The first positive
  // guest base marks its physical boundary. This is capacity, not RSS or free
  // allocator bytes; logical growth cannot exceed it without explicit reserve.
  const hostPhysicalBytes = Math.min(...positiveOffsets);
  const hostLogicalBytes = hostLogicalPages * pageBytes;
  if (hostLogicalPages < 0 || hostLogicalBytes > hostPhysicalBytes) return { status: "invalid", ...raw };
  return { status: "ready", ...raw, hostLogicalBytes, hostPhysicalBytes };
}
