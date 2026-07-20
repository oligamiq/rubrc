import { SharedObjectRef } from "@oligami/shared-object";
import { MonacoLanguageClient } from "monaco-languageclient";
import type { Ctx } from "./ctx";
import { rust_file } from "./config";
import { createLspConnection } from "./lsp_bridge";
import { RustDocumentSync } from "./rust_document_sync";
import { VFS_SYNC_SESSION_ID } from "./lsp_protocol";

export async function startRustLspClient(ctx: Ctx) {
  const input = new SharedObjectRef(ctx.input_string_id).proxy<
    (args: { sessionId: number; data: string }) => Promise<void>
  >();
  const sync = new RustDocumentSync(async (path, content) => {
    if (path === "/src/main.rs") rust_file.data = new TextEncoder().encode(content);
    await input({
      sessionId: VFS_SYNC_SESSION_ID,
      data: JSON.stringify({ path, content }),
    });
  });
  const connection = createLspConnection(ctx);
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
  try {
    await client.start();
  } catch (error) {
    await sync.dispose();
    connection.dispose();
    throw error;
  }
  return {
    async dispose() {
      await sync.dispose();
      if (client.needsStop()) await client.stop();
      connection.dispose();
    },
  };
}
