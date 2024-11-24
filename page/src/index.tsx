/* @refresh reload */
import "./index.css";
import { render } from "solid-js/web";

import App from "./App";
import { gen_ctx } from "./ctx";
import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import MainWorker from "./worker?worker";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

const ctx = gen_ctx();

// create worker
const worker = new MainWorker();

const waiter = new SharedObject(
  {
    rustc: () => {
      const rustc = new SharedObjectRef(ctx.rustc_id).proxy<
        (...string) => void
      >();
      const terminal = new SharedObjectRef(ctx.terminal_id).proxy<
        (string) => void
      >();
      terminal("rustc -h\r\n");
      rustc("-h");
    },
  },
  ctx.waiter_id,
);

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
