import { For, Show } from "solid-js";
import type { StartupSnapshot } from "./startup_coordinator";

export type StartupOverlayProps = { state: StartupSnapshot };

export const StartupOverlay = (props: StartupOverlayProps) => {
  const state = () => props.state;

  return (
    <div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-end bg-gray-950/55 px-4 sm:px-8">
      <div class="w-full max-w-sm border border-gray-700/80 bg-gray-950/90 p-3 font-mono text-xs text-gray-300 shadow-2xl backdrop-blur-sm">
        <div class="mb-2 flex items-center justify-between border-b border-gray-800 pb-2">
          <span class="text-green-400">Starting rust-analyzer</span>
          <span class="text-gray-500">{state().phase}</span>
        </div>
        <div class="space-y-1.5">
          <For each={state().tasks}>
            {(task) => (
              <div class="grid grid-cols-[1rem_1fr_auto] items-center gap-2">
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
              </div>
            )}
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
