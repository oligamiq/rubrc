/* @refresh reload */
import "./index.css";
import { render } from "solid-js/web";

import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import "vscode/localExtensionHost";
import "@codingame/monaco-vscode-rust-default-extension";
import "@codingame/monaco-vscode-theme-defaults-default-extension";

console.log("[Index] Initializing MonacoVscodeApiWrapper...");
const apiWrapper = new MonacoVscodeApiWrapper({
  $type: "extended",
  viewsConfig: { $type: "EditorService" },
  userConfiguration: {
    json: "{\"editor.fontSize\": 14}"
  },
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
console.log("[Index] MonacoVscodeApiWrapper started.");

const { default: App } = await import("./App");
const { gen_ctx } = await import("./ctx");
const { default: MainWorkerPath } = await import("./worker_process/worker?worker&url");
const { parser_setup } = await import("./cmd_parser");
await import("./monaco_worker");
const { compile_and_run_setup } = await import("./compile_and_run");

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

const ctx = gen_ctx();

// create worker
const worker = new Worker(MainWorkerPath, { type: "module" });

parser_setup(ctx);
compile_and_run_setup(ctx);

// send message to worker
worker.postMessage({ ctx });

render(
  () => (
    <App
      ctx={ctx}
      callback={(wasi_ref) =>
        worker.postMessage({
          wasi_ref,
        })
      }
    />
  ),
  // biome-ignore lint/style/noNonNullAssertion: <explanation>
  root!,
);
