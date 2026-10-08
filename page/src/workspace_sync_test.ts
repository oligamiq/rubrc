import { VFS_SYNC_SESSION_ID } from "./lsp_protocol.ts";
import { WorkspaceFileSystem } from "./workspace_fs.ts";
import {
  createWorkspaceVfsBinaryWriter,
  createWorkspaceVfsWriter,
} from "./workspace_sync.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("workspace writer updates host bytes before VFS propagation without file events", async () => {
  const workspace = new WorkspaceFileSystem("old");
  const order: string[] = [];
  const changes: string[] = [];
  workspace.onDidChange((change) => changes.push(change.path));
  const writer = createWorkspaceVfsWriter(async (message) => {
    order.push(new TextDecoder().decode(workspace.readFile("/src/main.rs")));
    assert(message.sessionId === VFS_SYNC_SESSION_ID, "wrong VFS session");
  }, workspace);
  await writer("/src/main.rs", "new");
  assert(order.join() === "new", `VFS ran before host write: ${order}`);
  assert(changes.length === 0, "model write emitted external file event");
});

Deno.test("binary workspace writer preserves every byte across both filesystems", async () => {
  const workspace = new WorkspaceFileSystem("");
  const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
  let propagated: Uint8Array | undefined;
  const writer = createWorkspaceVfsBinaryWriter(async ({ sessionId, data }) => {
    assert(sessionId === VFS_SYNC_SESSION_ID, "wrong VFS session");
    const update = JSON.parse(data);
    assert(update.path === "/cache.salsa", "wrong VFS path");
    propagated = Uint8Array.from(atob(update.base64), (c) => c.charCodeAt(0));
  }, workspace);
  await writer("/cache.salsa", bytes);
  assert(
    propagated?.join() === bytes.join(),
    "Rust-side binary payload changed",
  );
  assert(
    workspace.readFile("/cache.salsa").join() === bytes.join(),
    "Web-side bytes changed",
  );
});

Deno.test("workspace writer creates secondary Rust files", async () => {
  const workspace = new WorkspaceFileSystem("main");
  const messages: string[] = [];
  const writer = createWorkspaceVfsWriter(async ({ data }) => {
    messages.push(data);
  }, workspace);
  await writer("/src/secondary.rs", "pub fn secondary() {}\n");
  assert(
    new TextDecoder().decode(workspace.readFile("/src/secondary.rs"))
      .startsWith(
        "pub fn",
      ),
    "secondary file missing",
  );
  assert(
    JSON.parse(messages[0]).path === "/src/secondary.rs",
    "wrong propagated path",
  );
  assert(
    JSON.parse(messages[0]).content === "pub fn secondary() {}\n",
    "wrong propagated content",
  );
});
