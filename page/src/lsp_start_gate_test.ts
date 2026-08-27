const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const readSource = (path: string) => Deno.readTextFile(path);

Deno.test("App creates and attaches the editable named model at mount", async () => {
  const source = await readSource("page/src/App.tsx");
  const mountIndex = source.indexOf("const handleMount");
  const uriIndex = source.indexOf(
    'mountedMonaco.Uri.parse("file:///src/main.rs")',
    mountIndex,
  );
  const getModelIndex = source.indexOf(
    "mountedMonaco.editor.getModel(uri)",
    uriIndex,
  );
  const readWorkspaceIndex = source.indexOf(
    'workspaceFileSystem.readFile("/src/main.rs")',
    getModelIndex,
  );
  const createModelIndex = source.indexOf(
    'mountedMonaco.editor.createModel(initialText, "rust", uri)',
    readWorkspaceIndex,
  );
  const attachIndex = source.indexOf("mountedEditor.setModel(model)", uriIndex);
  const disposeTemporaryIndex = source.indexOf(
    "temporaryModel.dispose()",
    attachIndex,
  );
  const editableIndex = source.indexOf(
    "mountedEditor.updateOptions({ readOnly: false })",
    attachIndex,
  );
  const prepareIndex = source.indexOf(
    "props.registerRemountPreparation?.(async () => {",
    editableIndex,
  );
  const freezeIndex = source.indexOf(
    "mountedEditor.updateOptions({ readOnly: true })",
    prepareIndex,
  );
  const persistIndex = source.indexOf(
    "workspaceFileSystem.writeFile(",
    freezeIndex,
  );
  const flushIndex = source.indexOf("await runtime.flushWorkspace()", persistIndex);

  assert(mountIndex >= 0, "Monaco mount handler is missing");
  assert(uriIndex > mountIndex, "named model URI is not created during mount");
  assert(getModelIndex > uriIndex, "mount does not reuse the named model");
  assert(
    readWorkspaceIndex > getModelIndex,
    "mount does not restore main.rs from the persistent workspace",
  );
  assert(
    createModelIndex > readWorkspaceIndex,
    "mount does not create a rust named model from persistent text",
  );
  assert(
    source.includes('language="plaintext"'),
    "Monaco wrapper creates a competing temporary Rust model",
  );
  assert(
    attachIndex > createModelIndex,
    "named model is not attached immediately",
  );
  assert(
    disposeTemporaryIndex > attachIndex,
    "wrapper-created temporary model is not disposed after named model attachment",
  );
  assert(
    editableIndex > attachIndex,
    "named model is not editable on attachment",
  );
  assert(
    prepareIndex > editableIndex && freezeIndex > prepareIndex &&
      persistIndex > freezeIndex && flushIndex > persistIndex,
    "remount preparation does not freeze, persist, then flush the named model",
  );
  assert(
    !source.includes("modelSwitchDisposable") &&
      !source.includes("setModel(null)") &&
      !source.includes("model.dispose()"),
    "App retains temporary-model recreation or disposal code",
  );
  assert(
    !source.slice(0, prepareIndex).includes("readOnly: !") &&
      !source.slice(0, prepareIndex).includes("readOnly: true"),
    "App can attach the editor read-only during startup",
  );
});

Deno.test("remount preparation persists every file-backed Monaco model", async () => {
  const source = await readSource("page/src/App.tsx");
  const prepareIndex = source.indexOf(
    "props.registerRemountPreparation?.(async () => {",
  );
  const modelsIndex = source.indexOf(
    "mountedMonaco.editor.getModels()",
    prepareIndex,
  );
  const fileIndex = source.indexOf(
    'workspaceModel.uri.scheme !== "file"',
    modelsIndex,
  );
  const persistIndex = source.indexOf(
    "workspaceFileSystem.writeFile(",
    fileIndex,
  );

  assert(
    prepareIndex >= 0 && modelsIndex > prepareIndex && fileIndex > modelsIndex &&
      persistIndex > fileIndex,
    "startup remount can drop pending edits from secondary file models",
  );
});

Deno.test("App wires the runtime-owned archive store into staged startup", async () => {
  const source = await readSource("page/src/App.tsx");
  const xtermSource = await readSource("page/src/xterm.tsx");
  const coordinatorIndex = source.indexOf("new StartupCoordinator(");

  assert(coordinatorIndex >= 0, "App does not construct a startup coordinator");
  assert(
    !source.includes("new SysrootArchiveStore()"),
    "App creates a second archive store outside runtime ownership",
  );
  assert(
    source.includes("runtime.archiveStore.prefetch(") &&
      source.includes('["rust-src", "wasm32-wasip1"]'),
    "coordinator does not prefetch startup sysroots from the runtime store",
  );
  assert(
    source.includes("runtime.ctx.install_startup_sysroots_id") &&
      source.includes("awaitStartupSysrootsSettlement"),
    "coordinator does not use the startup-sysroot installation endpoint",
  );
  assert(
    /props\.startLspClient\(\s*mountedMonaco,\s*model as monaco\.editor\.ITextModel,?\s*\)/.test(
      source,
    ),
    "coordinator does not initialize the analyzer with Monaco and named model",
  );
  assert(
    source.includes("flush: () => session.flush()") &&
      source.includes("dispose: () => session.dispose()"),
    "coordinator wrapper does not preserve class-backed session methods",
  );
  assert(
    !source.includes("archiveStore.dispose()"),
    "App duplicates runtime archive-store disposal",
  );
  assert(
    !xtermSource.includes("SysrootArchiveStore") &&
      !xtermSource.includes("archiveStore"),
    "terminal receives an archive store outside runtime ownership",
  );
});

