/* @refresh reload */
import "./index.css";
import { render } from "solid-js/web";

import App from "./App";
import { hello } from '../../lib/src/index';

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

hello();

// biome-ignore lint/style/noNonNullAssertion: <explanation>
render(() => <App />, root!);
