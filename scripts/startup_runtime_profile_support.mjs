export function processTree(text, rootPid) {
  const rows = text.split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]),
      kind: match[4].match(/(?:^|\s)--type=([^\s]+)/)?.[1] ?? "browser" }];
  });
  const ids = new Set([rootPid]);
  let previous;
  do {
    previous = ids.size;
    for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
  } while (previous !== ids.size);
  return rows.filter(row => ids.has(row.pid));
}

// Serialized into the utility Worker's realm. Observe its existing allocation;
// do not allocate a second memory or keep an otherwise-dead memory alive.
export function installMemoryProbe() {
  const Original = WebAssembly.Memory;
  const records = [];
  const Wrapper = new Proxy(Original, {
    construct(target, args, newTarget) {
      const memory = Reflect.construct(target, args, newTarget);
      records.push({ ref: new WeakRef(memory), initial: args[0].initial, maximum: args[0].maximum });
      return memory;
    },
  });
  globalThis.__rubrcMemoryProbe = {
    snapshot: () => records.flatMap(({ ref, initial, maximum }) => {
      const memory = ref.deref();
      return memory ? [{ bytes: memory.buffer.byteLength, initial, maximum }] : [];
    }),
    restore: () => { if (WebAssembly.Memory === Wrapper) WebAssembly.Memory = Original; },
  };
  WebAssembly.Memory = Wrapper;
}
