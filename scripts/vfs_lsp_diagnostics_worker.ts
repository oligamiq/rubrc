import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "../page/src/worker_process/vfs_bindings/common.ts";
import { custom_instantiate } from "../page/src/worker_process/vfs_bindings/inst.ts";
import { dispatchSpecialInput } from "../page/src/worker_process/lsp_dispatch.ts";
import { prebindWasiMemory } from "../page/src/worker_process/prebind_wasi_memory.ts";
import { createRustAnalyzerConfigurationState } from "../page/src/rust_lsp_config.ts";
import {
  encodeLspMessage,
  isLspSession,
  LSP_SESSION_ID,
  LspFrameDecoder,
  toLspBytes,
} from "../page/src/lsp_protocol.ts";
import {
  STARTUP_SYSROOT_TIMEOUT_MS,
  waitForStartupSysroots,
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

type DiagnosticsResult = {
  ok: boolean;
  detail: string;
  cargoCallsBeforeInit?: number;
};

type HostCallbackMessage = {
  name?: string;
  args?: Record<string, unknown>;
};

function asHostCallbackMessage(value: unknown): HostCallbackMessage {
  if (typeof value !== "object" || value === null) return {};
  return value as HostCallbackMessage;
}

type WorkerScope = {
  onmessage: ((event: { data: any }) => void | Promise<void>) | null;
  postMessage(message: unknown): void;
};

const workerScope = globalThis as unknown as WorkerScope;
workerScope.onmessage = async (event) => {
  const trace = new VfsDebugTraceCollector();
  let tracePump: ReturnType<typeof startVfsDebugTracePump> | undefined;
  let lspOutputPort: MessagePort | undefined;
  let result: DiagnosticsResult = {
    ok: false,
    detail: "diagnostics worker did not produce a result",
  };
  let cargoCallsBeforeInit: number | undefined;
  let messages: any[] = [];
  let crateGraph = "";
  const stopAfterHostCargoOutcome =
    event.data.stopAfterHostCargoOutcome === true;
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

    messages = [];
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
      (index, rawMessage: unknown) => {
        const message = asHostCallbackMessage(rawMessage);
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
    const analyzerConfiguration = createRustAnalyzerConfigurationState();

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
      timeoutMs = 90_000,
    ): Promise<any> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (let index = messages.length - 1; index >= 0; index--) {
          const message = messages[index];
          if (
            message.method === "workspace/configuration" &&
            message.id !== undefined
          ) {
            messages.splice(index, 1);
            send({
              jsonrpc: "2.0",
              id: message.id,
              result: analyzerConfiguration.response(message.params.items),
            });
          }
        }
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
        initializationOptions: analyzerConfiguration.initializationOptions(),
      },
    });
    await waitForMessage(
      (message) => message.id === 1 && message.result?.capabilities,
      "initialize response",
    );
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    cargoCallsBeforeInit = hostCallId;
    const rustSrcResult = await waitForStartupSysroots(root, {
      timeoutMs: STARTUP_SYSROOT_TIMEOUT_MS,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });
    if (!rustSrcResult.ok) throw new Error(rustSrcResult.error);

    analyzerConfiguration.activateProject();
    send({
      jsonrpc: "2.0",
      method: "workspace/didChangeConfiguration",
      params: {
        settings: analyzerConfiguration.response([
          { section: "rust-analyzer" },
        ])[0],
      },
    });
    if (stopAfterHostCargoOutcome) {
      const outcomeDeadline = Date.now() + 90_000;
      while (Date.now() < outcomeDeadline) {
        const snapshot = trace.snapshot().trace;
        const requests = Array.from(
          snapshot.matchAll(/\[vfs-debug\] host-cargo:request id=(\d+)/g),
        );
        const request = requests.find(
          (match) => Number(match[1]) > (cargoCallsBeforeInit ?? 0),
        );
        if (request) {
          const callId = Number(request[1]);
          const callStart = request.index ?? 0;
          const callTrace = snapshot.slice(callStart);
          const outcome = callTrace.match(
            new RegExp(
              `\\[vfs-debug\\] (host-cargo:(?:response|reject) id=${callId} status=-?\\d+)`,
            ),
          );
          if (outcome) {
            result = {
              ok: true,
              detail: `host-cargo focused host outcome id=${callId}: ${
                outcome[1]
              }`,
              cargoCallsBeforeInit,
            };
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("timed out waiting for host-run result outcome");
    }
    const graphDeadline = Date.now() + 90_000;
    let graphRequestId = 2;
    const graphHasNode = (label: string) =>
      new RegExp(`\\blabel\\s*=\\s*"${label}"`).test(crateGraph);
    while (Date.now() < graphDeadline) {
      const requestId = graphRequestId++;
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "rust-analyzer/viewCrateGraph",
        params: { full: true },
      });
      const response = await waitForMessage(
        (message) => message.id === requestId,
        "full crate graph",
      );
      crateGraph = typeof response.result === "string" ? response.result : "";
      if (
        graphHasNode("rubrc_main") &&
        graphHasNode("core") &&
        graphHasNode("alloc") &&
        graphHasNode("std")
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (
      !graphHasNode("rubrc_main") ||
      !graphHasNode("core") ||
      !graphHasNode("alloc") ||
      !graphHasNode("std")
    ) {
      throw new Error(`incomplete crate graph: ${crateGraph}`);
    }

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
    const definitionText =
      "fn main() { let values: Vec<i32> = Vec::new(); let _ = values.len(); }\n";
    send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 0 },
          },
          rangeLength: 13,
          text: definitionText,
        }],
      },
    });
    const definitionRequestId = graphRequestId++;
    send({
      jsonrpc: "2.0",
      id: definitionRequestId,
      method: "textDocument/definition",
      params: {
        textDocument: { uri },
        position: { line: 0, character: definitionText.indexOf("Vec") + 1 },
      },
    });
    const definitionResponse = await waitForMessage(
      (message) => message.id === definitionRequestId,
      "Vec definition",
      180_000,
    );
    if (
      !JSON.stringify(definitionResponse.result).includes(
        "/library/alloc/src/vec/mod.rs",
      )
    ) {
      throw new Error(
        `Vec definition did not resolve into rust-src: ${
          JSON.stringify(definitionResponse.result)
        }`,
      );
    }

    const completionText =
      "fn main() { let mut values: Vec<i32> = Vec::new(); values.pu }\n";
    send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 3 },
        contentChanges: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 0 },
          },
          rangeLength: definitionText.length,
          text: completionText,
        }],
      },
    });
    const completionRequestId = graphRequestId++;
    send({
      jsonrpc: "2.0",
      id: completionRequestId,
      method: "textDocument/completion",
      params: {
        textDocument: { uri },
        position: {
          line: 0,
          character: completionText.indexOf("values.pu") + "values.pu".length,
        },
        context: { triggerKind: 1 },
      },
    });
    const completionResponse = await waitForMessage(
      (message) => message.id === completionRequestId,
      "Vec method completion",
    );
    const completionItems = Array.isArray(completionResponse.result)
      ? completionResponse.result
      : completionResponse.result?.items ?? [];
    if (!completionItems.some((item: any) => item.label === "push")) {
      throw new Error(
        `Vec completion did not include push: ${
          JSON.stringify(completionResponse.result)
        }`,
      );
    }

    for (let index = messages.length - 1; index >= 0; index--) {
      if (isPublication(messages[index])) messages.splice(index, 1);
    }
    const invalidText = 'fn main() { let value: i32 = "wrong"; }\n';
    send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 4 },
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
            rangeLength: completionText.length,
            text: invalidText,
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
        textDocument: { uri, version: 5 },
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
            rangeLength: invalidText.length,
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
      cargoCallsBeforeInit,
    };
  } catch (error) {
    const recentMessages = messages.slice(-40).map((message) => ({
      id: message.id,
      method: message.method,
      params: message.method === "experimental/serverStatus" ||
          message.method === "window/showMessage" ||
          message.method === "window/logMessage"
        ? message.params
        : undefined,
      error: message.error,
    }));
    const errorDetail = error instanceof Error
      ? (error.stack ?? error.message)
      : String(error);
    result = {
      ok: false,
      detail:
        `${errorDetail}\ncrate graph: ${crateGraph}\nrecent LSP messages: ${
          JSON.stringify(recentMessages)
        }`,
      cargoCallsBeforeInit,
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
    workerScope.postMessage({
      ...result,
      trace: traceSnapshot.trace,
      traceDroppedChunks: traceSnapshot.droppedChunks,
    });
  }
};
