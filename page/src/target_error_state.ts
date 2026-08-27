type TargetRequestIdentity = {
  request: number;
  triple: string;
};

const errorMessage = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown target loading error";
  }
};

export function createTargetErrorState(options: {
  signal: AbortSignal;
  publish(message: string | undefined): void;
}) {
  let nextRequest = 0;
  let latest: TargetRequestIdentity | undefined;
  return {
    async load(triple: string, operation: () => Promise<void>): Promise<void> {
      const identity = { request: ++nextRequest, triple };
      latest = identity;
      if (!options.signal.aborted) options.publish(undefined);
      try {
        await operation();
      } catch (error) {
        if (
          !options.signal.aborted &&
          latest?.request === identity.request &&
          latest.triple === identity.triple
        ) {
          options.publish(errorMessage(error));
        }
        throw error;
      }
    },
  };
}
