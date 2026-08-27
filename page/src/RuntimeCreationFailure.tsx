import type { RuntimeCreationFailureModel } from "./runtime_entrypoint.ts";

export function RuntimeCreationFailure(props: {
  failure: RuntimeCreationFailureModel;
  onReload(): void;
}) {
  return (
    <main
      role="alert"
      id="runtime-creation-failure"
      class="min-h-[100dvh] bg-gray-950 px-6 py-16 text-gray-100"
    >
      <div class="mx-auto max-w-xl rounded-lg border border-red-900/70 bg-gray-900 p-6 shadow-lg">
        <h1 class="text-xl font-semibold text-red-300">
          {props.failure.reloadRequired
            ? "Reload required"
            : "Runtime failed to start"}
        </h1>
        <p class="mt-3 text-sm text-gray-300">{props.failure.message}</p>
        {props.failure.reloadRequired && (
          <button
            type="button"
            class="mt-6 rounded-lg bg-green-600/90 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-500 focus:outline-none focus:ring-2 focus:ring-green-500/60"
            onClick={props.onReload}
          >
            Reload page
          </button>
        )}
      </div>
    </main>
  );
}
