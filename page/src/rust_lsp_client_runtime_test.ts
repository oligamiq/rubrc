import { expect, mock, test } from "bun:test";
import {
  type AppRuntimeDependencies,
  type RuntimeLspDependencies,
  RuntimeSupervisor,
} from "./app_runtime.ts";
import type { Ctx } from "./ctx.ts";

mock.module("monaco-languageclient", () => ({
  MonacoLanguageClient: class {},
}));
mock.module("vscode", () => ({
  Uri: { file: (value: string) => value },
}));
mock.module("vscode-languageclient/browser.js", () => ({
  ProgressType: class {},
  vsdiag: { DocumentDiagnosticReportKind: { full: "full" } },
}));

test("startRustLspClient registers runtime VFS writer and reader channels", async () => {
  const { startRustLspClient } = await import("./rust_lsp_client.ts");
  const ctx = {
    resize_id: "runtime-resize",
    input_char_id: "runtime-char",
    input_string_id: "runtime-input",
    interrupt_id: "runtime-interrupt",
    create_session_id: "runtime-create-session",
    close_session_id: "runtime-close-session",
    ls_id: "runtime-ls",
  } as Ctx;
  const registered: Array<{ id: string; bc: { close(): void } }> = [];
  const created: string[] = [];
  const closed: string[] = [];
  const dependencies: AppRuntimeDependencies = {
    createGeneration: () => "runtime-lsp-generation",
    createCtx: () => ctx,
    createArchiveStore: () => ({
      prefetch: () => Promise.resolve(),
      dispose() {},
    }),
    createTerminalService: () => ({
      attach: () => ({ dispose() {} }),
      write() {},
      size: () => ({ cols: 80, rows: 24 }),
      out: () => "",
      error: () => "",
      dispose() {},
    }),
    createParserService: () => ({ ready: Promise.resolve(), dispose() {} }),
    createCommandService: () => ({
      run: () => Promise.resolve(),
      download: () => Promise.resolve(),
      dispose() {},
    }),
    createChannelOwner: () => ({
      add<T>(channel: T): T {
        registered.push(channel as (typeof registered)[number]);
        return channel;
      },
      dispose() {},
    }),
    sharedObjectFactories: {
      createSharedObject: (_value, id) => {
        created.push(`object:${id}`);
        return { id, bc: { close: () => closed.push(`object:${id}`) } };
      },
      createSharedObjectRef: (id) => {
        created.push(`ref:${id}`);
        return {
          id,
          proxy: <T>() => (() => Promise.resolve()) as T,
          bc: { close: () => closed.push(`ref:${id}`) },
        };
      },
    },
    createHostCallbacks: () => {
      throw new Error("runtime start was not expected");
    },
    createFarm: () => {
      throw new Error("runtime start was not expected");
    },
    createUtilityWorker: () => {
      throw new Error("runtime start was not expected");
    },
    createLifecycleWorker: () => {
      throw new Error("runtime start was not expected");
    },
    createWorkerHandshake: () => {
      throw new Error("runtime start was not expected");
    },
  };
  const runtime = await new RuntimeSupervisor(dependencies).create();
  const constructionError = new Error("stop after transport construction");

  await expect(
    startRustLspClient(runtime.lspDependencies, {} as never, {} as never, {
      createClient(options) {
        options.messageTransports.reader.listen(() => {});
        const configuration = options.clientOptions.middleware?.workspace
          ?.configuration;
        expect(configuration).toBeFunction();
        expect(
          configuration?.(
            {
              items: [
                { section: "rust-analyzer" },
                { section: "other-server" },
              ],
            },
            {} as never,
            () => Promise.resolve([]),
          ),
        ).toEqual([
          {
            linkedProjects: [],
            cargo: { buildScripts: { enable: false }, autoreload: false },
            procMacro: { enable: false },
            checkOnSave: { enable: false },
            cachePriming: { enable: false },
          },
          null,
        ]);
        throw constructionError;
      },
    }),
  ).rejects.toBe(constructionError);

  expect(created.slice(-3)).toEqual([
    "ref:runtime-input",
    "ref:runtime-input",
    "object:runtime-ls",
  ]);
  expect(registered.slice(-3)).toHaveLength(3);
  expect(closed).toEqual([
    "object:runtime-ls",
    "ref:runtime-input",
    "ref:runtime-input",
  ]);
  await runtime.dispose();
});

test("startRustLspClient cancellation aborts owner transport without graceful stop", async () => {
  const { startRustLspClient } = await import("./rust_lsp_client.ts");
  const controller = new AbortController();
  const reason = new Error("cancel runtime-owned LSP startup");
  const closed: string[] = [];
  let channel = 0;
  let stopCalls = 0;
  let rejectStart!: (reason: unknown) => void;
  const clientStart = new Promise<void>((_resolve, reject) => {
    rejectStart = reject;
  });
  let notifyStarted!: () => void;
  const clientStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const close = (label: string) => {
    closed.push(label);
    rejectStart(new Error("LSP transport closed"));
  };
  const runtime = {
    ctx: {
      input_string_id: "runtime-cancel-input",
      ls_id: "runtime-cancel-ls",
    } as Ctx,
    signal: controller.signal,
    adopter: { adoptOperationOwner() {} },
    factories: {
      createSharedObject: () => {
        const label = `object-${++channel}`;
        return { bc: { close: () => close(label) } };
      },
      createSharedObjectRef: () => {
        const label = `ref-${++channel}`;
        return {
          proxy: <T>() => (() => Promise.resolve()) as T,
          bc: { close: () => close(label) },
        };
      },
    },
  } satisfies RuntimeLspDependencies;
  const model = {
    getValue: () => "fn main() {}",
    onDidChangeContent: () => ({ dispose() {} }),
  };
  const starting = startRustLspClient(runtime, {} as never, model as never, {
    createClient(options) {
      options.messageTransports.reader.listen(() => {});
      return {
        start: () => {
          notifyStarted();
          return clientStart;
        },
        needsStop: () => true,
        stop: async () => {
          stopCalls++;
        },
        onProgress: () => ({ dispose() {} }),
        sendRequest: () => Promise.resolve(undefined),
      } as never;
    },
  });
  await clientStarted;

  controller.abort(reason);

  await expect(starting).rejects.toBe(reason);
  expect(stopCalls).toBe(0);
  expect(closed).toHaveLength(3);
  expect(new Set(closed).size).toBe(3);
});
