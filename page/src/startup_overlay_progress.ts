import type { CrateGraphProgress } from "./rust_analyzer_readiness.ts";

const REQUIRED_CRATE_LABELS = ["rubrc_main", "core", "alloc", "std"] as const;

export type ProjectProgressPresentation = {
  summary: string;
  detail: string;
};

export function presentProjectProgress(
  progress: CrateGraphProgress,
): ProjectProgressPresentation {
  const waiting = REQUIRED_CRATE_LABELS.filter(
    (label) => !progress.labels.includes(label),
  );
  const summary = `${Math.floor(progress.elapsedMs / 1_000)}s · poll ${progress.attempt} · crates ${progress.labels.length}/${REQUIRED_CRATE_LABELS.length}`;
  const found = progress.labels.join(", ");
  const detail =
    waiting.length === 0
      ? found
      : found.length === 0
        ? `waiting: ${waiting.join(", ")}`
        : `${found} · waiting: ${waiting.join(", ")}`;
  return { summary, detail };
}
