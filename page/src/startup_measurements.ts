export type StartupMeasurements = {
  phases: Record<string, number>;
  completedTasks: Record<string, number>;
};

export function recordStartupMeasurement(
  previous: StartupMeasurements | undefined,
  snapshot: { phase: string; tasks: readonly { id: string; state: string }[] },
  now: number,
): StartupMeasurements {
  const phases = { ...previous?.phases };
  const completedTasks = { ...previous?.completedTasks };
  phases[snapshot.phase] ??= now;
  for (const task of snapshot.tasks) {
    if (task.state === "complete") completedTasks[task.id] ??= now;
  }
  return { phases, completedTasks };
}
