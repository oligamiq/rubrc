import { SharedObjectRef } from "@oligami/shared-object";
import { MonacoLanguageClient } from "monaco-languageclient";
import type * as Monaco from "monaco-editor";
import { Uri } from "vscode";
import {
  type InitializeParams,
  ProgressType,
} from "vscode-languageclient/browser.js";
import type { Ctx } from "./ctx";
import { default_value } from "./config";
import { createLspConnection } from "./lsp_bridge";
import { RustDocumentSync } from "./rust_document_sync";
import { RustLspResourceOwner } from "./rust_lsp_client_dispose";
import { createRustAnalyzerInitializationOptions } from "./rust_lsp_config";
import { runRustLspStartup } from "./rust_lsp_startup";
import { createWorkspaceVfsWriter } from "./workspace_sync";
import {
  exposeSyntaxTreeRequest,
  handlePublishedDiagnostics,
  recordDidOpenComplete,
  recordLspProgress,
  recordVfsWrite,
} from "./lsp_test_api";

class RustMonacoLanguageClient extends MonacoLanguageClient {
  protected override fillInitializeParams(params: InitializeParams): void {
    super.fillInitializeParams(params);
    if (params.capabilities.textDocument) {
      delete params.capabilities.textDocument.diagnostic;
    }
    if (params.capabilities.workspace) {
      delete params.capabilities.workspace.diagnostics;
    }
  }
}

export async function startRustLspClient(
  ctx: Ctx,
  monaco: typeof Monaco,
  signal: AbortSignal,
) {
  const owner = new RustLspResourceOwner();
  let createdMainModel: Monaco.editor.ITextModel | undefined;

  try {
    const vfsSharedRef = new SharedObjectRef(ctx.input_string_id);
    owner.setVfsSharedRef(vfsSharedRef);

    const input =
      vfsSharedRef.proxy<
        (args: { sessionId: number; data: string }) => Promise<void>
      >();

    const writeWorkspace = createWorkspaceVfsWriter(input);
    const writeAndRecordWorkspace = async (path: string, content: string) => {
      await writeWorkspace(path, content);
      recordVfsWrite(path, content);
    };
    const sync = new RustDocumentSync(writeAndRecordWorkspace, {
      onDidOpenComplete: recordDidOpenComplete,
    });
    const mainDidOpen = sync.waitForDidOpen("file:///src/main.rs");
    owner.setSync(sync);

    const connection = createLspConnection(ctx);
    owner.setConnection(connection);

    const client = new RustMonacoLanguageClient({
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
          handleDiagnostics: handlePublishedDiagnostics,
          provideDiagnostics: () => ({ kind: "full", items: [] }),
        },
        initializationOptions: createRustAnalyzerInitializationOptions(),
      },
      messageTransports: connection,
    });
    owner.setClient(client);

    const progressDisposable = client.onProgress(
      new ProgressType<{ kind: string }>(),
      "rustAnalyzer/Fetching",
      (value) => recordLspProgress(value),
    );
    owner.setProgressDisposable(progressDisposable);

    await runRustLspStartup(
      {
        prepopulateMain: () =>
          writeAndRecordWorkspace("/src/main.rs", default_value),
        startClient: () => client.start(),
        cancelClientStart: () => connection.dispose(),
        createMainModel: async () => {
          const uri = monaco.Uri.parse("file:///src/main.rs");
          if (!monaco.editor.getModel(uri)) {
            createdMainModel = monaco.editor.createModel(
              default_value,
              "rust",
              uri,
            );
          }
          await mainDidOpen;
        },
      },
      300_000,
      signal,
    );

    if (import.meta.env.VITE_RUBRC_LSP_TEST === "1") {
      owner.setTestApiDisposable(exposeSyntaxTreeRequest(client));
    }

    return {
      flush: () => sync.flush(),
      dispose: () => owner.dispose(),
    };
  } catch (error) {
    try {
      createdMainModel?.dispose();
    } catch (cleanupError) {
      console.error(
        "Main model cleanup failed after startup error:",
        cleanupError,
      );
    }
    try {
      await owner.dispose();
    } catch (cleanupError) {
      console.error("Cleanup failed after startup error:", cleanupError);
    }
    throw error;
  }
}
