import { SharedObjectRef } from "@oligami/shared-object";
import { MonacoLanguageClient } from "monaco-languageclient";
import type * as Monaco from "monaco-editor";
import { Uri } from "vscode";
import {
  type InitializeParams,
  ProgressType,
} from "vscode-languageclient/browser.js";
import type { Ctx } from "./ctx";
import { default_value, rust_file } from "./config";
import { createLspConnection } from "./lsp_bridge";
import { RustDocumentSync } from "./rust_document_sync";
import { VFS_SYNC_SESSION_ID } from "./lsp_protocol";
import { RustLspResourceOwner } from "./rust_lsp_client_dispose";
import { createRustAnalyzerInitializationOptions } from "./rust_lsp_config";
import { recordDidOpenComplete, recordVfsWrite } from "./lsp_test_api";

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

export async function startRustLspClient(ctx: Ctx, monaco: typeof Monaco) {
  const owner = new RustLspResourceOwner();

  try {
    const vfsSharedRef = new SharedObjectRef(ctx.input_string_id);
    owner.setVfsSharedRef(vfsSharedRef);

    const input =
      vfsSharedRef.proxy<
        (args: { sessionId: number; data: string }) => Promise<void>
      >();

    const sync = new RustDocumentSync(
      async (path, content) => {
        if (path === "/src/main.rs") {
          rust_file.data = new TextEncoder().encode(content);
        }
        await input({
          sessionId: VFS_SYNC_SESSION_ID,
          data: JSON.stringify({ path, content }),
        });
        recordVfsWrite(path, content);
      },
      { onDidOpenComplete: recordDidOpenComplete },
    );
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
          provideDiagnostics: () => ({ kind: "full", items: [] }),
        },
        initializationOptions: createRustAnalyzerInitializationOptions(),
      },
      messageTransports: connection,
    });
    owner.setClient(client);

    let progressDisposable: { dispose(): void } | undefined;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const projectReady = new Promise<void>((resolve, reject) => {
      progressDisposable = client.onProgress(
        new ProgressType<{ kind: string }>(),
        "rustAnalyzer/Fetching",
        (value) => {
          if (value.kind === "end") resolve();
        },
      );
      progressTimer = setTimeout(
        () => reject(new Error("rust-analyzer project loading timed out")),
        120_000,
      );
    });
    await client.start();
    const uri = monaco.Uri.parse("file:///src/main.rs");
    if (!monaco.editor.getModel(uri)) {
      monaco.editor.createModel(default_value, "rust", uri);
    }
    try {
      await projectReady;
    } finally {
      if (progressTimer !== undefined) clearTimeout(progressTimer);
      progressDisposable?.dispose();
    }
  } catch (error) {
    try {
      await owner.dispose();
    } catch (cleanupError) {
      console.error("Cleanup failed after startup error:", cleanupError);
    }
    throw error;
  }

  return {
    dispose: () => owner.dispose(),
  };
}
