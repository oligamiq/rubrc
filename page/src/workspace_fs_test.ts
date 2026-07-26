import { Directory, File } from "@bjorn3/browser_wasi_shim";
import { WorkspaceFileSystem, WorkspaceFsError } from "./workspace_fs.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

Deno.test("workspace initializes the WASI project tree once", () => {
  const workspace = new WorkspaceFileSystem("fn main() {}\n");
  assert(
    decode(workspace.readFile("/src/main.rs")) === "fn main() {}\n",
    "main source missing",
  );
  assert(workspace.rootContents.get("src") instanceof Directory, "src missing");
  assert(
    workspace.rootContents.get("sysroot") instanceof Directory,
    "sysroot missing",
  );
  assert(
    workspace.preopen.dir === workspace.rootDirectory,
    "preopen copied the root directory",
  );
  assert(
    workspace.rootDirectory.contents === workspace.rootContents,
    "root contents differ",
  );
});

Deno.test("workspace mutations retain one File object and support top-level paths", () => {
  const workspace = new WorkspaceFileSystem("old");
  const original = workspace.lookup("/src/main.rs");
  workspace.writeFile("/src/main.rs", new TextEncoder().encode("new"), {
    create: false,
    overwrite: true,
    notify: false,
  });
  assert(
    workspace.lookup("/src/main.rs") === original,
    "write replaced the File object",
  );
  assert(decode(workspace.readFile("/src/main.rs")) === "new", "write missing");

  workspace.mkdir("/tests", true);
  workspace.writeFile("/tests/smoke.rs", new Uint8Array([1]), {
    create: true,
    overwrite: false,
    notify: true,
  });
  assert(
    workspace.readdir("/tests").join() === "smoke.rs",
    "top-level directory missing",
  );
  workspace.rename("/tests/smoke.rs", "/tests/browser.rs", false, true);
  workspace.rename("/tests/browser.rs", "/tests/browser.rs", false, true);
  assert(
    workspace.lookup("/tests/browser.rs") instanceof File,
    "same-path rename deleted the file",
  );
  let nestedRejected = false;
  try {
    workspace.rename("/tests", "/tests/nested", false, true);
  } catch (error) {
    nestedRejected = error instanceof WorkspaceFsError &&
      error.code === "InvalidPath";
  }
  assert(nestedRejected, "directory moved inside itself");
  workspace.mkdir("/occupied", true);
  workspace.writeFile("/occupied/child", new Uint8Array([2]), {
    create: true,
    overwrite: false,
    notify: true,
  });
  let overwriteRejected = false;
  try {
    workspace.rename("/tests/browser.rs", "/occupied", true, true);
  } catch (error) {
    overwriteRejected = error instanceof WorkspaceFsError &&
      error.code === "IsDirectory";
  }
  assert(overwriteRejected, "file replaced an occupied directory");
  workspace.delete("/tests/browser.rs", false, true);
  assert(workspace.readdir("/tests").length === 0, "delete failed");
});

Deno.test("workspace emits only requested changes", () => {
  const workspace = new WorkspaceFileSystem("old");
  const changes: string[] = [];
  const subscription = workspace.onDidChange((change) =>
    changes.push(`${change.kind}:${change.path}`)
  );
  workspace.writeFile("/src/main.rs", new TextEncoder().encode("model"), {
    create: false,
    overwrite: true,
    notify: false,
  });
  workspace.writeFile("/src/main.rs", new TextEncoder().encode("provider"), {
    create: false,
    overwrite: true,
    notify: true,
  });
  subscription.dispose();
  assert(
    changes.join() === "updated:/src/main.rs",
    `wrong changes: ${changes}`,
  );
});

Deno.test("workspace rejects paths outside the POSIX root", () => {
  const workspace = new WorkspaceFileSystem("main");
  for (
    const path of [
      "src/main.rs",
      "/../escape",
      "/src\\main.rs",
      "/src/bad\0name",
      "/C:/src/main.rs",
    ]
  ) {
    let rejected = false;
    try {
      workspace.lookup(path);
    } catch (error) {
      rejected = error instanceof WorkspaceFsError &&
        error.code === "InvalidPath";
    }
    assert(rejected, `accepted invalid path: ${path}`);
  }
});
