import type { URI as ResourceUri } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { WorkspaceFileSystem } from "./workspace_fs.ts";
import { WasiWorkspaceFileProvider } from "./workspace_file_provider.ts";
import {
  activateRustSrcFsEndpoint,
  clearRustSrcFsEndpoint,
  RUST_SRC_MOUNT_PATH,
  type RustSrcFsEndpoint,
} from "./rust_src_vfs_rpc.ts";

const FileChangeType = { UPDATED: 0 };
const FileType = { File: 1, Directory: 2 };
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

Deno.test("provider resolves rust-src lazily without populating workspace sysroot bytes", async () => {
  const workspace = new WorkspaceFileSystem("main");
  const source = new TextEncoder().encode("pub const CORE: &str = \"lazy\";\n");
  const endpoint: RustSrcFsEndpoint = (request) => {
    if (request.operation === "stat") {
      if (request.path === "" || request.path === "core" || request.path === "core/src") {
        return {
          operation: "stat",
          stat: { type: "directory", size: 0, mtime: 1000 },
        };
      }
      if (request.path === "core/src/lib.rs") {
        return {
          operation: "stat",
          stat: { type: "file", size: source.length, mtime: 2000 },
        };
      }
    }
    if (request.operation === "readFile" && request.path === "core/src/lib.rs") {
      return { operation: "readFile", data: source };
    }
    if (request.operation === "readdir") {
      const entries = request.path === "" ? ["core"] :
        request.path === "core" ? ["src"] :
        request.path === "core/src" ? ["lib.rs"] : [];
      return { operation: "readdir", entries };
    }
    throw new Error(`unexpected rust-src request ${request.operation}:${request.path}`);
  };
  activateRustSrcFsEndpoint("provider-lazy-test", endpoint);
  try {
    const provider = new WasiWorkspaceFileProvider(workspace);
    const fileUri = URI.parse(`file://${RUST_SRC_MOUNT_PATH}/core/src/lib.rs`);
    const stat = await provider.stat(fileUri);
    assert(stat.type === FileType.File, "lazy rust-src stat was not a file");
    assert(stat.size === source.length, "lazy rust-src size mismatch");
    assert(
      new TextDecoder().decode(await provider.readFile(fileUri)) ===
        new TextDecoder().decode(source),
      "lazy rust-src bytes mismatch",
    );
    const listing = await provider.readdir(
      URI.parse(`file://${RUST_SRC_MOUNT_PATH}/core/src`),
    );
    assert(
      listing.length === 1 && listing[0][0] === "lib.rs" &&
        listing[0][1] === FileType.File,
      "lazy rust-src listing mismatch",
    );
    const ancestor = await provider.readdir(
      URI.parse("file:///sysroot/lib/rustlib/src/rust"),
    );
    assert(
      ancestor.some(([name, type]) => name === "library" && type === FileType.Directory),
      "rust-src mount ancestor was not synthesized",
    );
    assert(workspace.sysrootContents.size === 0, "workspace sysroot was eagerly populated");
  } finally {
    clearRustSrcFsEndpoint("provider-lazy-test");
  }
});

Deno.test("provider rejects writes into the rust-src namespace", async () => {
  const provider = new WasiWorkspaceFileProvider(new WorkspaceFileSystem("main"));
  let rejected = false;
  try {
    await provider.writeFile(
      URI.parse(`file://${RUST_SRC_MOUNT_PATH}/core/src/lib.rs`),
      new Uint8Array([1]),
      { create: true, overwrite: true, unlock: false, atomic: false },
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "rust-src write was accepted");
});
