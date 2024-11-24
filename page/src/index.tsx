/* @refresh reload */
import "./index.css";
import { render } from "solid-js/web";

import App from "./App";
import { gen_ctx } from "./ctx";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

const ctx = gen_ctx();

// create worker
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

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
