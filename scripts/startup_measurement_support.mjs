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
