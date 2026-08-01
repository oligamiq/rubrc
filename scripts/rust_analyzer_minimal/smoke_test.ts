import {
  ConsoleStdout,
  Directory,
  File,
  type Inode,
  OpenFile,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import {
  wait_async_polyfill,
  WASIFarm,
} from "@oligami/browser_wasi_shim-threads";
import {
  type HostCommandRequest,
  parseHostCommandRequest,
  ScratchAllocator,
} from "./host_run_cargo.ts";
import { AsyncLspInputQueue } from "./lsp_stdin.ts";
import { type JsonRpcMessage, LspOutputFd } from "./lsp_stream.ts";

type CargoMetadata = {
  packages: Array<{
    name: string;
    edition: string;
    targets: Array<{ kind: string[]; src_path: string; edition: string }>;
  }>;
};

const MEMORY_INITIAL_PAGES = 8192;
const MEMORY_MAXIMUM_PAGES = 16_384;
const SCRATCH_SIZE = 32 * 1024 * 1024;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mapWorkspacePath(value: string, fixturePath: string): string {
  if (value.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error(`guest path escapes workspace: ${value}`);
  }
  if (value.startsWith("/")) {
    const fixtureRoot = fixturePath.replace(/\/+$/, "");
    if (value === "/workspace") return fixtureRoot;
    if (value.startsWith("/workspace/")) {
      return fixtureRoot + value.slice("/workspace".length);
    }
    throw new Error(`absolute guest path is outside workspace: ${value}`);
  }

  const equalsIndex = value.indexOf("=");
  if (equalsIndex !== -1) {
    return value.slice(0, equalsIndex + 1) +
      mapWorkspacePath(value.slice(equalsIndex + 1), fixturePath);
  }
  return value;
}

function restoreWorkspacePaths(
  data: Uint8Array,
  fixturePath: string,
): Uint8Array {
  const fixtureRoot = fixturePath.replace(/\/+$/, "");
  const text = new TextDecoder().decode(data).replaceAll(
    fixtureRoot,
    "/workspace",
  );
  return new TextEncoder().encode(text);
}

function isExpectedRustcDiagnostic(
  message: JsonRpcMessage,
  uri: string,
): boolean {
  if (
    message.method !== "textDocument/publishDiagnostics" ||
    !isRecord(message.params) || message.params.uri !== uri ||
    !Array.isArray(message.params.diagnostics)
  ) return false;

  return message.params.diagnostics.some((diagnostic) =>
    isRecord(diagnostic) && diagnostic.source === "rustc" &&
    typeof diagnostic.message === "string" &&
    diagnostic.message.includes("expected expression")
  );
}

function hasWorkspaceCargoCheck(requests: HostCommandRequest[]): boolean {
  return requests.some((request) => {
    const args = request.args;
    const program = args[0]?.replaceAll("\\", "/").split("/").at(-1);
    if (program !== "cargo" || args[1] !== "check") return false;

    const optionsWithSeparateValues = new Set([
      "--color",
      "--config",
      "--exclude",
      "--features",
      "--jobs",
      "--message-format",
      "--package",
      "--target",
      "--target-dir",
      "-j",
      "-p",
      "-Z",
    ]);
    const manifests: string[] = [];
    for (let index = 2; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--manifest-path") {
        if (args[index + 1] !== undefined) manifests.push(args[++index]);
      } else if (arg.startsWith("--manifest-path=")) {
        manifests.push(arg.slice("--manifest-path=".length));
      } else if (optionsWithSeparateValues.has(arg)) {
        index++;
      }
    }
    return manifests.length === 1 && manifests[0] === "/workspace/Cargo.toml";
  });
}

