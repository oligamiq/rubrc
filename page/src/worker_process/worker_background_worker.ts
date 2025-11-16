import { wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";
// @ts-ignore
import run from "../../node_modules/@oligami/browser_wasi_shim-threads/dist/worker_background_worker.min.js";

wait_async_polyfill();

run();
