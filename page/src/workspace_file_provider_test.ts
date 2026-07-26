import type { URI as ResourceUri } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { WorkspaceFileSystem } from "./workspace_fs.ts";
import { WasiWorkspaceFileProvider } from "./workspace_file_provider.ts";

const FileChangeType = { UPDATED: 0 };
const FileType = { File: 1 };
const URI = {
  parse(value: string): ResourceUri {
    const parsed = new URL(value);
    return {
      scheme: parsed.protocol.slice(0, -1),
      authority: parsed.host,
      path: parsed.pathname,
      toString: () => value,
    } as ResourceUri;
  },
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("provider resolves main source from the WASI tree", async () => {
  const workspace = new WorkspaceFileSystem("fn main() {}\n");
  const provider = new WasiWorkspaceFileProvider(workspace);
  const uri = URI.parse("file:///src/main.rs");
  const stat = await provider.stat(uri);
  assert(stat.type === FileType.File, "main source is not a file");
  assert(
    new TextDecoder().decode(await provider.readFile(uri)) ===
      "fn main() {}\n",
    "wrong bytes",
  );
  assert(
    (await provider.readdir(URI.parse("file:///src")))[0][0] === "main.rs",
    "src listing missing",
  );
});

Deno.test("provider read bytes do not mutate the WASI tree", async () => {
  const workspace = new WorkspaceFileSystem("fn main() {}\n");
  const provider = new WasiWorkspaceFileProvider(workspace);
  const content = await provider.readFile(URI.parse("file:///src/main.rs"));

  content[0] = "x".charCodeAt(0);

  assert(
    new TextDecoder().decode(workspace.readFile("/src/main.rs")) ===
      "fn main() {}\n",
    "provider read exposed shared WASI bytes",
  );
});

Deno.test("provider writes shared bytes and emits provider events", async () => {
  const workspace = new WorkspaceFileSystem("old");
  const provider = new WasiWorkspaceFileProvider(workspace);
  const changes: string[] = [];
  const subscription = provider.onDidChangeFile((items) => {
    for (const item of items) {
      changes.push(`${item.type}:${item.resource.path}`);
    }
  });
  await provider.writeFile(
    URI.parse("file:///src/main.rs"),
    new TextEncoder().encode("new"),
    { create: false, overwrite: true, unlock: false, atomic: false },
  );
  subscription.dispose();
  assert(
    new TextDecoder().decode(workspace.readFile("/src/main.rs")) === "new",
    "WASI bytes stale",
  );
  assert(
    changes.join() === `${FileChangeType.UPDATED}:/src/main.rs`,
    `wrong event: ${changes}`,
  );
});

Deno.test("provider supports create rename and delete", async () => {
  const workspace = new WorkspaceFileSystem("main");
  const provider = new WasiWorkspaceFileProvider(workspace);
  await provider.mkdir(URI.parse("file:///tests"));
  await provider.writeFile(
    URI.parse("file:///tests/a.rs"),
    new Uint8Array([1]),
    {
      create: true,
      overwrite: false,
      unlock: false,
      atomic: false,
    },
  );
  await provider.rename(
    URI.parse("file:///tests/a.rs"),
    URI.parse("file:///tests/b.rs"),
    { overwrite: false },
  );
  await provider.delete(URI.parse("file:///tests/b.rs"), {
    recursive: false,
    useTrash: false,
    atomic: false,
  });
  assert(
    workspace.readdir("/tests").length === 0,
    "provider mutation missed WASI tree",
  );
});

Deno.test("provider rejects authorities and Windows drive paths", async () => {
  const provider = new WasiWorkspaceFileProvider(
    new WorkspaceFileSystem("main"),
  );
  for (
    const uri of [
      URI.parse("file://server/src/main.rs"),
      URI.parse("file:///C:/src/main.rs"),
    ]
  ) {
    let rejected = false;
    try {
      await provider.stat(uri);
    } catch {
      rejected = true;
    }
    assert(rejected, `accepted unsupported URI: ${uri.toString()}`);
  }
});

Deno.test("workspace provider registration precedes Monaco API startup", async () => {
  const source = await Deno.readTextFile("page/src/index.tsx");
  const registerIndex = source.indexOf("registerWorkspaceFileProvider()");
  const wrapperIndex = source.indexOf("new MonacoVscodeApiWrapper");
  const startIndex = source.indexOf("await apiWrapper.start()", wrapperIndex);
  assert(registerIndex >= 0, "workspace provider registration missing");
  assert(
    wrapperIndex > registerIndex,
    "provider registered after wrapper construction",
  );
  assert(startIndex > wrapperIndex, "wrapper startup missing");
});
