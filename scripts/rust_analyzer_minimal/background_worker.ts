import { wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";
import run from "@oligami/browser_wasi_shim-threads/worker_background_worker";

wait_async_polyfill();
run();
