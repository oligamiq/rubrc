import { SharedObjectRef } from "@oligami/shared-object";
import { MonacoLanguageClient } from "monaco-languageclient";
import type * as Monaco from "monaco-editor";
import { Uri } from "vscode";
import {
  type InitializeParams,
  ProgressType,
  vsdiag,
} from "vscode-languageclient/browser.js";
import type { RuntimeLspDependencies } from "./app_runtime.ts";
import { createLspConnection } from "./lsp_bridge";
import { RustAnalyzerReadiness } from "./rust_analyzer_readiness";
import { RustDocumentSync } from "./rust_document_sync";
import { mergeVersionedPublishDiagnostics } from "./rust_lsp_client_capabilities";
import { RustLspResourceOwner } from "./rust_lsp_client_dispose";
import { createRustAnalyzerConfigurationState } from "./rust_lsp_config";
import { activateRustProject, runRustLspStartup } from "./rust_lsp_startup";
import type { StagedAnalyzerSession } from "./startup_coordinator";
import { createWorkspaceVfsWriter } from "./workspace_sync";
import {
  exposeSyntaxTreeRequest,
  captureCurrentLspTestGeneration,
  handleGenerationPublishedDiagnostics,
  recordAnalyzerTestReadiness,
  recordDidOpenComplete,
  recordGenerationLspProgress,
  recordVfsWrite,
} from "./lsp_test_api";

class RustMonacoLanguageClient extends MonacoLanguageClient {
  protected override fillInitializeParams(params: InitializeParams): void {
    super.fillInitializeParams(params);
    if (params.capabilities.textDocument) {
      delete params.capabilities.textDocument.diagnostic;
    }
    params.capabilities.textDocument ??= {};
    params.capabilities.textDocument.publishDiagnostics =
      mergeVersionedPublishDiagnostics(
        params.capabilities.textDocument.publishDiagnostics,
      );
    if (params.capabilities.workspace) {
      delete params.capabilities.workspace.diagnostics;
    }
  }
}

export interface RustLspClientPlatform {
  createClient(
    options: ConstructorParameters<typeof RustMonacoLanguageClient>[0],
  ): RustMonacoLanguageClient;
}

export function startRustLspClient(
  runtime: RuntimeLspDependencies,
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  platform?: RustLspClientPlatform,
): Promise<StagedAnalyzerSession>;

export async function startRustLspClient(
  runtime: RuntimeLspDependencies,
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  platform?: RustLspClientPlatform,
): Promise<StagedAnalyzerSession> {
  const { ctx, signal } = runtime;
  const owner = new RustLspResourceOwner(runtime.adopter);
  const mainUri = "file:///src/main.rs";
  const testGeneration = captureCurrentLspTestGeneration();

  try {
    const vfsSharedRef = runtime.factories.createSharedObjectRef(
      ctx.input_string_id,
    ) as SharedObjectRef;
    owner.setVfsSharedRef(vfsSharedRef);

    const input =
      vfsSharedRef.proxy<
        (args: { sessionId: number; data: string }) => Promise<void>
      >();

    const writeWorkspace = createWorkspaceVfsWriter(input);
    const writeAndRecordWorkspace = async (path: string, content: string) => {
      await writeWorkspace(path, content);
      recordVfsWrite(path, content, testGeneration);
    };
    const sync = new RustDocumentSync(writeAndRecordWorkspace, {
      onDidOpenComplete: (uri) => recordDidOpenComplete(uri, testGeneration),
    });
    owner.setSync(sync);
    const analyzerConfiguration = createRustAnalyzerConfigurationState();

    let readiness: RustAnalyzerReadiness | undefined;
    const connection = createLspConnection(
      ctx,
      (message) => readiness?.observeMessage(message),
      runtime.factories,
    );
    owner.setConnection(connection);

    const clientOptions = {
      name: "Rust Language Client",
      clientOptions: {
        documentSelector: [{ scheme: "file", language: "rust" }],
        workspaceFolder: {
          index: 0,
          name: "rubrc",
          uri: Uri.file("/"),
        },
        middleware: {
          ...sync.middleware,
          workspace: {
            configuration: (params) =>
              analyzerConfiguration.response(params.items),
          },
          handleDiagnostics: (uri, diagnostics, next) =>
            handleGenerationPublishedDiagnostics(
              testGeneration,
              uri,
              diagnostics,
              next,
            ),
          provideDiagnostics: () => ({
            kind: vsdiag.DocumentDiagnosticReportKind.full,
            items: [],
          }),
        },
        initializationOptions: analyzerConfiguration.initializationOptions(),
      },
      messageTransports: connection,
    } satisfies ConstructorParameters<typeof RustMonacoLanguageClient>[0];
    const client =
      platform?.createClient(clientOptions) ??
      new RustMonacoLanguageClient(clientOptions);
    owner.setClient(client);
    readiness = new RustAnalyzerReadiness(client, mainUri);
    owner.setReadiness(readiness);
    owner.setModelListener(
      model.onDidChangeContent(() => {
        readiness?.noteDocumentChanged(model.getVersionId());
      }),
    );

    const progressDisposable = client.onProgress(
      new ProgressType<{ kind: string }>(),
      "rustAnalyzer/Fetching",
      (value) => recordGenerationLspProgress(testGeneration, value),
    );
    owner.setProgressDisposable(progressDisposable);

    await runRustLspStartup(
      {
        prepopulateMain: () =>
          writeAndRecordWorkspace("/src/main.rs", model.getValue()),
        startClient: () => client.start(),
        cancelClientStart: () =>
          owner.abort(
            signal.reason ??
              new DOMException("Rust LSP startup cancelled", "AbortError"),
          ),
      },
      300_000,
      signal,
    );

    if (import.meta.env.VITE_RUBRC_LSP_TEST === "1") {
      owner.setTestApiDisposable(
        exposeSyntaxTreeRequest(testGeneration, client),
      );
    }

    return {
      activateProject: async (
        activationModel,
        activationSignal,
        semanticWarming,
      ) => {
        analyzerConfiguration.activateProject();
        await activateRustProject({
          initializedModel: model,
          model: activationModel as Monaco.editor.ITextModel,
          signal: activationSignal,
          uri: mainUri,
          writeMain: (content) =>
            writeAndRecordWorkspace("/src/main.rs", content),
          client,
          readiness,
          sync,
          setModelLanguage: (currentModel, language) =>
            monaco.editor.setModelLanguage(
              currentModel as Monaco.editor.ITextModel,
              language,
            ),
          semanticWarming,
        });
        signal.throwIfAborted();
        activationSignal.throwIfAborted();
        recordAnalyzerTestReadiness(
          testGeneration,
          (activationModel as Monaco.editor.ITextModel).getVersionId(),
        );
      },
      flush: () => sync.flush(),
      dispose: () => owner.dispose(),
    };
  } catch (error) {
    try {
      await owner.dispose();
    } catch (cleanupError) {
      console.error("Cleanup failed after startup error:", cleanupError);
    }
    throw error;
  }
}