function runLocalCommand(
  request: HostCommandRequest,
  fixturePath: string,
  scratch: ScratchAllocator,
) {
  const requestedProgram = request.args[0];
  if (requestedProgram === undefined) {
    throw new Error("host command args must include a program");
  }
  const program = requestedProgram.replaceAll("\\", "/").split("/").at(-1);
  if (program !== "cargo" && program !== "rustc") {
    throw new Error(`unsupported host program: ${requestedProgram}`);
  }
  if (
    request.cwd !== undefined &&
    request.cwd !== "/workspace" &&
    request.cwd !== "/workspace/"
  ) {
    throw new Error(`unsupported guest cwd: ${request.cwd}`);
  }

  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "RUSTUP_HOME", "CARGO_HOME"]) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(request.envs ?? {})) {
    if (name === "RUSTC" || name === "CARGO") {
      const tool = value.replaceAll("\\", "/").split("/").at(-1);
      if (tool !== "rustc" && tool !== "cargo") {
        throw new Error(`unsupported ${name} tool: ${value}`);
      }
      env[name] = tool;
      continue;
    }
    if (name === "RUSTUP_AUTO_INSTALL" || name === "RUSTC_BOOTSTRAP") {
      env[name] = value;
    }
  }

  let output: Deno.CommandOutput;
  try {
    output = new Deno.Command(program, {
      args: request.args.slice(1).map((arg) =>
        mapWorkspacePath(arg, fixturePath)
      ),
      cwd: fixturePath,
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
  } catch (error) {
    throw new Error(
      `failed to execute local ${program}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const stdout = restoreWorkspacePaths(output.stdout, fixturePath);
  const stderr = restoreWorkspacePaths(output.stderr, fixturePath);
  const offsets = scratch.allocate(stdout.byteLength, stderr.byteLength);
  return {
    stdout: Array.from(stdout),
    stderr: Array.from(stderr),
    status: output.code,
    ...offsets,
  };
}

Deno.test("local command path mapping stays inside the fixture", () => {
  const fixturePath = "/tmp/rust-analyzer-fixture";
  assert(
    mapWorkspacePath("/workspace/Cargo.toml", fixturePath) ===
      "/tmp/rust-analyzer-fixture/Cargo.toml",
    "guest manifest path was not mapped",
  );
  assert(
    mapWorkspacePath("--manifest-path", fixturePath) === "--manifest-path",
    "command flag was rewritten",
  );
  assert(
    mapWorkspacePath("--manifest-path=/workspace/Cargo.toml", fixturePath) ===
      "--manifest-path=/tmp/rust-analyzer-fixture/Cargo.toml",
    "equals-form guest manifest path was not mapped",
  );
  assert(
    mapWorkspacePath("/workspace/file=name", fixturePath) ===
      "/tmp/rust-analyzer-fixture/file=name",
    "workspace path containing equals was not mapped",
  );
  assert(
    mapWorkspacePath("--message-format=json", fixturePath) ===
      "--message-format=json",
    "non-path equals flag was rewritten",
  );
  assert(
    mapWorkspacePath("x86_64-unknown-linux-gnu", fixturePath) ===
      "x86_64-unknown-linux-gnu",
    "rustc target triple was rewritten",
  );
  for (
    const rejected of [
      "/opt/toolchain",
      "/etc/passwd=1",
      "/workspace/../outside",
      "../outside",
      "src/../../outside",
      "--manifest-path=../outside/Cargo.toml",
    ]
  ) {
    let didReject = false;
    try {
      mapWorkspacePath(rejected, fixturePath);
    } catch {
      didReject = true;
    }
    assert(didReject, `unsafe guest path was accepted: ${rejected}`);
  }
  const restored = new TextDecoder().decode(
    restoreWorkspacePaths(
      new TextEncoder().encode(
        '{"manifest_path":"/tmp/rust-analyzer-fixture/Cargo.toml"}',
      ),
      fixturePath,
    ),
  );
  assert(
    restored === '{"manifest_path":"/workspace/Cargo.toml"}',
    "host output path was not restored",
  );
});

Deno.test("smoke diagnostic proof requires the fixture rustc error", () => {
  const uri = "file:///workspace/src/main.rs";
  const unrelated = {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: [{
        source: "rust-analyzer",
        message: "expected expression",
      }],
    },
  };
  assert(
    !isExpectedRustcDiagnostic(unrelated, uri),
    "non-rustc diagnostic satisfied smoke proof",
  );
  assert(
    !isExpectedRustcDiagnostic({
      ...unrelated,
      params: {
        uri: "file:///workspace/src/other.rs",
        diagnostics: [{ source: "rustc", message: "expected expression" }],
      },
    }, uri),
    "diagnostic for another URI satisfied smoke proof",
  );
  assert(
    !isExpectedRustcDiagnostic({
      ...unrelated,
      params: {
        uri,
        diagnostics: [{ source: "rustc", message: "unused variable" }],
      },
    }, uri),
    "unrelated rustc diagnostic satisfied smoke proof",
  );
  const expected = {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: [{
        source: "rustc",
        message: "expected expression, found `;`",
      }],
    },
  };
  assert(
    isExpectedRustcDiagnostic(expected, uri),
    "fixture rustc diagnostic did not satisfy smoke proof",
  );
});

Deno.test("smoke command proof requires cargo check for workspace manifest", () => {
  const discoveryOnly: HostCommandRequest[] = [{
    args: [
      "cargo",
      "metadata",
      "--manifest-path",
      "/workspace/Cargo.toml",
    ],
  }];
  assert(
    !hasWorkspaceCargoCheck(discoveryOnly),
    "cargo discovery command satisfied check proof",
  );
  assert(
    !hasWorkspaceCargoCheck([{
      args: [
        "cargo",
        "check",
        "--manifest-path",
        "/workspace/other/Cargo.toml",
      ],
    }]),
    "cargo check for another manifest satisfied proof",
  );
  assert(
    !hasWorkspaceCargoCheck([{
      args: [
        "cargo",
        "check",
        "--manifest-path=/workspace/Cargo.toml",
        "--manifest-path=/workspace/other/Cargo.toml",
      ],
    }]),
    "cargo check with an overriding manifest satisfied proof",
  );
  assert(
    !hasWorkspaceCargoCheck([{
      args: [
        "cargo",
        "check",
        "--message-format",
        "--manifest-path=/workspace/Cargo.toml",
      ],
    }]),
    "manifest-looking option value satisfied cargo check proof",
  );
  assert(
    hasWorkspaceCargoCheck([{
      args: [
        "cargo",
        "check",
        "--manifest-path",
        "/workspace/Cargo.toml",
      ],
    }]),
    "split-form workspace cargo check did not satisfy proof",
  );
  assert(
    hasWorkspaceCargoCheck([{
      args: [
        "cargo",
        "check",
        "--manifest-path=/workspace/Cargo.toml",
      ],
    }]),
    "equals-form workspace cargo check did not satisfy proof",
  );
});

Deno.test({
  name: "unchanged raw rust-analyzer Wasm publishes diagnostics",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fixtureUrl = new URL("./", import.meta.url);
    const metadataOutput = await new Deno.Command("cargo", {
      args: ["metadata", "--no-deps", "--format-version", "1"],
      cwd: fixtureUrl.pathname,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      metadataOutput.success,
      `cargo metadata failed: ${
        new TextDecoder().decode(metadataOutput.stderr)
      }`,
    );

    const metadata = JSON.parse(
      new TextDecoder().decode(metadataOutput.stdout),
    ) as CargoMetadata;
    const packageMetadata = metadata.packages[0];
    const binaryTarget = packageMetadata?.targets.find((target) =>
      target.kind.includes("bin")
    );
    assert(packageMetadata !== undefined, "cargo metadata returned no package");
    assert(
      binaryTarget !== undefined,
      "cargo metadata returned no binary target",
    );

    const cargoToml = await Deno.readFile(new URL("./Cargo.toml", fixtureUrl));
    const mainRs = await Deno.readFile(new URL("./src/main.rs", fixtureUrl));
    const src = new Map<string, Inode>([["main.rs", new File(mainRs)]]);
    const workspace = new Map<string, Inode>([
      ["Cargo.toml", new File(cargoToml)],
      ["src", new Directory(src)],
    ]);
    const rustlib = new Map<string, Inode>([
      ["src", new Directory(new Map<string, Inode>())],
    ]);
    const root = new PreopenDirectory(
      "/",
      new Map<string, Inode>([
        ["workspace", new Directory(workspace)],
        [
          "sysroot",
          new Directory(
            new Map<string, Inode>([[
              "lib",
              new Directory(
                new Map<string, Inode>([["rustlib", new Directory(rustlib)]]),
              ),
            ]]),
          ),
        ],
      ]),
    );

    const input = new AsyncLspInputQueue();
    const output = new LspOutputFd();
    const hostRequests: HostCommandRequest[] = [];
    const memory = new WebAssembly.Memory({
      initial: MEMORY_INITIAL_PAGES,
      maximum: MEMORY_MAXIMUM_PAGES,
      shared: true,
    });
    const scratch = new ScratchAllocator(
      memory.buffer.byteLength - SCRATCH_SIZE,
      memory.buffer.byteLength,
    );
    const stderr = ConsoleStdout.lineBuffered((line) =>
      console.error(`[rust-analyzer] ${line}`)
    );
    wait_async_polyfill();
    const farm = new WASIFarm(new OpenFile(new File([])), output, stderr, [
      root,
    ], {
      unknown_fn: (message) => {
        if (
          isRecord(message) && message.name === "lspStdinRead" &&
          isRecord(message.args) && typeof message.args.maxLength === "number"
        ) {
          return input.read(message.args.maxLength);
        }
        if (!isRecord(message) || message.type !== "host_run_cargo") {
          throw new Error(`unsupported farm call: ${JSON.stringify(message)}`);
        }
        const request = parseHostCommandRequest(message.request);
        console.log(`[host_run_cargo request] ${JSON.stringify(request)}`);
        const result = runLocalCommand(request, fixtureUrl.pathname, scratch);
        console.log(
          `[host_run_cargo response] status=${result.status} stdout=${result.stdout.length}@${result.stdoutPtr} stderr=${result.stderr.length}@${result.stderrPtr}`,
        );
        hostRequests.push(request);
        return result;
      },
    });
    const uri = "file:///workspace/src/main.rs";
    input.push({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: "file:///workspace",
        workspaceFolders: [{
          uri: "file:///workspace",
          name: packageMetadata.name,
        }],
        capabilities: { textDocument: { publishDiagnostics: {} } },
        initializationOptions: {
          cargo: { sysroot: null },
          procMacro: { enable: false },
          checkOnSave: true,
          cachePriming: { enable: false },
        },
      },
    });
    const wasmModule = await WebAssembly.compile(
      await Deno.readFile(
        new URL("../../crates/vfs/lsp_opt.wasm", import.meta.url),
      ),
    );
    const worker = new Worker(
      new URL("./main_worker.ts", import.meta.url).href,
      {
        type: "module",
      },
    );
    let rejectWorker: (reason: Error) => void = () => {};
    const workerFailure = new Promise<never>((_resolve, reject) => {
      rejectWorker = reject;
    });
    worker.onmessage = (event) => {
      if (event.data?.type === "error") {
        rejectWorker(new Error(event.data.error));
      } else if (event.data?.type === "exit") {
        rejectWorker(
          new Error(`rust-analyzer exited early with code ${event.data.code}`),
        );
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      rejectWorker(new Error(event.message));
    };

    try {
      worker.postMessage({
        wasiRef: farm.get_ref(),
        wasmModule,
        memory,
        threadWorkerUrl: new URL("./thread_worker.ts", import.meta.url).href,
        backgroundWorkerUrl:
          new URL("./background_worker.ts", import.meta.url).href,
      });

      const initialize = await Promise.race([
        output.waitFor(
          (message) => message.id === 1 && isRecord(message.result),
          120_000,
        ),
        workerFailure,
      ]);
      assert(isRecord(initialize.result), "initialize response has no result");
      input.push({ jsonrpc: "2.0", method: "initialized", params: {} });
      input.push({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "rust",
            version: 1,
            text: "fn main() {}\n",
          },
        },
      });

      input.push({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: new TextDecoder().decode(mainRs) }],
        },
      });
      input.push({
        jsonrpc: "2.0",
        method: "textDocument/didSave",
        params: { textDocument: { uri } },
      });

      const diagnostics = await Promise.race([
        output.waitFor((message) => {
          if (message.method === "textDocument/publishDiagnostics") {
            console.log(
              `[publishDiagnostics] ${JSON.stringify(message.params)}`,
            );
          }
          return isExpectedRustcDiagnostic(message, uri);
        }, 120_000),
        workerFailure,
      ]);
      assert(
        isRecord(diagnostics.params),
        "diagnostics response has no params",
      );
      const diagnosticItems = diagnostics.params.diagnostics;
      assert(Array.isArray(diagnosticItems), "diagnostics are not an array");
      assert(
        hasWorkspaceCargoCheck(hostRequests),
        "rust-analyzer did not run cargo check for /workspace/Cargo.toml",
      );
      console.log(
        `initialize response received; diagnostics=${diagnosticItems.length}; host_run_cargo=${hostRequests.length}; commands=${
          hostRequests.map((request) => request.args.join(" ")).join(" | ")
        }`,
      );
    } finally {
      worker.terminate();
      farm.destroy();
    }
  },
});
