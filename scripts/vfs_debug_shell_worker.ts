import {
  WASIFarmAnimal,
  type WASIFarmRefObject,
} from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "../page/src/worker_process/vfs_bindings/common.ts";
import { custom_instantiate } from "../page/src/worker_process/vfs_bindings/inst.ts";
import { isHttpBridgeMessage } from "../lib/src/http_bridge.ts";
import { isChildProcessMessage } from "../lib/src/child_process_bridge.ts";
import { waitForStartupSysroots } from "../page/src/vfs_readiness.ts";

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
  const returnMarker = "[vfs-debug] command:return";
  const returnIndex = output.indexOf(returnMarker);
  return returnIndex !== -1 &&
    output.indexOf(" $ ", returnIndex + returnMarker.length) !== -1;
}

type DebugShellStartMessage = {
  wasiRef: WASIFarmRefObject;
  commands: string[][];
  threads: number;
  timeoutMs: number;
  preloads?: { path: string; content: string }[];
  lspInputBytes?: number[];
  installStartupSysroots?: boolean;
  env?: string[];
  initialInput?: string;
};

type WorkerScope = {
  onmessage:
    | ((event: { data: DebugShellStartMessage }) => void | Promise<void>)
    | null;
  postMessage(message: unknown): void;
};

const workerScope = globalThis as unknown as WorkerScope;
workerScope.onmessage = async (event) => {
  const {
    wasiRef,
    commands,
    threads,
    timeoutMs,
    preloads = [],
    lspInputBytes = [],
    installStartupSysroots = false,
    env = [],
    initialInput = "",
  } = event.data;
  let output = "";
  let terminalOutput = "";
  const terminalDecoder = new TextDecoder();

  try {
    const wasm = await compile("vfs.core.wasm");
    const animal = new WASIFarmAnimal(
      wasiRef,
      ["vfs-debug"],
      [
        `VFS_THREADS=${threads}`,
        "CARGO=cargo",
        ...(installStartupSysroots ? ["VFS_DEBUG_TRACE=1"] : []),
        ...env,
      ],
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
      (_index, rawMessage: unknown) => {
        const message = typeof rawMessage === "object" && rawMessage !== null
          ? rawMessage as { name?: string }
          : {};
        if (
          isHttpBridgeMessage(rawMessage) || isChildProcessMessage(rawMessage)
        ) {
          return animal.call_unknown_fn(_index, rawMessage);
        } else if (message.name === "terminalWrite") {
          if (installStartupSysroots) {
            const args = (rawMessage as { args?: { data?: unknown } }).args;
            const data = Array.isArray(args?.data)
              ? Uint8Array.from(args.data as number[])
              : new Uint8Array();
            terminalOutput += terminalDecoder.decode(data, { stream: true });
          }
          return {};
        } else if (
          message.name === "sysrootStartFetch" ||
          message.name === "sysrootArchiveGetMeta" ||
          message.name === "sysrootReadArchiveChunk"
        ) {
          if (installStartupSysroots) {
            return animal.call_unknown_fn(_index, rawMessage);
          }
          if (message.name === "sysrootArchiveGetMeta") {
            return { has_archive: false, data_len: 0 };
          }
          return message.name === "sysrootReadArchiveChunk"
            ? { chunk: [] }
            : {};
        } else {
          throw new Error(
            `unexpected host callback: ${message.name ?? "unknown"}`,
          );
        }
      },
    );

    animal.start(root);
    root.debugSetTerminalCapture(true);
    if (installStartupSysroots) {
      root.dispatch(0, 3, 0, 0);
      const startup = await waitForStartupSysroots(root, {
        timeoutMs,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 25)),
      });
      if (!startup.ok) throw new Error(startup.error);
    }

    const memory = animal.get_share_memory().memory;
    const dispatchBytes = (
      sessionId: number,
      eventType: number,
      bytes: Uint8Array,
    ) => {
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

    const sessionId = installStartupSysroots ? 0 : 1;
    if (initialInput !== "") {
      dispatchBytes(sessionId, 4, new TextEncoder().encode(initialInput));
    }
    if (!installStartupSysroots) {
      root.dispatch(sessionId, 3, 0, 0);
    }

    if (installStartupSysroots) {
      // Startup readiness proves session 0 processed both bootstrap commands.
      // Its earlier prompt may have fallen out of the bounded debug capture, so
      // do not use that stale prompt as a second synchronization condition.
      output += drainOutput();
    } else {
      const promptDeadline = performance.now() + timeoutMs;
      while (performance.now() < promptDeadline && !output.includes(" $ ")) {
        output += drainOutput();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!output.includes(" $ ")) {
        throw new Error(`initial shell prompt timed out after ${timeoutMs}ms`);
      }
    }

    for (let index = 0; index < commands.length; index++) {
      const command = commands[index].join(" ");
      let runOutput = "";
      const terminalOutputStart = terminalOutput.length;
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
        const returnedToPrompt = installStartupSysroots
          ? runOutput.includes("[vfs-debug] command:return")
          : hasReturnedToPrompt(runOutput);
        if (returnedToPrompt) {
          cmdDone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      if (installStartupSysroots) {
        output += terminalOutput.slice(terminalOutputStart);
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
    workerScope.postMessage({ ok: true, output });
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      output,
      error: error instanceof Error
        ? (error.stack ?? error.message)
        : String(error),
    });
  }
};
