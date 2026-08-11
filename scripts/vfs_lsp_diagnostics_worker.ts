import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "../page/src/worker_process/vfs_bindings/common.ts";
import { custom_instantiate } from "../page/src/worker_process/vfs_bindings/inst.ts";
import { dispatchSpecialInput } from "../page/src/worker_process/lsp_dispatch.ts";
import { prebindWasiMemory } from "../page/src/worker_process/prebind_wasi_memory.ts";
import {
  encodeLspMessage,
  isLspSession,
  LSP_SESSION_ID,
  LspFrameDecoder,
  toLspBytes,
} from "../page/src/lsp_protocol.ts";
import {
  RUST_SRC_BOOTSTRAP_TIMEOUT_MS,
  waitForRustSrcBootstrap,
} from "../page/src/vfs_readiness.ts";
import {
  startVfsDebugTracePump,
  traceVfsHostCall,
  VfsDebugTraceCollector,
  vfsDebugTraceErrorName,
} from "../page/src/vfs_debug_trace.ts";

await set_fake_worker();

const bindingsDir = new URL(
  "../page/src/worker_process/vfs_bindings/",
  import.meta.url,
);

globalThis.onmessage = async (event) => {
  const trace = new VfsDebugTraceCollector();
  let tracePump: ReturnType<typeof startVfsDebugTracePump> | undefined;
  let lspOutputPort: MessagePort | undefined;
  let result = {
    ok: false,
    detail: "diagnostics worker did not produce a result",
  };
  try {
    const wasm = await WebAssembly.compile(
      await Deno.readFile(new URL("vfs.core.wasm", bindingsDir)),
    );
    const animal = new WASIFarmAnimal(
      event.data.wasiRef,
      ["vfs-lsp-diagnostics"],
      ["VFS_THREADS=8", "RUST_BACKTRACE=full", "VFS_DEBUG_TRACE=1"],
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

    const messages: any[] = [];
    const decoder = new LspFrameDecoder();
    const receiveTerminalWrite = (args: {
      session_id: number;
      data: unknown;
    }) => {
      const bytes = toLspBytes(args.data);
      if (isLspSession(args.session_id)) {
        const decoded = decoder.push(bytes);
        messages.push(...decoded);
      }
    };
    lspOutputPort = event.data.lspOutputPort as MessagePort;
    lspOutputPort.onmessage = (outputEvent) => {
      receiveTerminalWrite(outputEvent.data);
    };
    const sharedMemory = animal.get_share_memory();
    let hostCallId = 0;
    prebindWasiMemory(animal, sharedMemory.memory);
    const root = await custom_instantiate(
      wasm,
      animal.wasiImport,
      animal.wasiThreadImport,
      sharedMemory,
      (index, message: { name?: string; args?: Record<string, unknown> }) => {
        if (message.name === "terminalWrite") {
          const args = message.args as { session_id: number; data: unknown };
          receiveTerminalWrite(args);
          return;
        }
        if (message.name === "hostRunCargo") {
          return traceVfsHostCall(
            ++hostCallId,
            "hostRunCargo",
            (line) => trace.push(line),
            () => animal.call_unknown_fn(index, message),
          );
        }
        return animal.call_unknown_fn(index, message);
      },
    );
    tracePump = startVfsDebugTracePump({
      root,
      memory: sharedMemory.memory,
      emit: (chunk) => trace.push(chunk),
    });
    animal.start(root);

    root.dispatch(0, 3, 0, 0);
    root.dispatch(0, 1, 100, 100);
    const rustSrcResult = await waitForRustSrcBootstrap(root, {
      timeoutMs: RUST_SRC_BOOTSTRAP_TIMEOUT_MS,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });
    if (!rustSrcResult.ok) throw new Error(rustSrcResult.error);

    const send = (message: unknown) => {
      const bytes = encodeLspMessage(message);
      if (
        !dispatchSpecialInput(root, sharedMemory.memory, {
          sessionId: LSP_SESSION_ID,
          data: bytes,
        })
      ) {
        throw new Error(
          "LSP input was not handled by the supported dispatcher",
        );
      }
    };

    const waitForMessage = async (
      predicate: (message: any) => boolean,
      description: string,
    ): Promise<any> => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for ${description}`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: "file:///",
        capabilities: { textDocument: { publishDiagnostics: {} } },
        initializationOptions: {
          cargo: { sysroot: "/sysroot", buildScripts: { enable: false } },
          linkedProjects: [
            {
              sysroot: "/sysroot",
              sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
              sysroot_project: { crates: [] },
              crates: [
                {
                  root_module: "/src/main.rs",
                  edition: "2021",
                  deps: [],
                },
              ],
            },
          ],
          procMacro: { enable: false },
          checkOnSave: { enable: false },
          cachePriming: { enable: false },
        },
      },
    });
    await waitForMessage(
      (message) => message.id === 1 && message.result?.capabilities,
      "initialize response",
    );
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    const uri = "file:///src/main.rs";
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: "rust",
          version: 1,
          text: "fn main() {}\n",
        },
      },
    });
    const isPublication = (message: any) =>
      message.method === "textDocument/publishDiagnostics" &&
      message.params?.uri === uri;
    await waitForMessage(
      (message) =>
        isPublication(message) && message.params.diagnostics.length === 0,
      "initial valid Rust diagnostics",
    );

    for (let index = messages.length - 1; index >= 0; index--) {
      if (isPublication(messages[index])) messages.splice(index, 1);
    }
    send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
            rangeLength: 13,
            text: 'fn main() { let value: i32 = "wrong"; }\n',
          },
        ],
      },
    });
    await waitForMessage(
      (message) =>
        isPublication(message) &&
        message.params.diagnostics.some(
          (diagnostic: any) =>
            diagnostic.severity === 1 &&
            diagnostic.source === "rust-analyzer" &&
            diagnostic.message.includes("i32") &&
            diagnostic.message.includes("str"),
        ),
      "semantic Rust diagnostic",
    );

    for (let index = messages.length - 1; index >= 0; index--) {
      if (isPublication(messages[index])) messages.splice(index, 1);
    }
    send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 3 },
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
            rangeLength: 40,
            text: "fn main() {}\n",
          },
        ],
      },
    });
    await waitForMessage(
      (message) =>
        isPublication(message) &&
        !message.params.diagnostics.some(
          (diagnostic: any) => diagnostic.severity === 1,
        ),
      "cleared Rust diagnostic",
    );
    result = {
      ok: true,
      detail: "rust-analyzer published and cleared diagnostics",
    };
  } catch (error) {
    result = {
      ok: false,
      detail:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  } finally {
    try {
      tracePump?.stop();
    } catch (stopError) {
      trace.push(
        `trace-stop phase=reject error=${vfsDebugTraceErrorName(stopError)}\n`,
      );
    }
    lspOutputPort?.close();
    const traceSnapshot = trace.snapshot();
    globalThis.postMessage({
      ...result,
      trace: traceSnapshot.trace,
      traceDroppedChunks: traceSnapshot.droppedChunks,
    });
  }
};
