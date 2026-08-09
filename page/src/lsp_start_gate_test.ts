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

Deno.test("gate disposal aborts and settles an in-progress starter", async () => {
  let starts = 0;
  let observedSignal: AbortSignal | undefined;
  const gate = new LspStartGate<object>((_monaco, signal) => {
    starts++;
    observedSignal = signal;
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  gate.setMonaco({});
  gate.setVfsResult({ ok: true });

  await gate.dispose();

  assert(starts === 1, `starter called ${starts} times`);
  assert(observedSignal?.aborted, "gate disposal did not abort startup");
});

Deno.test("App mounts the editor before LSP startup but defers the main model", async () => {
  const source = await Deno.readTextFile("page/src/App.tsx");
  const indexSource = await Deno.readTextFile("page/src/index.tsx");
  const viteSource = await Deno.readTextFile("page/vite.config.ts");
  const rustLspStaticImport =
    /(?:\bimport\s*|\bfrom\s*)["']\.\/rust_lsp_client(?:\.(?:ts|js))?["']/;
  const rustLspDynamicImport =
    /\bimport\s*\(\s*["']\.\/rust_lsp_client(?:\.(?:ts|js))?["']\s*\)/;

  assert(
    rustLspStaticImport.test('import "./rust_lsp_client";'),
    "static-import matcher must reject side-effect imports",
  );
  assert(
    rustLspDynamicImport.test('await import("./rust_lsp_client")'),
    "dynamic-import matcher must detect direct module ownership",
  );

  assert(
    !rustLspStaticImport.test(indexSource),
    "index.tsx must not statically import rust_lsp_client",
  );
  assert(
    /startLspClient\s*=/.test(indexSource) &&
      rustLspDynamicImport.test(indexSource),
    "index.tsx must inject an entry-owned dynamic LSP starter",
  );
  assert(
    !rustLspStaticImport.test(source) && !rustLspDynamicImport.test(source),
    "App must not import rust_lsp_client",
  );
  assert(
    /startLspClient\s*:/.test(source) &&
      source.includes("Promise<DisposableLspSession>"),
    "App must accept the typed injected LSP starter",
  );
  assert(
    source.includes("signal: AbortSignal"),
    "App starter lacks AbortSignal",
  );
  assert(
    /new\s+LspStartGate[\s\S]*?\(\s*(?:props\.)?startLspClient\s*,?\s*\)/.test(
      source,
    ),
    "App must give the injected starter to LspStartGate",
  );
  const dedupeBlock =
    viteSource.match(/dedupe\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
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
    !source.includes('path={isLspReady() ? "file:///src/main.rs" : undefined}'),
    "Monaco wrapper competes with the explicit model handoff",
  );
  assert(
    !source.includes("value={isLspReady() ? default_value : undefined}"),
    "Monaco wrapper overwrites the LSP-owned model value",
  );
  assert(
    !source.includes('path="file:///src/main.rs"'),
    "main Rust path remains unconditional",
  );
  assert(
    /(?:const|let)\s+\[isEditorReady,\s*setIsEditorReady\]\s*=\s*createSignal\(false\)/.test(
      source,
    ),
    "App lacks editor-specific readiness",
  );
  assert(
    source.includes('language="plaintext"'),
    "Monaco wrapper language changes after the Rust model is attached",
  );
  assert(
    source.includes("readOnly: !isEditorReady()"),
    "temporary Monaco model is not reactively read-only",
  );
  assert(
    /(?:(?:const|let)\s+)?temporaryModel\s*=\s*mountedEditor\.getModel\(\)/.test(
      source,
    ) && source.includes("mountedEditor.onDidChangeModel("),
    "App does not observe the temporary-to-named model switch",
  );
  assert(
    /\[mountedMonacoRef,\s*setMountedMonacoRef\]\s*=\s*createSignal</.test(
      source,
    ) &&
      /\[mountedEditorRef,\s*setMountedEditorRef\]\s*=\s*createSignal</.test(
        source,
      ),
    "mounted Monaco and editor refs are not reactive signals",
  );
  const monacoRefIndex = source.indexOf("setMountedMonacoRef(mountedMonaco)");
  const editorRefIndex = source.indexOf("setMountedEditorRef(mountedEditor)");
  assert(
    monacoRefIndex >= 0 &&
      editorRefIndex > monacoRefIndex &&
      mountedMonacoIndex > editorRefIndex,
    "mounted refs must be assigned before Monaco can start the LSP gate",
  );
  const targetCheck = source.indexOf(
    'currentModel?.uri.toString() !== "file:///src/main.rs"',
  );
  const detachTemporary = source.indexOf("mountedEditor.setModel(null)");
  const temporaryDispose = source.indexOf(
    "temporaryModel?.dispose()",
    detachTemporary,
  );
  const namedModelSwitch = source.indexOf(
    "mountedEditor.setModel(mainModel)",
    temporaryDispose,
  );
  const editorReady = source.indexOf(
    "setIsEditorReady(true)",
    temporaryDispose,
  );
  const listenerDispose = source.indexOf(
    "modelSwitchDisposable?.dispose()",
    editorReady,
  );
  assert(
    targetCheck >= 0,
    "model listener does not require the named Rust URI",
  );
  assert(
    detachTemporary >= 0 &&
      temporaryDispose > detachTemporary &&
      namedModelSwitch > temporaryDispose,
    "model handoff must detach, dispose the temporary model, then attach the named model",
  );
  assert(
    editorReady > targetCheck && listenerDispose > editorReady,
    "named-model listener must mark ready, then self-dispose",
  );
  assert(
    !source.includes("setModelLanguage("),
    "model handoff mutates the named model language",
  );
  assert(
    !source.includes("setIsEditorReady(isLspReady())"),
    "LSP readiness incorrectly controls editor mutability",
  );
  const cleanupIndex = source.indexOf("onCleanup(() => {");
  const cleanupEnd = source.indexOf("sharedReady.bc.close()", cleanupIndex);
  const cleanupBlock = source.slice(cleanupIndex, cleanupEnd);
  assert(
    cleanupIndex >= 0 && cleanupEnd > cleanupIndex,
    "App cleanup is missing",
  );
  assert(
    cleanupBlock.includes("modelSwitchDisposable?.dispose()"),
    "App cleanup does not dispose the model switch listener",
  );
  assert(
    cleanupBlock.includes("temporaryModel?.dispose()"),
    "App cleanup does not dispose the temporary model",
  );
  assert(
    source.includes('console.error("LSP gate cleanup failed:", error)'),
    "App does not observe asynchronous gate cleanup failures",
  );
});
