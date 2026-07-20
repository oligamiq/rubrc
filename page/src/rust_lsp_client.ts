import { SharedObjectRef } from "@oligami/shared-object";
import { MonacoLanguageClient } from "monaco-languageclient";
import type { Ctx } from "./ctx";
import { rust_file } from "./config";
import { createLspConnection } from "./lsp_bridge";
import { RustDocumentSync } from "./rust_document_sync";
import { VFS_SYNC_SESSION_ID } from "./lsp_protocol";
import { RustLspResourceOwner } from "./rust_lsp_client_dispose";

export async function startRustLspClient(ctx: Ctx) {
  const owner = new RustLspResourceOwner();

  try {
    const vfsSharedRef = new SharedObjectRef(ctx.input_string_id);
    owner.setVfsSharedRef(vfsSharedRef);

    const input = vfsSharedRef.proxy<
      (args: { sessionId: number; data: string }) => Promise<void>
    >();

    const sync = new RustDocumentSync(async (path, content) => {
      if (path === "/src/main.rs") rust_file.data = new TextEncoder().encode(content);
      await input({
        sessionId: VFS_SYNC_SESSION_ID,
        data: JSON.stringify({ path, content }),
      });
    });
    owner.setSync(sync);

    const connection = createLspConnection(ctx);
    owner.setConnection(connection);

    const client = new MonacoLanguageClient({
      name: "Rust Language Client",
      clientOptions: {
        documentSelector: [{ scheme: "file", language: "rust" }],
        middleware: sync.middleware,
        initializationOptions: {
          cargo: { sysroot: "/sysroot" },
          linkedProjects: ["/rust-project.json"],
          procMacro: { enable: false },
          checkOnSave: { enable: false },
          diagnostics: { enable: true, experimental: { enable: true } },
        },
      },
      messageTransports: connection,
    });
    owner.setClient(client);

    await client.start();
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
