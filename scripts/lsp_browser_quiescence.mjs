export const STARTUP_TIMEOUT_MS = 300_000;
export const DIAGNOSTICS_TIMEOUT_MS = 15_000;
export const ANALYSIS_TIMEOUT_MS = 300_000;

/**
 * @param {{
 *   stage: string,
 *   waitForPublication: () => Promise<unknown>,
 *   waitForMarkers?: () => Promise<unknown>,
 *   requestSyntaxTree: () => Promise<unknown>,
 *   timeoutMs?: number,
 * }} options
 */
export async function waitForDiagnosticsQuiescence({
  stage,
  waitForPublication,
  waitForMarkers,
  requestSyntaxTree,
  timeoutMs = DIAGNOSTICS_TIMEOUT_MS,
}) {
  await waitForPublication();
  await waitForMarkers?.();

  let timeout;
  try {
    await Promise.race([
      Promise.resolve().then(requestSyntaxTree),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `syntax-tree quiescence timed out after ${timeoutMs} ms during ${stage}`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
