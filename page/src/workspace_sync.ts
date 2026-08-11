import { VFS_SYNC_SESSION_ID } from "./lsp_protocol.ts";
import type { VfsWriter } from "./rust_document_sync.ts";
import { WorkspaceFileSystem, workspaceFileSystem } from "./workspace_fs.ts";

export type VfsSyncInput = (args: {
  sessionId: number;
  data: string;
}) => Promise<void>;

export function createWorkspaceVfsWriter(
  input: VfsSyncInput,
  workspace: WorkspaceFileSystem = workspaceFileSystem,
): VfsWriter {
  return async (path, content) => {
    workspace.writeFile(path, new TextEncoder().encode(content), {
      create: true,
      overwrite: true,
      notify: false,
    });
    await input({
      sessionId: VFS_SYNC_SESSION_ID,
      data: JSON.stringify({ path, content }),
    });
  };
}
