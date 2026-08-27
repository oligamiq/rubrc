/* @refresh reload */
import "./index.css";
import { render } from "solid-js/web";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import { registerWorkspaceFileProvider } from "./workspace_file_provider";
import { workspaceFileSystem } from "./workspace_fs.ts";
import { RuntimeSupervisor } from "./app_runtime.ts";
import { createProductionRuntimeDependencies } from "./production_runtime.ts";
import { mountRuntimeApplication } from "./runtime_entrypoint.ts";
import { RuntimeCreationFailure } from "./RuntimeCreationFailure.tsx";
import { startRustLspClient } from "./rust_lsp_client.ts";
import {
  installRuntimeRemountTestControl,
  recordRuntimeRemountDisposalFailure,
  recordRuntimeRemountPhase,
  recordRuntimeMountFailure,
} from "./lsp_test_api.ts";
import App from "./App.tsx";
import UtilityWorkerPath from "./worker_process/util_cmd.ts?worker&url";
import LifecycleWorkerPath from "./worker_process/lifecycle_worker.ts?worker&url";
import ChildProcessWorkerPath from "./worker_process/vfs_bindings/child_process_worker.ts?worker&url";
import "./monaco_worker";

const REMOUNT_FLUSH_TIMEOUT_MS = 10_000;

registerWorkspaceFileProvider();

// @ts-ignore Monaco's initialized marker is page-global across HMR reloads.
if (!window.__MONACO_VSCODE_INITIALIZED__) {
  // @ts-ignore Monaco's initialized marker is page-global across HMR reloads.
  window.__MONACO_VSCODE_INITIALIZED__ = true;
  const apiWrapper = new MonacoVscodeApiWrapper({
    $type: "extended",
    viewsConfig: { $type: "EditorService" },
    userConfiguration: { json: '{"editor.fontSize": 14}' },
    workspaceConfig: {
      workspaceProvider: {
        trusted: true,
        workspace: {
          workspaceUri: { scheme: "file", authority: "", path: "/" },
        },
        async open() {
          return false;
        },
      },
    },
  });
  await apiWrapper.start();
}

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) {
  throw new Error("Root element not found");
}

const runtimeSupervisor = new RuntimeSupervisor(
  createProductionRuntimeDependencies({
    workspaceFileSystem,
    utilityWorkerUrl: UtilityWorkerPath,
    lifecycleWorkerUrl: LifecycleWorkerPath,
    childProcessWorkerUrl: ChildProcessWorkerPath,
  }),
);

let disposeMountedApp: (() => void) | undefined;
let mountedRuntime: Awaited<ReturnType<typeof runtimeSupervisor.create>> | undefined;
let prepareMountedAppForRemount: (() => Promise<void>) | undefined;

const renderRuntimeFailure = (failure: {
  message: string;
  reloadRequired: boolean;
}) => {
  mountedRuntime = undefined;
  recordRuntimeMountFailure(failure);
  disposeMountedApp = render(
    () => (
      <RuntimeCreationFailure
        failure={failure}
        onReload={() => globalThis.location.reload()}
      />
    ),
    root,
  );
};

const mountGeneration = () =>
  mountRuntimeApplication({
    createRuntime: () => runtimeSupervisor.create(),
    renderApp: (runtime) => {
      mountedRuntime = runtime;
      disposeMountedApp = render(
      () => (
        <App
          runtime={runtime}
          registerRemountPreparation={(prepare) => {
            prepareMountedAppForRemount = prepare;
          }}
          startLspClient={(monaco, model) =>
            startRustLspClient(runtime.lspDependencies, monaco, model)}
        />
      ),
      root,
      );
    },
    renderFailure: (failure) => {
      renderRuntimeFailure(failure);
    },
  });

let remountAdmission = Promise.resolve();
const remountRuntime = (): Promise<void> => {
  const operation = remountAdmission.then(async () => {
    recordRuntimeRemountPhase("disposing");
    try {
      const runtime = mountedRuntime;
      const disposeApp = disposeMountedApp;
      const prepareAppForRemount = prepareMountedAppForRemount;
      mountedRuntime = undefined;
      disposeMountedApp = undefined;
      prepareMountedAppForRemount = undefined;
      let flushError: unknown;
      if (prepareAppForRemount !== undefined) {
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            prepareAppForRemount(),
            new Promise<never>((_, reject) => {
              flushTimer = setTimeout(
                () => reject(new Error("workspace flush timed out before remount")),
                REMOUNT_FLUSH_TIMEOUT_MS,
              );
            }),
          ]);
        } catch (error) {
          flushError = error;
        } finally {
          clearTimeout(flushTimer);
        }
      }
      disposeApp?.();
      if (runtime !== undefined) {
        try {
          await runtime.dispose();
        } catch (error) {
          recordRuntimeRemountDisposalFailure(error);
          // Supervisor admission below exposes quarantine as reload-required.
        }
      }
      if (flushError !== undefined) {
        recordRuntimeRemountPhase("failed", flushError);
        renderRuntimeFailure({
          message: flushError instanceof Error
            ? flushError.message
            : String(flushError),
          reloadRequired: runtime?.phase === "reload-required",
        });
        return;
      }
      recordRuntimeRemountPhase("mounting");
      await mountGeneration();
      recordRuntimeRemountPhase("mounted");
    } catch (error) {
      recordRuntimeRemountPhase("failed", error);
      throw error;
    }
  });
  remountAdmission = operation.catch(() => undefined);
  return operation;
};

installRuntimeRemountTestControl(remountRuntime);
await mountGeneration();
