export const createRunAfterFlush = (
  flush: () => Promise<void>,
  run: (triple?: string) => Promise<void>,
  reportError: (error: unknown) => void,
) => {
  let running = false;
  return async (triple?: string): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await flush();
      await run(triple);
    } catch (error) {
      reportError(error);
    } finally {
      running = false;
    }
  };
};
