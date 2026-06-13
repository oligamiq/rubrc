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

globalThis.onmessage = async (event) => {
  const {
    wasiRef,
    command,
    threads,
    timeoutMs,
  }: {
    wasiRef: unknown;
    command: string[];
    threads: number;
    timeoutMs: number;
  } = event.data;
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
            initial: 1031,
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
      (_index, message: { name?: string }) => {
        throw new Error(
          `unexpected host callback: ${message?.name ?? "unknown"}`,
        );
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

    const promptDeadline = Date.now() + timeoutMs;
    while (Date.now() < promptDeadline && !output.includes(" $ ")) {
      output += drainOutput();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!output.includes(" $ ")) {
      throw new Error(`initial shell prompt timed out after ${timeoutMs}ms`);
    }

    for (const character of `${command.join(" ")}\r`) {
      root.dispatch(sessionId, 0, character.codePointAt(0) ?? 0, 0);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      output += drainOutput();
      if (output.includes("[vfs-debug] command:return")) {
        root.dispatch(sessionId, 5, 0, 0);
        root.debugSetTerminalCapture(false);
        globalThis.postMessage({ ok: true, output });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    output += drainOutput();
    globalThis.postMessage({
      ok: false,
      output,
      error: `command timed out after ${timeoutMs}ms`,
    });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      output,
      error: error instanceof Error
        ? error.stack ?? error.message
        : String(error),
    });
  }
};
