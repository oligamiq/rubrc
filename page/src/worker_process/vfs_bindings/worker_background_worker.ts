import { wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";
// @ts-ignore
import run from "@oligami/browser_wasi_shim-threads/worker_background_worker";

import { set_fake_worker } from "./common.ts";

await set_fake_worker();

wait_async_polyfill();

run();