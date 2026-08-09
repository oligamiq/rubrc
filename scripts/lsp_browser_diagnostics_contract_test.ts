const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("browser acceptance separates startup and interaction budgets", async () => {
  const source = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );
  const readinessIndex = source.indexOf(
    "const testApi = window.__rubrcLspTest;",
  );
  const didOpenIndex = source.indexOf(
    "testApi.mainDidOpenComplete === true",
    readinessIndex,
  );
  const initialPublicationIndex = source.indexOf(
    "testApi.mainDiagnosticsPublicationCount > 0",
    didOpenIndex,
  );
  const startupTimeoutIndex = source.indexOf(
    "timeout: STARTUP_TIMEOUT_MS",
    initialPublicationIndex,
  );

  assert(readinessIndex >= 0, "composite startup readiness wait is missing");
  assert(
    source.includes('write.path === "/src/main.rs"'),
    "startup readiness does not require main VFS pre-population",
  );
  assert(
    didOpenIndex > readinessIndex,
    "startup wait does not include didOpen",
  );
  assert(
    initialPublicationIndex > didOpenIndex,
    "startup wait does not include the initial diagnostics publication",
  );
  assert(
    startupTimeoutIndex > initialPublicationIndex,
    "composite startup wait does not use the startup budget",
  );
  assert(
    !source.includes("timeout: 120_000"),
    "a diagnostics wait still uses the old 120-second budget",
  );
  assert(
    source.includes("timeout: DIAGNOSTICS_TIMEOUT_MS"),
    "post-mutation diagnostics waits do not use the interaction budget",
  );
});

Deno.test("browser acceptance requires semantic rust-analyzer markers", async () => {
  const source = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );
  const budgets = await Deno.readTextFile("scripts/lsp_browser_quiescence.mjs");

  assert(
    source.includes('let value: i32 = "wrong"'),
    "browser fixture is not a semantic type mismatch",
  );
  assert(
    source.includes('marker.source === "rust-analyzer"'),
    "browser acceptance does not require a rust-analyzer marker",
  );
  assert(
    source.includes('marker.message.includes("i32")') &&
      source.includes('marker.message.includes("str")'),
    "browser acceptance does not identify the type mismatch",
  );
  assert(
    budgets.includes("export const ANALYSIS_TIMEOUT_MS = 300_000"),
    "semantic analysis lacks the 300-second budget",
  );
  assert(
    (source.match(/remainingAnalysisBudget\(\)/g)?.length ?? 0) >= 3,
    "semantic waits do not consume one shared analysis budget",
  );
});

Deno.test("browser acceptance fails any file service resolution error", async () => {
  const source = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );
  assert(
    source.includes("workspace file service errors"),
    "file service errors lack a targeted failure",
  );
  assert(
    source.includes("file:///src/main.rs"),
    "canonical main file URI missing",
  );
});

Deno.test("semantic diagnostics worker uses production shared memory", async () => {
  const source = await Deno.readTextFile(
    "scripts/vfs_lsp_diagnostics_worker.ts",
  );

  assert(
    source.includes("share_memory: {") &&
      source.includes("initial: 1032") &&
      source.includes("maximum: 32775") &&
      source.includes("shared: true"),
    "diagnostics worker does not configure production-equivalent shared memory",
  );
});

Deno.test("semantic diagnostics worker clears the full mismatch document", async () => {
  const source = await Deno.readTextFile(
    "scripts/vfs_lsp_diagnostics_worker.ts",
  );

  assert(
    source.includes("rangeLength: 40"),
    "semantic clear does not replace all 40 UTF-16 units",
  );
});

Deno.test("semantic diagnostics worker disables cargo build scripts", async () => {
  const source = await Deno.readTextFile(
    "scripts/vfs_lsp_diagnostics_worker.ts",
  );
  const initializationOptions = source.slice(
    source.indexOf("initializationOptions: {"),
    source.indexOf("linkedProjects:"),
  );

  assert(
    /cargo:\s*\{\s*sysroot:\s*"\/sysroot",\s*buildScripts:\s*\{\s*enable:\s*false\s*\}\s*\}/.test(
      initializationOptions,
    ),
    "semantic diagnostics worker does not disable cargo build scripts",
  );
});

Deno.test("compressed stream delegates the optional cache boundary", async () => {
  const source = await Deno.readTextFile("lib/src/brotli_stream.ts");

  assert(
    source.includes(
      'import { fetchWithOptionalCache } from "./fetch_with_optional_cache.ts";',
    ),
    "compressed stream does not import the tested cache boundary",
  );
  assert(
    source.includes("await fetchWithOptionalCache("),
    "compressed stream does not delegate to the tested cache boundary",
  );
});

Deno.test("browser startup budget covers cold sysroot and LSP readiness", async () => {
  const budgets = await Deno.readTextFile("scripts/lsp_browser_quiescence.mjs");

  assert(
    budgets.includes("export const STARTUP_TIMEOUT_MS = 300_000"),
    "cold browser startup lacks the 300-second budget",
  );
});

Deno.test("browser readiness requires one named Rust model and an editable editor", async () => {
  const source = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );
  assert(
    source.includes("rustModels.length === 1") &&
      source.includes('rustModels[0].uri.toString() === "file:///src/main.rs"'),
    "browser readiness does not require exactly one named Rust model",
  );
  assert(
    source.includes("testApi.editor.getOption(") &&
      source.includes("testApi.monaco.editor.EditorOption.readOnly") &&
      source.includes("=== false"),
    "browser readiness does not require an editable mounted editor",
  );
});