Deno.test("entrypoint creates one page supervisor beside the persistent workspace", async () => {
  const source = await readSource("page/src/index.tsx");

  assert(
    source.includes("new RuntimeSupervisor("),
    "entrypoint does not create a RuntimeSupervisor",
  );
  assert(
    source.includes("runtimeSupervisor.create()"),
    "entrypoint does not obtain one runtime from the supervisor",
  );
  assert(
    /<App\s+runtime=\{runtime\}/.test(source),
    "entrypoint does not pass the runtime to App",
  );
  assert(
    source.includes("workspaceFileSystem") &&
      source.indexOf("workspaceFileSystem") < source.indexOf("new RuntimeSupervisor("),
    "persistent workspace is not page-level supervisor input",
  );
  assert(
    !source.includes("worker_process/worker") &&
      !source.includes("terminateWorker") &&
      !source.includes("WASIFarmRefObject"),
    "entrypoint retains the forwarding-worker owner",
  );
});

Deno.test("App exposes startup state and gates run and target changes", async () => {
  const source = await readSource("page/src/App.tsx");

  assert(
    source.includes("coordinator.subscribe(setStartup)") ||
      /coordinator\.subscribe\(\(snapshot\)\s*=>\s*\{[\s\S]*?setStartup\(snapshot\)/.test(
        source,
      ),
    "App does not subscribe its Solid startup signal to the coordinator",
  );
  assert(
    source.includes("unsubscribeStartup()"),
    "App cleanup does not unsubscribe from coordinator snapshots",
  );
  assert(
    source.includes("runtime.dispose()") &&
      !source.includes("coordinator.dispose()"),
    "App cleanup bypasses canonical runtime disposal",
  );
  assert(
    /<StartupOverlay\s+state=\{startup\(\)\}/.test(source),
    "App does not render the coordinator snapshot in StartupOverlay",
  );
  assert(
    /<RunButton[\s\S]*?run=\{\(triple\) => runtime\.run\(triple\)\}/.test(source),
    "RunButton does not dispatch through the runtime",
  );
  assert(
    source.includes('runtimeState().operation !== "idle"'),
    "RunButton is not gated by runtime operation state",
  );
  assert(
    source.includes("targetErrors.load(triple") &&
      source.includes("runtime.loadTarget(triple)"),
    "target selector does not load through the runtime",
  );
  assert(
    !source.includes("LspStartGate") && !source.includes("lspGate"),
    "App still uses the old LSP gate",
  );
});

Deno.test("entrypoint starts LSP from canonical runtime dependencies", async () => {
  const source = await readSource("page/src/index.tsx");

  assert(
    /startLspClient=\{\(monaco, model\) =>/.test(source),
    "entrypoint starter does not accept the named model",
  );
  assert(
    source.includes(
      "startRustLspClient(runtime.lspDependencies, monaco, model)",
    ),
    "entrypoint does not use runtime-owned LSP dependencies",
  );
});

Deno.test("App adopts startup and attaches the model before runtime startup", async () => {
  const source = await readSource("page/src/App.tsx");
  const coordinatorIndex = source.indexOf("new StartupCoordinator(");
  const adoptIndex = source.indexOf("runtime.adoptCoordinator(coordinator)");
  const mountIndex = source.indexOf("const handleMount");
  const attachIndex = source.indexOf("mountedEditor.setModel(model)", mountIndex);
  const editableIndex = source.indexOf(
    "mountedEditor.updateOptions({ readOnly: false })",
    attachIndex,
  );
  const runtimeStartIndex = source.indexOf("runtime.start()", editableIndex);
  const stagedStartIndex = source.indexOf("coordinator.start(model)", runtimeStartIndex);

  assert(coordinatorIndex >= 0, "startup coordinator is missing");
  assert(
    adoptIndex > coordinatorIndex && adoptIndex < mountIndex,
    "coordinator is not synchronously adopted before mount startup",
  );
  assert(attachIndex > mountIndex, "named model is not attached at mount");
  assert(editableIndex > attachIndex, "named model is not made editable");
  assert(
    runtimeStartIndex > editableIndex,
    "runtime starts before the named editable model is attached",
  );
  assert(
    stagedStartIndex > runtimeStartIndex,
    "language activation can start before runtime startup",
  );
  assert(
    !source.includes("disposeAppStartup({") &&
      !source.includes("coordinator.dispose()"),
    "App duplicates adopted coordinator disposal",
  );
  assert(
    source.includes("runtime.dispose()"),
    "App cleanup does not use canonical runtime disposal",
  );
});

Deno.test("adopted coordinator preserves the runtime abort reason", async () => {
  const source = await readSource("page/src/startup_coordinator.ts");
  assert(
    source.includes("abort(reason") && source.includes("this.#controller.abort(reason)"),
    "StartupCoordinator cannot be aborted with the runtime failure",
  );
});

Deno.test("overlay preserves the editor and renders determinate, indeterminate, and failure states", async () => {
  const source = await readSource("page/src/StartupOverlay.tsx");
  const appSource = await readSource("page/src/App.tsx");

  assert(
    source.includes("{task.label}"),
    "overlay does not render task labels",
  );
  assert(
    source.includes("task.progress === undefined") &&
      source.includes("animate-pulse") &&
      !source.includes("0%"),
    "tasks without totals do not render an indeterminate marker",
  );
  assert(
    source.includes("state().error") && source.includes("{state().error}"),
    "overlay does not show the exact originating failure message",
  );
  assert(
    source.includes("pointer-events-none") &&
      source.includes("absolute") &&
      source.includes("inset-0"),
    "overlay is not editor-local and click-through",
  );
  assert(
    appSource.includes('class="relative h-[30vh]"') &&
      /<MonacoEditor[\s\S]*?<StartupOverlay/.test(appSource),
    "overlay does not retain the Monaco code container beneath it",
  );
});

Deno.test("test API exposes the named model immediately", async () => {
  const source = await readSource("page/src/lsp_test_api.ts");
  const appSource = await readSource("page/src/App.tsx");

  assert(
    source.includes("model?: Monaco.editor.ITextModel"),
    "test API lacks model",
  );
  assert(
    /exposeEditor\([\s\S]*?model: Monaco\.editor\.ITextModel/.test(source),
    "test API exposure does not receive the named model",
  );
  assert(
    source.includes("beginLspTestGeneration("),
    "test API does not start a generation",
  );
  assert(
    /exposeEditor\(\s*mountedMonaco,\s*mountedEditor,\s*model,\s*runtime,?\s*\)/.test(
      appSource,
    ),
    "App does not expose the model at mount",
  );
});

Deno.test("test entrypoint remounts only after canonical runtime disposal", async () => {
  const source = await readSource("page/src/index.tsx");
  const appSource = await readSource("page/src/App.tsx");
  const mountIndex = source.indexOf("const mountGeneration");
  const remountIndex = source.indexOf("const remountRuntime", mountIndex);
  const flushRaceIndex = source.indexOf("await Promise.race([", remountIndex);
  const flushDeadlineIndex = source.indexOf(
    "REMOUNT_FLUSH_TIMEOUT_MS",
    remountIndex,
  );
  const prepareIndex = source.indexOf("prepareAppForRemount()", remountIndex);
  const unmountIndex = source.indexOf("disposeApp?.()", remountIndex);
  const disposeIndex = source.indexOf("await runtime.dispose()", remountIndex);
  const nextMountIndex = source.indexOf("await mountGeneration()", disposeIndex);

  assert(mountIndex >= 0, "entrypoint lacks a reusable generation mount");
  assert(remountIndex > mountIndex, "test remount control is not page-level");
  assert(
    flushRaceIndex > remountIndex && prepareIndex > flushRaceIndex &&
      flushDeadlineIndex > prepareIndex,
    "pre-remount workspace flush has no teardown deadline",
  );
  assert(
    prepareIndex > remountIndex && prepareIndex < unmountIndex,
    "ready workspace edits are not flushed before editor unmount",
  );
  assert(
    unmountIndex > prepareIndex && disposeIndex > unmountIndex &&
      nextMountIndex > disposeIndex,
    "remount does not await AppRuntime.dispose before supervisor admission",
  );
  assert(
    source.includes("installRuntimeRemountTestControl(remountRuntime)"),
    "browser test API cannot request a supervisor-owned remount",
  );
  for (const phase of ["disposing", "mounting", "mounted", "failed"]) {
    assert(
      source.includes(`recordRuntimeRemountPhase("${phase}"`),
      `browser test API cannot observe remount phase ${phase}`,
    );
  }
  assert(
    source.includes("recordRuntimeRemountDisposalFailure(error)"),
    "browser test API cannot observe the canonical disposal rejection",
  );
  assert(
    source.includes("renderRuntimeFailure({") &&
      source.includes("reloadRequired: runtime?.phase === \"reload-required\"") &&
      source.includes("if (flushError !== undefined)"),
    "flush failure does not render a post-disposal runtime failure",
  );
  const cleanupIndex = appSource.indexOf("onCleanup(() => {");
  const runtimeDisposeIndex = appSource.indexOf("runtime.dispose()", cleanupIndex);
  const generationDisposeIndex = appSource.indexOf("generation?.dispose()", cleanupIndex);
  assert(
    runtimeDisposeIndex > cleanupIndex && generationDisposeIndex > runtimeDisposeIndex,
    "App drops lifecycle recording before canonical disposal settles",
  );
});
