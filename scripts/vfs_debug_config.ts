export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

export function buildRepeatedCommands(
  command: readonly string[],
  runs: number,
): string[][] {
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(`runs must be a positive integer, got ${runs}`);
  }

  return Array.from({ length: runs }, () => [...command]);
}

export function computeWorkerWatchdogMs(options: {
  commandTimeoutMs: number;
  runs: number;
  perRunMultiplier: number;
  graceMs: number;
}): number {
  const { commandTimeoutMs, runs, perRunMultiplier, graceMs } = options;
  return commandTimeoutMs * (1 + perRunMultiplier * runs) + graceMs;
}
