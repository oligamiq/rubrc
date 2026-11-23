// Diagnostic offsets are valid ONLY for this already verified final-core hash.
export const RESET_DIAGNOSTIC_CORE = '375a07601afac782b81ffd7d49a0891bf7980cca395e5deabd918e569ea06502';
export function resetMemorySnapshot(memory, coreSha) {
  if (coreSha !== RESET_DIAGNOSTIC_CORE) throw new Error('unsupported reset diagnostic core');
  const words = new Uint32Array(memory.buffer);
  const load = address => {
    if (address % 4 || address < 0 || address / 4 >= words.length) throw new Error('diagnostic address out of bounds');
    return Atomics.load(words, address / 4);
  };
  const baseBefore = load(1121832);
  const lockBefore = load(1121964);
  const logicalPages = load(1121288);
  const guardAddress = baseBefore + 2927520;
  const guard = guardAddress + 4 <= memory.buffer.byteLength ? load(guardAddress) : null;
  const baseAfter = load(1121832);
  const lockAfter = load(1121964);
  return {baseBefore, baseAfter, lockBefore, lockAfter, logicalPages, guardAddress, guard,
    relocationObserved: baseBefore !== baseAfter,
    note: 'nonlocking diagnostic observation; not an atomic snapshot or proof of lock ownership'};
}
