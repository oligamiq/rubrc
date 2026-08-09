import { LspStartGate } from "./lsp_start_gate.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("gate starts exactly once after both readiness states", async () => {
  for (const order of ["monaco-first", "vfs-first"] as const) {
    let starts = 0;
    let disposals = 0;
    const gate = new LspStartGate<object>(async () => {
      starts++;
      return {
        async dispose() {
          disposals++;
        },
      };
    });
    if (order === "monaco-first") {
      gate.setMonaco({});
      gate.setVfsResult({ ok: true });
    } else {
      gate.setVfsResult({ ok: true });
      gate.setMonaco({});
    }
    gate.setVfsResult({ ok: true });
    gate.setMonaco({});
    await gate.started();
    assert(starts === 1, `${order} started ${starts} times`);
    await gate.dispose();
    assert(disposals === 1, `${order} disposed ${disposals} times`);
  }
});

Deno.test("gate never starts after disposal", async () => {
  let starts = 0;
  const gate = new LspStartGate<object>(async () => {
    starts++;
    return { async dispose() {} };
  });
  await gate.dispose();
  gate.setMonaco({});
  gate.setVfsResult({ ok: true });
  assert(starts === 0, "disposed gate started");
});

Deno.test("failed startup is not retried within the same mount", async () => {
  let starts = 0;
  const gate = new LspStartGate<object>(async () => {
    starts++;
    throw new Error("start failed");
  });
  gate.setMonaco({});
  gate.setVfsResult({ ok: true });
  await gate.started()?.catch(() => undefined);
  gate.setMonaco({});
  gate.setVfsResult({ ok: true });
  await gate.started()?.catch(() => undefined);
  assert(starts === 1, `failed startup retried ${starts} times`);
});

Deno.test("failed VFS readiness settles without starting LSP", () => {
  let starts = 0;
  const gate = new LspStartGate<object>(async () => {
    starts++;
    return { async dispose() {} };
  });
  gate.setMonaco({});
  gate.setVfsResult({ ok: false, error: "rust-src failed" });
  gate.setVfsResult({ ok: true });
  assert(starts === 0, "failed VFS bootstrap started LSP");
});

Deno.test("App mounts the editor before LSP startup but defers the main model", async () => {
  const source = await Deno.readTextFile("page/src/App.tsx");
  const indexSource = await Deno.readTextFile("page/src/index.tsx");
  const viteSource = await Deno.readTextFile("page/vite.config.ts");
  const rustLspModuleImport =
    /from\s*["']\.\/rust_lsp_client(?:\.(?:ts|js))?["']/;

  assert(
    !rustLspModuleImport.test(indexSource),
    "index.tsx must not statically import rust_lsp_client",
  );
  assert(
    /startLspClient\s*=/.test(indexSource) &&
      /await\s+import\s*\(\s*["']\.\/rust_lsp_client(?:\.(?:ts|js))?["']\s*\)/.test(
        indexSource,
      ),
    "index.tsx must inject an entry-owned dynamic LSP starter",
  );
  assert(
    !rustLspModuleImport.test(source),
    "App must not import rust_lsp_client",
  );
  assert(
    /startLspClient\s*:/.test(source) &&
      source.includes("Promise<DisposableLspSession>"),
    "App must accept the typed injected LSP starter",
  );
  assert(
    /new\s+LspStartGate[\s\S]*?\(\s*(?:props\.)?startLspClient\s*,?\s*\)/.test(
      source,
    ),
    "App must give the injected starter to LspStartGate",
  );
  const dedupeBlock = viteSource.match(/dedupe\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  for (const dependency of [
    "vscode",
    "@codingame/monaco-vscode-api",
    "@codingame/monaco-vscode-extension-api",
    "@codingame/monaco-vscode-extensions-service-override",
  ]) {
    assert(
      dedupeBlock.includes(`"${dependency}"`) ||
        dedupeBlock.includes(`'${dependency}'`),
      `Vite does not dedupe ${dependency}`,
    );
  }
  const mountIndex = source.indexOf("const handleMount");
  const mountedMonacoIndex = source.indexOf(
    "lspGate.setMonaco(mountedMonaco)",
    mountIndex,
  );
  const startedIndex = source.indexOf("const started = lspGate.started()");
  const readyIndex = source.indexOf(
    "started.then(() => setIsLspReady(true))",
    startedIndex,
  );

  assert(mountIndex >= 0, "Monaco mount handler is missing");
  assert(
    mountedMonacoIndex > mountIndex,
    "mounted Monaco does not satisfy the LSP startup gate",
  );
  assert(
    !source.includes("lspGate.setMonaco(monaco);"),
    "module-level Monaco satisfies the gate before editor mount",
  );
  assert(
    !source.includes("when={isLspReady()}"),
    "editor rendering is blocked on successful LSP startup",
  );
  assert(
    readyIndex > startedIndex,
    "LSP readiness is not set from the resolved startup promise",
  );
  assert(
    source.includes(
      'path={isLspReady() ? "file:///src/main.rs" : undefined}',
    ),
    "main Rust path is supplied before LSP startup completes",
  );
  assert(
    source.includes("value={isLspReady() ? default_value : undefined}"),
    "main Rust value is supplied before LSP startup completes",
  );
  assert(
    !source.includes('path="file:///src/main.rs"'),
    "main Rust path remains unconditional",
  );
});
