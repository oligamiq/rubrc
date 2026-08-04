/**
 * @param {() => Promise<Record<string, unknown>>} evaluate
 * @param {() => { trace: string, droppedChunks: number }} getTraceSnapshot
 * @param {number} [timeoutMs]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function safeFailureState(
  evaluate,
  getTraceSnapshot,
  timeoutMs = 1000,
) {
  const evaluation = Promise.resolve().then(evaluate);
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `page evaluation timed out after ${timeoutMs}ms`,
      );
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });
  let state;
  try {
    state = await Promise.race([evaluation, timeout]);
  } catch (error) {
    state = {
      evaluationError: describeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
  const traceSnapshot = getTraceSnapshot();
  return {
    ...state,
    trace: traceSnapshot.trace,
    traceDroppedChunks: traceSnapshot.droppedChunks,
  };
}

function describeError(error) {
  try {
    if (error instanceof Error) {
      const name = error.name;
      const message = error.message;
      if (typeof name !== "string" || typeof message !== "string") {
        return "Unknown";
      }
      return message === "" ? name : `${name}: ${message}`;
    }
    return String(error);
  } catch {
    return "Unknown";
  }
}
