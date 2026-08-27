import { Fd } from "@bjorn3/browser_wasi_shim";
import {
  wait_async_polyfill,
  WASIFarm,
  type WASIFarmRefObject,
} from "@oligami/browser_wasi_shim-threads";
import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import {
  createChildProcessBridgeOwner,
} from "../../lib/src/child_process_bridge.ts";
import { createHttpBridgeOwner } from "../../lib/src/http_bridge.ts";
import { createCratesProxyFetch } from "../../lib/src/proxy.ts";
import type { AppRuntimeDependencies } from "./app_runtime.ts";
import { gen_ctx } from "./ctx.ts";
import {
  RuntimeCommandService,
  RuntimeParserService,
  type RuntimeSharedObjectFactories,
} from "./runtime_command_service.ts";
import { createRuntimeHostCallbackOwner } from "./runtime_host_callbacks.ts";
import { RuntimeTerminalService } from "./runtime_terminal_service.ts";
import { createRuntimeWorkerHandshake } from "./runtime_worker_protocol.ts";
import type { RuntimeWorkerHandshake } from "./runtime_worker_protocol.ts";
import {
  createSysrootArchiveCallbackAdapter,
  SysrootArchiveStore,
} from "./sysroot_archive_store.ts";
import { createChannelOwner } from "./terminal_channel_lifecycle.ts";
import { routeWasiTerminalWrite } from "./worker_process/lsp_dispatch.ts";
import type { WorkspaceFileSystem } from "./workspace_fs.ts";
import {
  consumeRuntimeDestroyTimeoutForTest,
  recordCargoHostCall,
} from "./lsp_test_api.ts";

wait_async_polyfill();

const sharedObjectFactories: RuntimeSharedObjectFactories = {
  createSharedObject: (value, id) => new SharedObject(value, id),
  createSharedObjectRef: (id) => new SharedObjectRef(id),
};

