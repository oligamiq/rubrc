// Diagnostic-only host import profiler. Never use instrumented wall times for acceptance.
// Call once per instance in every worker; snapshot before terminating a worker.
export function profileHostImports(imports, descriptors, {now = () => performance.now(), sampleEvery = 1024} = {}) {
  if (!Number.isSafeInteger(sampleEvery) || sampleEvery < 1) throw new Error('invalid sampleEvery');
  const result = Object.create(null), rows = new Map();
  for (const [module, namespace] of Object.entries(imports)) result[module] = Object.assign(Object.create(null), namespace);
  for (const {module, name, kind} of descriptors) {
    if (kind !== 'function') continue;
    const key = JSON.stringify([module, name]);
    if (rows.has(key)) continue;
    const original = imports[module]?.[name];
    if (typeof original !== 'function') throw new Error(`missing host function ${key}`);
    const row = {module, name, calls: 0, throws: 0, timedCalls: 0, sampledInclusiveMs: 0, maxSampleMs: 0, clockErrors: 0};
    rows.set(key, row);
    const clock = () => {
      try { const value = now(); if (Number.isFinite(value)) return value; } catch {}
      row.clockErrors++; return null;
    };
    result[module][name] = function (...args) {
      row.calls++;
      const timed = row.calls % sampleEvery === 0;
      const start = timed ? clock() : null;
      try { return Reflect.apply(original, this, args); }
      catch (error) { row.throws++; throw error; }
      finally {
        if (start !== null) {
          const end = clock();
          if (end !== null && end >= start) {
            const elapsed = end - start;
            row.timedCalls++; row.sampledInclusiveMs += elapsed;
            row.maxSampleMs = Math.max(row.maxSampleMs, elapsed);
          } else if (end !== null) row.clockErrors++;
        }
      }
    };
  }
  return {imports: result, snapshot: () => ({sampleEvery, scope: 'synchronous inclusive host-call duration; sampled, not CPU time; nested calls may overlap', functions: [...rows.values()].map(row => ({...row}))})};
}
