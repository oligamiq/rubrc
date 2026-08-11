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

Deno.test("compressed stream delegates the tested optional cache boundary", async () => {
  const wrapper = await Deno.readTextFile("lib/src/brotli_stream.ts");
  const fetchBoundary = await Deno.readTextFile(
    "lib/src/fetch_compressed_stream.ts",
  );

  assert(
    wrapper.includes(
      'import { fetchCompressedStream } from "./fetch_compressed_stream.ts";',
    ) && wrapper.includes("fetchCompressedStream(url, signal,"),
    "public compressed stream does not delegate to the directly tested seam",
  );
  assert(
    fetchBoundary.includes("fetchWithOptionalCache,") &&
      fetchBoundary.includes('from "./fetch_with_optional_cache.ts";') &&
      fetchBoundary.includes("await fetchWithOptionalCache("),
    "compressed-response seam bypasses the optional cache boundary",
  );
});

Deno.test("browser startup budget covers cold sysroot and LSP readiness", async () => {
  const budgets = await Deno.readTextFile("scripts/lsp_browser_quiescence.mjs");
  const readiness = await Deno.readTextFile("page/src/vfs_readiness.ts");

  assert(
    budgets.includes("export const STARTUP_TIMEOUT_MS = 300_000"),
    "cold browser startup lacks the 300-second budget",
  );
  assert(
    readiness.includes("export const RUST_SRC_BOOTSTRAP_TIMEOUT_MS = 300_000"),
    "rust-src readiness lacks the 300-second budget",
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

Deno.test("Pages build injects its validated source SHA and epoch", async () => {
  const vite = await Deno.readTextFile("page/vite.config.ts");
  const publish = await Deno.readTextFile("scripts/publish-pages-dist.sh");
  const workflow = await Deno.readTextFile(".github/workflows/static.yml");
  assert(
    vite.includes('process.env.SOURCE_SHA ?? "development"'),
    "Vite source revision lacks the explicit development fallback",
  );
  assert(
    vite.includes('process.env.BUILD_EPOCH ?? "0"'),
    "Vite build epoch lacks the explicit development fallback",
  );
  assert(
    publish.includes(
      'SOURCE_SHA="$SOURCE_SHA" BUILD_EPOCH="$BUILD_EPOCH" bun run build:prod',
    ),
    "Pages publisher does not pass its SHA and epoch into build:prod",
  );
  assert(
    publish.includes("BUILD_EPOCH=$((PREVIOUS_BUILD_EPOCH + 1))") &&
      publish.includes("buildEpoch: Number(process.env.BUILD_EPOCH)"),
    "Pages publisher does not generate and record the next build epoch",
  );
  assert(
    publish.indexOf('REMOTE_DIST_SHA="$(') <
      publish.indexOf("bun run build:prod") &&
      publish.includes(
        '--force-with-lease="refs/heads/pages-dist:${REMOTE_DIST_SHA}"',
      ),
    "Pages publisher does not bind its epoch to the push lease base",
  );
  assert(
    workflow.includes("Number.isSafeInteger(metadata.buildEpoch)"),
    "Pages workflow does not validate the deployment build epoch",
  );
});

Deno.test("Pages artifact retains deployment metadata", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/static.yml");
  const metadataCheck = workflow.indexOf(
    "test -f site/.rubrc-pages-build.json",
  );
  const artifactUpload = workflow.indexOf(
    "uses: actions/upload-pages-artifact",
  );
  assert(
    !workflow.includes("rm -f site/.rubrc-pages-build.json"),
    "Pages workflow deletes deployment metadata",
  );
  assert(
    metadataCheck >= 0 && metadataCheck < artifactUpload,
    "Pages workflow does not retain metadata through artifact upload",
  );
});
