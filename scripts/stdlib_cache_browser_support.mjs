export function monitorRenderer(page) {
  let error;
  let reject;
  const crashed = new Promise((_, rejectCrash) => { reject = rejectCrash; });
  // Crashes can occur during setup, before there is an active raced operation.
  void crashed.catch(() => {});
  const onError = (cause) => {
    error ??= cause instanceof Error ? cause : new Error(String(cause));
    reject(error);
  };
  page.on("error", onError);
  return {
    get error() { return error; },
    race: (operation) => Promise.race([crashed, operation]),
    dispose: () => page.off("error", onError),
  };
}

export async function withDeadline(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function assertCacheOutcome(cached, downloaded, reports) {
  const loaded = reports.some(line => line.startsWith("[stdlib-cache] loaded:"));
  const merged = reports.some(line => /^\[stdlib-cache\] merged: moved_source_root_files=0(?:\s|$)/.test(line));
  if (cached) {
    if (!downloaded) throw new Error("cache asset was not downloaded");
    if (!loaded) throw new Error("cache was not loaded");
    if (!merged) throw new Error("cache was not merged with stable source roots");
  } else if (downloaded || loaded || merged) {
    throw new Error("cold trial unexpectedly used the cache");
  }
}
