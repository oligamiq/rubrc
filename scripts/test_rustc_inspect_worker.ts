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

function hasReturnedToPrompt(output: string): boolean {
  const returnIndex = output.indexOf("[vfs-debug] command:return");
  return returnIndex !== -1 && output.indexOf(" $ ", returnIndex) !== -1;
}

const EVENT_TYPE_WRITE_FILE = 7;
const EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007;

globalThis.onmessage = async (event) => {
  const { wasiRef, commands, threads, timeoutMs, sourceCode } = event.data;
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
        } else if (unknown.name === "sysrootArchiveGetMeta") {
          return { has_archive: false, data_len: 0 };
        } else if (unknown.name === "sysrootReadArchiveChunk") {
          return { chunk: [] };
        } else if (unknown.name === "terminalWrite") {
          return {};
        } else {
          return {};
        }
      },
    );

    animal.start(root);
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

    const sessionId = 1;
    root.dispatch(sessionId, 3, 0, 0);

    const promptDeadline = performance.now() + timeoutMs;
    while (performance.now() < promptDeadline && !output.includes(" $ ")) {
      output += drainOutput();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!output.includes(" $ ")) {
      throw new Error(`initial shell prompt timed out after ${timeoutMs}ms`);
    }

    output += drainOutput();

    const writeReq = JSON.stringify({
      path: "/src/main.rs",
      content: sourceCode,
    });
    const writeBytes = new TextEncoder().encode(writeReq);
    const writePtr = root.allocBuf(writeBytes.length);
    new Uint8Array(memory.buffer).set(writeBytes, writePtr);
    root.dispatch(0xeeeeeeee, EVENT_TYPE_WRITE_FILE, writePtr, writeBytes.length);
    root.freeBuf(writePtr, writeBytes.length);

    const displayCmd = commands[0].join(" ");
    for (let run = 0; run < commands.length; run++) {
      output += `\n[vfs-debug-driver] run:${
        run + 1
      }/${commands.length}:enter ${displayCmd}\n`;

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
          `rustc run ${run + 1}/${commands.length} timed out`,
        );
      }
      output += `[vfs-debug-driver] run:${
        run + 1
      }/${commands.length}:return ${displayCmd}\n`;
    }

    root.dispatch(sessionId, 5, 0, 0);
    root.debugSetTerminalCapture(false);
    globalThis.postMessage({ ok: true, output });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      output,
      error: error instanceof Error
        ? (error.stack ?? error.message)
        : String(error),
    });
  }
};
