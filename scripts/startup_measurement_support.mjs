export const NETWORK_PROFILES = {
  normal: { latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  constrained: { latency: 150, downloadThroughput: 5_000_000 / 8, uploadThroughput: 1_000_000 / 8 },
};

export function validateWorkerTransfer(profile, bytes, elapsedMs, expectedBytes = 2 * 1024 * 1024) {
  if (bytes !== expectedBytes || bytes <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error("invalid Worker network probe");
  }
  if (profile.downloadThroughput > 0 && elapsedMs < bytes / profile.downloadThroughput * 1000 * 0.8) {
    throw new Error("Worker transfer was too fast: network throttling was not verified");
  }
}

export function summarizeStartup(measurements, installedSysroots = {}) {
  const phases = measurements?.phases ?? {};
  const tasks = installedSysroots;
  const elapsed = (end, start) => Number.isFinite(end) && Number.isFinite(start) ? end - start : undefined;
  const sysrootDone = Number.isFinite(tasks["rust-src"]) && Number.isFinite(tasks["target-sysroot"])
    ? Math.max(tasks["rust-src"], tasks["target-sysroot"]) : undefined;
  return {
    postSysrootMs: elapsed(phases.ready, sysrootDone),
    projectActivationMs: elapsed(phases["semantic-warming"], phases["project-activating"]),
    semanticWarmMs: elapsed(phases.ready, phases["semantic-warming"]),
  };
}

// Runs inside the measured page. Timestamp the existing diagnostic event sink
// synchronously; do not add an interval or additional LSP requests.
export function installLspEventTiming() {
  const events = [];
  const arrays = new WeakSet();
  window.__rubrcMeasureEvents = events;
  let api;
  Object.defineProperty(window, "__rubrcLspTest", {
    configurable: true,
    get: () => api,
    set(value) {
      api = new Proxy(value, {
        set(target, key, value, receiver) {
          if (key === "mainDiagnosticsPublicationCount" && value > (target[key] ?? 0) && events.length < 2000) {
            events.push({ atMs: performance.now(), boundary: "diagnostics-publication",
              method: "textDocument/publishDiagnostics", publicationCount: value,
              modelVersionAtPublication: target.model?.getVersionId() });
          }
          return Reflect.set(target, key, value, receiver);
        },
        get(target, key, receiver) {
        const result = Reflect.get(target, key, receiver);
        if (key === "lspEvents" && Array.isArray(result) && !arrays.has(result)) {
          arrays.add(result);
          Object.defineProperty(result, "push", { configurable: true, value(...items) {
            for (const event of items) {
              const msg = event?.message;
              if (!msg || events.length >= 2000) continue;
              events.push({ atMs: performance.now(), boundary: event.boundary, method: msg.method,
                id: msg.id, errorCode: msg.error?.code,
                diagnosticVersion: msg.method === "textDocument/publishDiagnostics" ? msg.params?.version : undefined,
                diagnosticUri: msg.method === "textDocument/publishDiagnostics" ? msg.params?.uri : undefined });
            }
            return Array.prototype.push.apply(this, items);
          } });
        }
        return result;
      } });
    },
  });
}
