const viteConfigSource = await Deno.readTextFile(
  new URL("../vite.config.ts", import.meta.url),
);
const source = await Deno.readTextFile(
  new URL("./monaco_worker.ts", import.meta.url),
);
const indexSource = await Deno.readTextFile(
  new URL("./index.tsx", import.meta.url),
);
const pagePackage = JSON.parse(
  await Deno.readTextFile(new URL("../package.json", import.meta.url)),
) as { dependencies?: Record<string, string> };
const editorWorkerSource = await Deno.readTextFile(
  new URL("./workers/editor.worker.ts", import.meta.url),
);

Deno.test("Rust highlighting uses the VS Code TextMate grammar without semantic recoloring", () => {
  if (
    pagePackage.dependencies?.[
      "@codingame/monaco-vscode-rust-default-extension"
    ] !== "25.1.2"
  ) {
    throw new Error("the pinned VS Code Rust default extension is missing");
  }
  if (
    pagePackage.dependencies?.[
      "@codingame/monaco-vscode-textmate-service-override"
    ] !== "25.1.2"
  ) {
    throw new Error("the pinned TextMate service override is missing");
  }
  const rustExtensionImport =
    'import "@codingame/monaco-vscode-rust-default-extension";';
  const extensionOffset = indexSource.indexOf(rustExtensionImport);
  const wrapperStartOffset = indexSource.indexOf("await apiWrapper.start()");
  if (
    extensionOffset < 0 ||
    wrapperStartOffset < 0 ||
    extensionOffset > wrapperStartOffset
  ) {
    throw new Error(
      "the Rust TextMate grammar is not registered before Monaco starts",
    );
  }
  if (!indexSource.includes('$type: "extended"')) {
    throw new Error(
      "the extended Monaco wrapper is required for TextMate highlighting",
    );
  }
  if (
    !indexSource.includes('"[rust]": {') ||
    !indexSource.includes('"editor.semanticHighlighting.enabled": false')
  ) {
    throw new Error(
      "rust-analyzer semantic token recoloring is not disabled for Rust only",
    );
  }
  if (source.includes('monaco.languages.register({ id: "rust"')) {
    throw new Error(
      "manual Rust language registration shadows the VS Code Rust extension",
    );
  }
});
Deno.test("Monaco worker setup avoids empty aliased language workers", () => {
  if (source.includes("monaco-editor/esm/vs/language/")) {
    throw new Error(
      "the CodinGame monaco-editor alias exports language workers as empty modules",
    );
  }
  if (!source.includes("./workers/editor.worker.ts?worker")) {
    throw new Error("the local Monaco editor worker import is missing");
  }
  if (
    !source.includes(
      "@codingame/monaco-vscode-textmate-service-override/worker?worker",
    ) ||
    !source.includes('label === "TextMateWorker"') ||
    !source.includes("new textMateWorker()")
  ) {
    throw new Error("the TextMate background tokenizer worker is not routed");
  }
  if (
    !editorWorkerSource.includes("monaco-editor/esm/vs/editor/editor.worker.js")
  ) {
    throw new Error("the base Monaco editor worker import is missing");
  }
});

Deno.test("Vite pre-optimizes the resolved Monaco editor worker entry", () => {
  const resolvedWorkerEntry =
    "@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js";
  const includeBlock =
    viteConfigSource.match(
      /optimizeDeps\s*:\s*\{[\s\S]*?include\s*:\s*\[([\s\S]*?)\]/,
    )?.[1] ?? "";
  if (!includeBlock.includes(`"${resolvedWorkerEntry}"`)) {
    throw new Error(`optimizeDeps.include is missing ${resolvedWorkerEntry}`);
  }
});

Deno.test("Vite dev disables browser cache for patched WASI thread shim modules", () => {
  const cacheGuardPluginSource = viteConfigSource.match(
    /function wasiThreadShimCacheGuardPlugin\(\): Plugin \{[\s\S]*?\n\}/,
  )?.[0];
  if (!cacheGuardPluginSource) {
    throw new Error("Vite dev cache guard plugin is missing");
  }
  if (!cacheGuardPluginSource.includes('apply: "serve"')) {
    throw new Error("cache guard is not limited to the Vite dev server");
  }
  if (
    !/rawUrl\?\.includes\("\/@fs\/"\)\s*&&\s*rawUrl\.includes\(\s*"\/node_modules\/@oligami\/browser_wasi_shim-threads\/"\s*,?\s*\)/.test(
      cacheGuardPluginSource,
    )
  ) {
    throw new Error(
      "cache guard does not require both the Vite /@fs/ URL and patched package path",
    );
  }
  if (
    !cacheGuardPluginSource.includes(
      "response.setHeader = function (name, value)",
    ) ||
    !cacheGuardPluginSource.includes(
      'name.toLowerCase() === "cache-control" ? "no-store" : value',
    )
  ) {
    throw new Error("cache guard does not override downstream cache headers");
  }
  if (
    !/const isDevelopmentServer\s*=\s*command === "serve"\s*&&\s*isPreview !== true/.test(
      viteConfigSource,
    ) ||
    !viteConfigSource.includes(
      "...(isDevelopmentServer ? [wasiThreadShimCacheGuardPlugin()] : [])",
    )
  ) {
    throw new Error("cache guard is not excluded from Vite preview");
  }
});
