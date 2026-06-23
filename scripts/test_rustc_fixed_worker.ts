import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "../page/src/worker_process/vfs_bindings/common.ts";
import { custom_instantiate } from "../page/src/worker_process/vfs_bindings/inst.ts";

await set_fake_worker();

const decoder = new TextDecoder();
const bindingsDir = new URL(
  "../page/src/worker_process/vfs_bindings/",
  import.meta.url,
);

async function compile(filename: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(
    await Deno.readFile(new URL(filename, bindingsDir)),
  );
}

const EVENT_TYPE_WRITE_FILE = 7;
const EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007;
const RUNS = 2;

globalThis.onmessage = async (event) => {
  const { wasiRef, threads, timeoutMs, sourceCode } = event.data;
  let output = "";

  try {
    const wasm = await compile("vfs.core.wasm");
    const animal = new WASIFarmAnimal(
      wasiRef,
      ["vfs-debug"],
      [`VFS_THREADS=${threads}`],
      {
        can_thread_spawn: true,
        thread_spawn_worker_url: new URL("thread_spawn.ts", bindingsDir).href,
        thread_spawn_wasm: wasm,
        worker_background_worker_url: new URL(
          "worker_background_worker.ts",
          bindingsDir,
        ).href,
        share_memory: {
          memory: new WebAssembly.Memory({
            initial: 1032,
            maximum: 32775,
            shared: true,
          }),
        },
      },
    );

    await animal.wait_worker_background_worker();
    const root = await custom_instantiate(
      wasm,
      animal.wasiImport,
      animal.wasiThreadImport,
      animal.get_share_memory(),
      (_index, unknown: { name?: string; args?: any }) => {
        if (unknown.name === "sysrootStartFetch") {
          return {};
        } else if (unknown.name === "sysrootGetNextFileMeta") {
          return { has_file: false, name_len: 0, data_len: 0 };
        } else if (unknown.name === "sysrootReadFileName") {
          return { name: [] };
        } else if (unknown.name === "sysrootReadFileChunk") {
          return { chunk: [] };
        } else if (unknown.name === "terminalWrite") {
          return {};
        } else {
          return {};
        }
      },
    );

    console.log("worker ready, starting...");

    animal.start(root);

    console.log("custom instantiate...");

    root.debugSetTerminalCapture(true);

    const memory = animal.get_share_memory().memory;
    const drainOutput = () => {
      const len = root.debugTerminalOutputLen();
      if (len === 0) {
        return "";
      }
      const ptr = root.allocBuf(len);
      try {
        const read = root.debugReadTerminalOutput(ptr, len);
        return decoder.decode(
          new Uint8Array(memory.buffer, ptr, read).slice(),
          { stream: true },
        );
      } finally {
        root.freeBuf(ptr, len);
      }
    };

    console.log("system ready, writing source code...");

    const writeReq = JSON.stringify({
      path: "/src/main.rs",
      content: sourceCode,
    });
    const writeBytes = new TextEncoder().encode(writeReq);
    const writePtr = root.allocBuf(writeBytes.length);
    new Uint8Array(memory.buffer).set(writeBytes, writePtr);
    root.dispatch(
      0xeeeeeeee,
      EVENT_TYPE_WRITE_FILE,
      writePtr,
      writeBytes.length,
    );
    root.freeBuf(writePtr, writeBytes.length);

    for (let run = 0; run < RUNS; run++) {
      console.log(`run ${run + 1}/${RUNS}`);

      output += `\n[vfs-debug-driver] fixed-run:${run + 1}/${RUNS}:enter\n`;
      root.dispatch(0, EVENT_TYPE_DEBUG_FIXED_RUSTC, run + 1, 0);

      const deadline = performance.now() + timeoutMs * 2;
      let runDone = false;
      let runOutput = "";
      while (performance.now() < deadline) {
        const chunk = drainOutput();
        output += chunk;
        runOutput += chunk;
        if (runOutput.includes(`debug-rustc:return run=${run + 1}`)) {
          runDone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!runDone) {
        output += drainOutput();
        throw new Error(
          `fixed rustc run ${run + 1}/${RUNS} timed out after ${timeoutMs * 2}ms`,
        );
      }
      output += `[vfs-debug-driver] fixed-run:${run + 1}/${RUNS}:return\n`;
    }

    root.debugSetTerminalCapture(false);
    globalThis.postMessage({ ok: true, output });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      output,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};
