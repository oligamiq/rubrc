export function retainAsyncCleanup(
  pending: Promise<(() => void) | undefined>,
  report: (error: unknown) => void = console.error,
): { dispose(): void } {
  let cleanup: (() => void) | undefined;
  let disposed = false;
  const safeReport = (error: unknown) => {
    try {
      report(error);
    } catch {
      // Reporting must not create another cleanup failure.
    }
  };
  const runCleanup = (resolved: (() => void) | undefined) => {
    if (resolved === undefined) return;
    try {
      resolved();
    } catch (error) {
      safeReport(error);
    }
  };
  void pending.then((resolved) => {
    if (disposed) runCleanup(resolved);
    else cleanup = resolved;
  }, safeReport);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      const mountedCleanup = cleanup;
      cleanup = undefined;
      runCleanup(mountedCleanup);
    },
  };
}
