/* @refresh reload */
import "./index.css";
import { render } from "solid-js/web";

import App from "./App";
import { gen_ctx } from "./ctx";
import MainWorker from "./worker_process/worker?worker";
import { parser_setup } from "./cmd_parser";
import "./monaco_worker";
import { compile_and_run_setup } from "./compile_and_run";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

const ctx = gen_ctx();

// create worker
const worker = new MainWorker();

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
