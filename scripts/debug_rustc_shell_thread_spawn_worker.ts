import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "../page/src/worker_process/vfs_bindings/common.ts";
import { custom_instantiate } from "../page/src/worker_process/vfs_bindings/inst.ts";
import { requireRustcLinkerOutput } from "./vfs_debug_config.ts";

await set_fake_worker();

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const EVENT_TYPE_WRITE_FILE = 7;
const EVENT_TYPE_DEBUG_RESERVE_SELF = 1008;
const EVENT_TYPE_DEBUG_RESERVE_RUSTC = 1009;

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
    memoryReserveCount,
    memoryReservePages,
    rustcMemoryReservePages,
    skipMemoryReserve,
    sourceCode,
  } = event.data;
  let output = "";
  let threadSpawnCount = 0;

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

    const threadSpawn = animal.wasiThreadImport["thread-spawn"].bind(
      animal.wasiThreadImport,
    );
    const wasiThreadImport = {
      ...animal.wasiThreadImport,
      "thread-spawn": (startArg: number): number => {
        const index = ++threadSpawnCount;
        output += `[host-thread-spawn] #${index}:enter start_arg=${startArg}\n`;
        const tid = threadSpawn(startArg);
        output += `[host-thread-spawn] #${index}:return tid=${tid}\n`;
        return tid;
      },
    };

    const root = await custom_instantiate(
      wasm,
      animal.wasiImport,
      wasiThreadImport,
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
          return {};
        }
      },
    );

    animal.start(root);
    root.debugSetTerminalCapture(true);

    const memory = animal.get_share_memory().memory;
    const drainOutput = () => {
      const len = root.debugTerminalOutputLen();
      if (len === 0) return "";
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

    const writeReq = JSON.stringify({
      path: "/src/main.rs",
      content: sourceCode,
    });
    const writeBytes = encoder.encode(writeReq);
    const writePtr = root.allocBuf(writeBytes.length);
    new Uint8Array(memory.buffer).set(writeBytes, writePtr);
    root.dispatch(
      0xeeeeeeee,
      EVENT_TYPE_WRITE_FILE,
      writePtr,
      writeBytes.length,
    );
    root.freeBuf(writePtr, writeBytes.length);
    output += drainOutput();

    for (let index = 0; index < commands.length; index++) {
      const command = commands[index].join(" ");
      let runOutput = "";
      output += `\n[vfs-debug-driver] run:${
        index + 1
      }/${commands.length}:enter ${command}\n`;

      if (!skipMemoryReserve) {
        root.dispatch(
          0,
          EVENT_TYPE_DEBUG_RESERVE_SELF,
          memoryReserveCount,
          memoryReservePages,
        );
        root.dispatch(
          0,
          EVENT_TYPE_DEBUG_RESERVE_RUSTC,
          memoryReserveCount,
          rustcMemoryReservePages,
        );
        output += drainOutput();
      }

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

      if (command === "rustc" || command.startsWith("rustc ")) {
        requireRustcLinkerOutput({
          command,
          runIndex: index + 1,
          totalRuns: commands.length,
          output: runOutput,
        });
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
        ? error.stack ?? error.message
        : String(error),
    });
  }
};
