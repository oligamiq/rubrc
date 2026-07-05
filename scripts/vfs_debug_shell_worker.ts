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

globalThis.onmessage = async (event) => {
  const {
    wasiRef,
    commands,
    threads,
    timeoutMs,
    preloads = [],
    lspInputBytes = [],
  }: {
    wasiRef: unknown;
    commands: string[][];
    threads: number;
    timeoutMs: number;
    preloads?: { path: string; content: string }[];
    lspInputBytes?: number[];
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
      (_index, message: { name?: string }) => {
        if (message.name === "terminalWrite") {
          return {};
        } else if (message.name === "sysrootStartFetch") {
          return {};
        } else if (message.name === "sysrootGetNextFileMeta") {
          return { has_file: false, name_len: 0, data_len: 0 };
        } else if (message.name === "sysrootReadFileName") {
          return { name: [] };
        } else if (message.name === "sysrootReadFileChunk") {
          return { chunk: [] };
        } else {
          throw new Error(
            `unexpected host callback: ${message?.name ?? "unknown"}`,
          );
        }
      },
    );

    animal.start(root);
    root.debugSetTerminalCapture(true);

    const memory = animal.get_share_memory().memory;
    const dispatchBytes = (sessionId: number, eventType: number, bytes: Uint8Array) => {
      const ptr = root.allocBuf(bytes.length);
      try {
        new Uint8Array(memory.buffer).set(bytes, ptr);
        root.dispatch(sessionId, eventType, ptr, bytes.length);
      } finally {
        root.freeBuf(ptr, bytes.length);
      }
    };
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

    for (const preload of preloads) {
      dispatchBytes(0, 7, new TextEncoder().encode(JSON.stringify(preload)));
    }

    if (lspInputBytes.length > 0) {
      dispatchBytes(0xffffffff, 6, new Uint8Array(lspInputBytes));
    }

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

    for (let index = 0; index < commands.length; index++) {
      const command = commands[index].join(" ");
      let runOutput = "";
      output += `\n[vfs-debug-driver] run:${
        index + 1
      }/${commands.length}:enter ${command}\n`;

      for (const character of `${command}\r`) {
        root.dispatch(sessionId, 0, character.codePointAt(0) ?? 0, 0);
      }

      const deadline = performance.now() + timeoutMs;
      let cmdDone = false;
      while (performance.now() < deadline) {
        const chunk = drainOutput();
        output += chunk;
        runOutput += chunk;
        if (hasReturnedToPrompt(runOutput)) {
          cmdDone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      if (!cmdDone) {
        output += drainOutput();
        throw new Error(
          `command timed out after ${timeoutMs}ms on run ${
            index + 1
          }/${commands.length}: ${command}`,
        );
      }

      output += `[vfs-debug-driver] run:${
        index + 1
      }/${commands.length}:return ${command}\n`;
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
