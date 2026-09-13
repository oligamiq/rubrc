import { For, Show } from "solid-js";
import type { StartupSnapshot } from "./startup_coordinator";
import { presentProjectProgress } from "./startup_overlay_progress.ts";
import {
  getRustAnalyzerParallelism,
  presentRustAnalyzerParallelism,
} from "./runtime_parallelism.ts";

export type StartupOverlayProps = { state: StartupSnapshot };

export const StartupOverlay = (props: StartupOverlayProps) => {
  const state = () => props.state;
  const parallelism = presentRustAnalyzerParallelism(
    getRustAnalyzerParallelism(),
  );

  return (
    <div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-end bg-gray-950/55 px-4 sm:px-8">
      <div class="w-full max-w-sm border border-gray-700/80 bg-gray-950/90 p-3 font-mono text-xs text-gray-300 shadow-2xl backdrop-blur-sm">
        <div class="mb-2 flex items-center justify-between border-b border-gray-800 pb-2">
          <span class="text-green-400">Starting rust-analyzer</span>
          <span class="text-gray-500">{state().phase}</span>
        </div>
        <div
          class="mb-2 text-[11px] text-gray-500"
          data-rust-analyzer-parallelism
        >
          {parallelism}
        </div>
        <div class="space-y-1.5">
          <For each={state().tasks}>
            {(task) => {
              const projectProgress =
                task.id === "project" ? task.projectProgress : undefined;
              const presentation =
                projectProgress === undefined
                  ? undefined
                  : presentProjectProgress(projectProgress);

              return (
                <div
                  class="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1"
                  data-startup-task={task.id}
                >
                  <span
                    class={
                      task.state === "complete"
                        ? "text-green-500"
                        : task.state === "failed"
                          ? "text-red-400"
                          : "text-gray-500"
                    }
                  >
                    {task.state === "complete"
                      ? "✓"
                      : task.state === "failed"
                        ? "×"
                        : task.state === "running"
                          ? "›"
                          : "·"}
                  </span>
                  <span class={task.state === "running" ? "text-white" : ""}>
                    {task.label}
                  </span>
                  <Show
                    when={presentation}
                    fallback={
                      <Show when={task.state === "running"}>
                        {task.progress === undefined ? (
                          <span
                            class="animate-pulse text-green-400"
                            aria-label="in progress"
                          >
                            ...
                          </span>
                        ) : (
                          <span class="text-green-400">
                            {Math.round(task.progress)}%
                          </span>
                        )}
                      </Show>
                    }
                  >
                    {(details) => (
                      <>
                        <span
                          class={
                            task.state === "failed"
                              ? "text-red-400"
                              : "text-green-400"
                          }
                        >
                          {details().summary}
                        </span>
                        <span class="col-start-2 col-span-2 min-w-0 whitespace-normal break-words text-gray-400">
                          {details().detail}
                        </span>
                      </>
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={state().error}>
          <div class="mt-3 border-t border-red-950 pt-2 text-red-400">
            {state().error}
          </div>
        </Show>
      </div>
    </div>
  );
};