const bytes = (data: unknown): Uint8Array<ArrayBuffer> => {
  if (data instanceof Uint8Array) return Uint8Array.from(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (
    typeof data === "object" && data !== null && "data" in data &&
    Array.isArray(data.data)
  ) {
    return Uint8Array.from(data.data as number[]);
  }
  return new Uint8Array();
};

const downloadName = (path: string): string => {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || "download";
};

export function wrapRuntimeWorkerHandshakeForTest(
  handshake: RuntimeWorkerHandshake,
  forceTimeout: () => boolean = consumeRuntimeDestroyTimeoutForTest,
): RuntimeWorkerHandshake {
  let disposal: Promise<void> | undefined;
  return {
    initialize: (wasiRef, ctx) => handshake.initialize(wasiRef, ctx),
    dispose() {
      if (disposal !== undefined) return disposal;
      let underlying: Promise<void>;
      try {
        underlying = handshake.dispose();
      } catch (error) {
        underlying = Promise.reject(error);
      }
      void underlying.catch(() => undefined);
      disposal = forceTimeout() ? new Promise<void>(() => {}) : underlying;
      return disposal;
    },
  };
}

type GenerationResources = {
  detached: boolean;
  wasiRef?: WASIFarmRefObject;
  target?: (request: unknown) => Promise<number>;
};

export function writeFarmTerminal(
  detached: boolean,
  terminal: Pick<RuntimeTerminalService, "write">,
  sessionId: number,
  data: Uint8Array,
  errorOutput: boolean,
): { ret: number; nwritten: number } {
  if (!detached) terminal.write(sessionId, data, errorOutput);
  return { ret: 0, nwritten: data.byteLength };
}

export function createProductionRuntimeDependencies(options: {
  workspaceFileSystem: WorkspaceFileSystem;
  utilityWorkerUrl: string;
  lifecycleWorkerUrl: string;
  childProcessWorkerUrl: string;
}, factories: {
  createHttpBridgeOwner?: typeof createHttpBridgeOwner;
  createChildProcessBridgeOwner?: typeof createChildProcessBridgeOwner;
} = {}): AppRuntimeDependencies<SysrootArchiveStore> {
  const generations = new Map<string, GenerationResources>();
  let activeGeneration: string | undefined;

  return {
    workspaceFileSystem: options.workspaceFileSystem,
    createGeneration: () => crypto.randomUUID(),
    createCtx: gen_ctx,
    createArchiveStore: () => new SysrootArchiveStore(),
    createTerminalService: (generation) =>
      new RuntimeTerminalService(generation),
    createParserService: (ctx, signal) =>
      new RuntimeParserService(ctx, signal, sharedObjectFactories),
    createCommandService: (ctx, signal) =>
      new RuntimeCommandService(ctx, signal, sharedObjectFactories),
    createChannelOwner,
    sharedObjectFactories,
    createHostCallbacks: ({
      generation,
      ctx,
      signal,
      archiveStore,
      terminal,
      channels,
      workspaceFileSystem,
      registerConstructionCleanup,
    }) => {
      const workspace = workspaceFileSystem as WorkspaceFileSystem;
      const resources: GenerationResources = { detached: false };
      generations.set(generation, resources);
      activeGeneration = generation;

      const terminalHandler = ({
        sessionId,
        data,
      }: {
        sessionId: number;
        data: unknown;
      }) => terminal.write(sessionId, bytes(data));
      channels.add(
        sharedObjectFactories.createSharedObject(
          terminalHandler,
          ctx.terminal_id,
        ),
      );
      channels.add(
        sharedObjectFactories.createSharedObject(
          () => terminal.size(0),
          ctx.get_terminal_size_id,
        ),
      );

      const lsp = channels
        .add(sharedObjectFactories.createSharedObjectRef(ctx.ls_id))
        .proxy<(message: { data: unknown }) => Promise<void>>();
      resources.target = channels
        .add(
          sharedObjectFactories.createSharedObjectRef(
            ctx.load_additional_sysroot_id,
          ),
        )
        .proxy<(request: unknown) => Promise<number>>();

      const partialOwners: Array<{
        abort(reason?: unknown): void;
        dispose(): Promise<void>;
      }> = [];
      let http: ReturnType<typeof createHttpBridgeOwner>;
      let child: ReturnType<typeof createChildProcessBridgeOwner>;
      try {
        http = (factories.createHttpBridgeOwner ?? createHttpBridgeOwner)(
          createCratesProxyFetch({
            proxyBaseUrl: "https://proxy.rubrc.workers.dev",
          }),
          { signal },
        );
        partialOwners.push(http);
        child = (factories.createChildProcessBridgeOwner ??
          createChildProcessBridgeOwner)({
          getWasiRef: () => {
            if (resources.wasiRef === undefined) {
              throw new Error("runtime farm is unavailable");
            }
            return resources.wasiRef;
          },
          workerUrl: options.childProcessWorkerUrl,
          filesystemRoot: workspace.rootDirectory,
          uploadTimeoutMs: 30_000,
          executionTimeoutMs: 120_000,
          signal,
        });
        partialOwners.push(child);
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        for (const owner of partialOwners) {
          try {
            owner.abort(error);
          } catch (abortError) {
            cleanupErrors.push(abortError);
          }
        }
        const disposals = partialOwners.map((owner) => {
          try {
            return Promise.resolve(owner.dispose());
          } catch (disposeError) {
            return Promise.reject(disposeError);
          }
        });
        const cleanup = Promise.allSettled(disposals).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") cleanupErrors.push(result.reason);
          }
          if (cleanupErrors.length === 1) throw cleanupErrors[0];
          if (cleanupErrors.length > 1) {
            throw new AggregateError(
              cleanupErrors,
              "partial host bridge cleanup failed",
            );
          }
        });
        registerConstructionCleanup(cleanup);
        throw error;
      }
      const sysroot = createSysrootArchiveCallbackAdapter(archiveStore);
      let fileName = "";
      let fileChunks: Uint8Array<ArrayBuffer>[] = [];

      return createRuntimeHostCallbackOwner({
        signal,
        sysroot,
        http,
        child,
        handleSynchronousMessage(message) {
          if (typeof message !== "object" || message === null) return undefined;
          const unknown = message as {
            name?: string;
            args?: Record<string, unknown>;
          };
          if (unknown.name === "downloadFileStart") {
            fileName = String(unknown.args?.name ?? "download");
            fileChunks = [];
          } else if (unknown.name === "downloadFileChunk") {
            fileChunks.push(bytes(unknown.args?.data));
          } else if (unknown.name === "downloadFileEnd") {
            const url = URL.createObjectURL(new Blob(fileChunks));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = downloadName(fileName);
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            fileName = "";
            fileChunks = [];
          } else if (unknown.name === "terminalWrite") {
            routeWasiTerminalWrite(
              unknown.args as { session_id: number; data: unknown },
              (lspMessage) => void lsp(lspMessage).catch(console.error),
              (sessionId, data) => terminal.write(sessionId, bytes(data)),
            );
          } else {
            console.warn("Unknown function called", unknown);
          }
          return undefined;
        },
      });
    },
    createFarm: ({ generation, terminal, hostCallbacks }) => {
      const resources = generations.get(generation);
      if (resources === undefined) {
        throw new Error("runtime host callbacks are unavailable");
      }
      class TerminalFd extends Fd {
        constructor(private readonly errorOutput: boolean) {
          super();
        }
        fd_write(data: Uint8Array) {
          return writeFarmTerminal(
            resources.detached,
            terminal,
            0,
            data,
            this.errorOutput,
          );
        }
        fd_seek() {
          return { ret: 8, offset: 0n };
        }
        fd_filestat_get() {
          return { ret: 8, filestat: null };
        }
      }

      const farm = new WASIFarm(
        new TerminalFd(false),
        new TerminalFd(false),
        new TerminalFd(true),
        [options.workspaceFileSystem.preopen],
        {
          allocator_size: 100 * 1024 * 1024,
          base_call_allocator_size: 64 * 1024 * 1024,
           unknown_fn: (message: unknown) => {
            if (resources.detached) {
              throw new DOMException("runtime data plane detached", "AbortError");
            }
            if (
              typeof message === "object" && message !== null &&
              (message as { name?: unknown }).name === "hostRunCargo"
            ) {
              recordCargoHostCall();
            }
            return hostCallbacks.handle(message);
          },
        },
      );
      resources.wasiRef = farm.get_ref();
      return {
        farm,
        wasiRef: resources.wasiRef,
        detachDataPlane: () => {
          resources.detached = true;
        },
      };
    },
    createUtilityWorker: () =>
      new Worker(options.utilityWorkerUrl, { type: "module" }),
    createLifecycleWorker: () =>
      new Worker(options.lifecycleWorkerUrl, { type: "module" }),
    createWorkerHandshake: (workerOptions) =>
      wrapRuntimeWorkerHandshakeForTest(
        createRuntimeWorkerHandshake(workerOptions),
      ),
    targetEndpoint: (request) => {
      const target = activeGeneration === undefined
        ? undefined
        : generations.get(activeGeneration)?.target;
      return target === undefined
        ? Promise.reject(new Error("target loading is unavailable"))
        : target(request);
    },
    clearRegistrations: (generation) => {
      generations.delete(generation);
      if (activeGeneration === generation) activeGeneration = undefined;
    },
  };
}
