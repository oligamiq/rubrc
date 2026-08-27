import type { AppRuntime } from "./app_runtime.ts";
import { ReloadRequiredError } from "./app_runtime.ts";

export type RuntimeCreationFailureModel = {
  message: string;
  reloadRequired: boolean;
};

const errorMessage = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown runtime creation failure";
  }
};

export async function mountRuntimeApplication<TRuntime extends AppRuntime>(dependencies: {
  createRuntime(): Promise<TRuntime>;
  renderApp(runtime: TRuntime): unknown | PromiseLike<unknown>;
  renderFailure(failure: RuntimeCreationFailureModel): void;
  reportCleanupFailure?(error: unknown): void;
}): Promise<void> {
  let runtime: TRuntime;
  try {
    runtime = await dependencies.createRuntime();
  } catch (error) {
    dependencies.renderFailure({
      message: errorMessage(error),
      reloadRequired: error instanceof ReloadRequiredError,
    });
    return;
  }

  try {
    await dependencies.renderApp(runtime);
  } catch (error) {
    try {
      await runtime.dispose();
    } catch (cleanupError) {
      try {
        if (dependencies.reportCleanupFailure !== undefined) {
          dependencies.reportCleanupFailure(cleanupError);
        } else {
          console.error(
            "Runtime cleanup after render failure failed",
            cleanupError,
          );
        }
      } catch {
        // Cleanup reporting cannot suppress the visible render failure.
      }
    }
    dependencies.renderFailure({
      message: errorMessage(error),
      reloadRequired: error instanceof ReloadRequiredError ||
        runtime.phase === "reload-required",
    });
  }
}
