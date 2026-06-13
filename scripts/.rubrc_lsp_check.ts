import { ConsoleStdout, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";

const farm = new WASIFarm(
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((message) => console.log(`[stdout] ${message}`)),
  ConsoleStdout.lineBuffered((message) => console.error(`[stderr] ${message}`)),
  [],
);

const worker = new Worker(
  new URL("./.rubrc_lsp_check_worker.ts", import.meta.url),
  { type: "module" },
);

const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
  const timer = setTimeout(() => {
    worker.terminate();
    resolve({ ok: false, detail: "timed out after 60 seconds" });
  }, 60_000);

  worker.onmessage = (event) => {
    clearTimeout(timer);
    resolve(event.data);
  };
  worker.onerror = (event) => {
    clearTimeout(timer);
    resolve({ ok: false, detail: event.message });
  };
  worker.postMessage({ wasiRef: farm.get_ref() });
});

worker.terminate();
console.log(result.detail);
if (!result.ok) Deno.exit(1);
