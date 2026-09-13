import { readdir, readFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import {
  ANALYSIS_TIMEOUT_MS,
  DIAGNOSTICS_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  waitForDiagnosticsQuiescence,
} from "./lsp_browser_quiescence.mjs";
import {
  inspectConsoleArguments,
  shouldSuppressOptionalMetadataNotFound,
} from "./lsp_browser_console_error.mjs";
import { safeFailureState } from "./lsp_browser_failure_state.mjs";
import {
  closeBrowserStaticServer,
  startBrowserStaticServer,
} from "./lsp_browser_static_server.mjs";
import { VfsDebugTraceCollector } from "../page/src/vfs_debug_trace.ts";

// The browser-specific override takes precedence over the generic PORT.
const browserPort = Number(
  process.env.RUBRC_LSP_BROWSER_PORT ?? process.env.PORT ?? "4173",
);
if (
  !Number.isSafeInteger(browserPort) ||
  browserPort < 1 ||
  browserPort > 65_535
) {
  throw new Error(`invalid browser acceptance port: ${browserPort}`);
}
const coldStartupTimeoutMs = Number(
  process.env.RUBRC_LSP_COLD_STARTUP_TIMEOUT_MS ?? STARTUP_TIMEOUT_MS,
);
if (!Number.isSafeInteger(coldStartupTimeoutMs) || coldStartupTimeoutMs < 1) {
  throw new Error(
    `invalid RUBRC_LSP_COLD_STARTUP_TIMEOUT_MS: ${coldStartupTimeoutMs}`,
  );
}
const url = `http://127.0.0.1:${browserPort}`;
const expectedMetadataUrl = new URL("/.rubrc-pages-build.json", url).href;
const invalidMain = 'fn main() { let value: i32 = "wrong"; }\n';
const validMain = "fn main() {}\n";
const startupMain = "fn main() { let startup_edit = 1; }\n";
const remountMain = "fn main() { let remount_edit = 1; }\n";
const invalidSecondary = "pub fn secondary() { let value = ; }\n";
const completionMain = "fn main() { let _ = std::env::curr; }\n";
const validStdMain = "fn main() { let _ = std::env::current_dir(); }\n";
const invalidStdMain =
  "fn main() { let _ = std::env::definitely_missing(); }\n";
const DEFAULT_API_NOT_READY = "Default api is not ready yet";
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const REMOUNT_TIMEOUT_MS = 30_000;
let browser;
let staticServer;
let testFailure;

async function assertSingleDefaultApiBundle() {
  const assets = new URL("../page/dist/assets/", import.meta.url);
  const entries = await readdir(assets, { withFileTypes: true });
  const matchingAssets = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const asset = await readFile(new URL(entry.name, assets), "utf8");
    if (asset.includes(DEFAULT_API_NOT_READY)) matchingAssets.push(entry.name);
  }

  if (matchingAssets.length !== 1) {
    throw new Error(
      `expected one VS Code default API asset, found ${matchingAssets.length}: ${matchingAssets.join(", ")}`,
    );
  }
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The in-process static server is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("browser static server did not start within 30 seconds");
}

function assertStartupTimings(label, timings) {
  const expectedPhases = [
    "editor-visible",
    "vfs-starting",
    "analyzer-initializing",
    "sysroots-loading",
    "project-activating",
    "semantic-warming",
    "ready",
  ];
  const phases = timings.map(({ phase }) => phase);
  if (phases.join(",") !== expectedPhases.join(",")) {
    throw new Error(`${label} phase timings are incomplete: ${phases}`);
  }
  for (let index = 1; index < timings.length; index++) {
    if (timings[index].elapsedMs < timings[index - 1].elapsedMs) {
      throw new Error(`${label} phase timings are not monotonic`);
    }
  }
  console.log(`${label} startup timings: ${JSON.stringify(timings)}`);
}

async function measureColdStartup(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const browserErrors = [];
  const traceCollector = new VfsDebugTraceCollector();
  let rejectColdStartupFatal;
  const coldStartupFatal = new Promise((_, reject) => {
    rejectColdStartupFatal = reject;
  });
  let primaryFailure;
  try {
    await page.setCacheEnabled(false);
    page.on("pageerror", (error) =>
      browserErrors.push(error.stack ?? error.message),
    );
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[vfs-stall-trace]")) {
        traceCollector.push(
          text.slice("[vfs-stall-trace]".length).replace(/^ /, ""),
        );
      }
      if (
        message.type() === "error" &&
        !text.startsWith("overly long loop turn took ") &&
        !shouldSuppressOptionalMetadataNotFound(
          text,
          message.location().url,
          expectedMetadataUrl,
        )
      ) {
        browserErrors.push(text);
      }
      if (text.includes("base call failed: OutOfMemory")) {
        void inspectConsoleArguments(message.args()).then((details) => {
          const location = message.location();
          rejectColdStartupFatal(
            new Error(
              `fatal cold-start transport error at ${location.url}:${location.lineNumber}:${location.columnNumber}: ${text}; details=${JSON.stringify(details)}`,
            ),
          );
        });
      }
    });
    page.on("requestfailed", (request) => {
      browserErrors.push(
        `request failed: ${request.url()} (${
          request.failure()?.errorText ?? "unknown"
        })`,
      );
    });
    await page.evaluateOnNewDocument(() => {
      const startedAt = performance.now();
      const state = { ready: false, vfsWrites: [], startupTimings: [] };
      window.__rubrcLspTest = new Proxy(state, {
        set(target, property, value) {
          Reflect.set(target, property, value);
          if (property === "startup" && value?.phase) {
            const last = target.startupTimings.at(-1);
            if (last?.phase !== value.phase) {
              target.startupTimings.push({
                phase: value.phase,
                elapsedMs: performance.now() - startedAt,
              });
            }
          }
          return true;
        },
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await Promise.race([
      page.waitForFunction(
        () => {
          const api = window.__rubrcLspTest;
          if (api?.runtime?.reloadRequired) {
            throw new Error("Runtime reload required");
          }
          return api?.ready === true && api?.startup?.phase === "ready";
        },
        { timeout: coldStartupTimeoutMs },
      ),
      coldStartupFatal,
    ]);
    const timings = await page.evaluate(
      () => window.__rubrcLspTest.startupTimings,
    );
    const trace = traceCollector.snapshot().trace;
    const pairedSysrootCall = Array.from(
      trace.matchAll(
        /host-call id=(\d+) name=(sysrootStartFetch|sysrootArchiveGetMeta|sysrootReadArchiveChunk) phase=request/g,
      ),
    ).some(([, id, name]) =>
      trace.includes(`host-call id=${id} name=${name} phase=response`),
    );
    if (!pairedSysrootCall) {
      throw new Error("cold startup trace omitted a paired sysroot call");
    }
    if (browserErrors.length > 0) {
      throw new Error(
        `cold startup browser errors:\n${browserErrors.join("\n")}`,
      );
    }
    assertStartupTimings("cold", timings);
    return timings;
  } catch (error) {
    const state = await safeFailureState(
      () =>
        page.evaluate(async () => {
          const api = window.__rubrcLspTest;
          const crateGraph =
            typeof api?.requestCrateGraph === "function"
              ? await Promise.race([
                  api?.requestCrateGraph?.(),
                  new Promise((resolve) =>
                    setTimeout(
                      () => resolve("request timed out after 500ms"),
                      500,
                    ),
                  ),
                ])
              : undefined;
          return {
            ready: api?.ready,
            startup: api?.startup,
            runtime: api?.runtime,
            startupTimings: api?.startupTimings,
            completedGeneration: api?.completedGenerations?.at(-1),
            crateGraph,
          };
        }),
      () => traceCollector.snapshot(),
    );
    primaryFailure = new Error(
      `cold startup failed: ${error.message}\nstartup failure state: ${JSON.stringify(
        state,
      )}\nbrowser errors:\n${browserErrors.join("\n")}`,
    );
    throw primaryFailure;
  } finally {
    try {
      await closeBrowserContextWithinDeadline(context);
    } catch (closeError) {
      browser.process()?.kill("SIGKILL");
      if (primaryFailure === undefined) throw closeError;
      console.error(
        `secondary cold-start cleanup failure: ${closeError.message}`,
      );
    }
  }
}

async function closeBrowserWithinDeadline(browser) {
  if (browser === undefined) return;
  let timer;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chromium did not close within 10 seconds")),
          BROWSER_CLOSE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    browser.process()?.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function closeBrowserContextWithinDeadline(context) {
  let timer;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("browser context did not close within 10 seconds"),
            ),
          BROWSER_CLOSE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertLifecycleOrder(events, label) {
  const required = [
    "host-callbacks-settled",
    "animal-destroy-requested",
    "animal-destroyed",
    "utility-worker-terminated",
    "operations-settled",
    "farm-destroyed",
    "store-disposed",
  ];
  let previous = -1;
  for (const event of required) {
    const index = events.indexOf(event);
    if (index <= previous) {
      throw new Error(`${label} lifecycle order mismatch: ${events.join(",")}`);
    }
    previous = index;
  }
}

function assertNoUnexpectedLifecycleBrowserErrors(
  errors,
  { expectCleanupFailure = false } = {},
) {
  const expected = [
    "Rust Language Client client: couldn't create connection to server.",
    "Restarting server failed",
    "Sending document notification textDocument/didClose failed.",
    "Runtime startup failed: AbortError: runtime disposed",
    "Staged startup failed: AbortError: runtime disposed",
  ];
  const cleanupFailures = errors.filter((error) =>
    error.includes(
      "Runtime cleanup failed: AggregateError: runtime cleanup failed",
    ),
  );
  const expectedAbort = (error) =>
    error.includes("request failed:") &&
    error.includes("(net::ERR_ABORTED)") &&
    (error.includes("/vfs-manifest.json") ||
      (error.includes("/assets/vfs.core-") &&
        error.includes(".wasm.br.json")) ||
      error.includes("/rust-src.sqfs") ||
      error.includes("/wasm32-wasip1.tar.br") ||
      error.includes("/wasm32-wasip2.tar.br"));
  const unexpected = errors.filter(
    (error) =>
      !expected.some((message) => error.includes(message)) &&
      !expectedAbort(error) &&
      !(expectCleanupFailure && cleanupFailures.includes(error)),
  );
  if (
    (expectCleanupFailure && cleanupFailures.length !== 1) ||
    (!expectCleanupFailure && cleanupFailures.length !== 0)
  ) {
    unexpected.push(
      `expected ${expectCleanupFailure ? 1 : 0} cleanup failures, observed ${cleanupFailures.length}`,
    );
  }
  if (unexpected.length > 0) {
    throw new Error(
      `unexpected lifecycle browser errors:\n${unexpected.join("\n")}`,
    );
  }
}

async function waitForReadyGeneration(
  page,
  previousGeneration,
  expectedText,
  startupFatal,
) {
  try {
    await Promise.race([
      page.waitForFunction(
        ({ previousGeneration, expectedText }) => {
          const api = window.__rubrcLspTest;
          return (
            api?.runtime?.generation !== previousGeneration &&
            api.runtime.phase === "ready" &&
            api.runtime.operation === "idle" &&
            api.startup?.phase === "ready" &&
            api.ready === true &&
            api.model?.getValue() === expectedText
          );
        },
        { timeout: STARTUP_TIMEOUT_MS },
        { previousGeneration, expectedText },
      ),
      startupFatal,
    ]);
  } catch (error) {
    const state = await safeFailureState(
      () =>
        page.evaluate((expectedText) => {
          const api = window.__rubrcLspTest;
          return {
            expectedText,
            ready: api?.ready,
            startup: api?.startup,
            runtime: api?.runtime,
            modelText: api?.model?.getValue(),
            mainDidOpenComplete: api?.mainDidOpenComplete,
            mainDiagnosticsPublicationCount:
              api?.mainDiagnosticsPublicationCount,
            remount: api?.remount,
            mountFailure: api?.mountFailure,
            completedGeneration: api?.completedGenerations?.at(-1),
          };
        }, expectedText),
      () => ({ trace: "", droppedChunks: 0 }),
    );
    throw new Error(
      `remounted generation did not become ready: ${error.message}; state=${JSON.stringify(state)}`,
    );
  }
}

async function waitForMountedGeneration(page, previousGeneration) {
  try {
    await page.waitForFunction(
      ({ previousGeneration }) => {
        const api = window.__rubrcLspTest;
        if (api?.mountFailure) {
          throw new Error(`runtime mount failed: ${api.mountFailure.message}`);
        }
        if (api?.remount?.phase === "failed") {
          throw new Error(`runtime remount failed: ${api.remount.error}`);
        }
        if (api?.runtime?.reloadRequired) {
          throw new Error("runtime remount requires reload");
        }
        return (
          api?.runtime?.generation !== previousGeneration &&
          typeof api.disposeRuntime === "function"
        );
      },
      { timeout: REMOUNT_TIMEOUT_MS },
      { previousGeneration },
    );
  } catch (error) {
    const state = await safeFailureState(
      () =>
        page.evaluate(() => {
          const api = window.__rubrcLspTest;
          return {
            remount: api?.remount,
            mountFailure: api?.mountFailure,
            runtime: api?.runtime,
            lifecycleEvents: api?.lifecycleEvents,
            completedGeneration: api?.completedGenerations?.at(-1),
          };
        }),
      () => ({ trace: "", droppedChunks: 0 }),
    );
    throw new Error(
      `remounted generation was not exposed: ${error.message}; state=${JSON.stringify(state)}`,
    );
  }
}

try {
  await assertSingleDefaultApiBundle();
  staticServer = await startBrowserStaticServer({
    hostname: "127.0.0.1",
    port: browserPort,
  });
  await waitForServer();

  browser = await puppeteer.launch({
    headless: true,
    dumpio: true,
    protocolTimeout: STARTUP_TIMEOUT_MS + 60_000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const coldStartup = await measureColdStartup(browser);
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  const browserErrors = [];
  const traceCollector = new VfsDebugTraceCollector();
  let rejectStartupFatal;
  const startupFatal = new Promise((_, reject) => {
    rejectStartupFatal = reject;
  });
  const browserDisconnected = new Promise((_, reject) => {
    browser.on("disconnected", () =>
      reject(new Error("Chromium disconnected during browser startup")),
    );
  });
  const pageTerminated = new Promise((_, reject) => {
    page.on("error", (error) =>
      reject(new Error(`browser renderer crashed: ${error.message}`)),
    );
    page.on("close", () =>
      reject(new Error("browser page closed during startup")),
    );
  });
  page.on("pageerror", (error) =>
    browserErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    const text = message.text();
    if (
      text !== "notify number is 0. ref is late?" &&
      text !== "invoke_func_loop is late"
    ) {
      console.log(`[Browser Console] ${text}`);
    }
    if (text.startsWith("[vfs-stall-trace]")) {
      traceCollector.push(
        text.slice("[vfs-stall-trace]".length).replace(/^ /, ""),
      );
    }
    if (
      message.type() === "error" &&
      !text.startsWith("overly long loop turn took ")
    ) {
      if (
        !shouldSuppressOptionalMetadataNotFound(
          text,
          message.location().url,
          expectedMetadataUrl,
        )
      ) {
        browserErrors.push(text);
      }
    }
    if (text.includes("base call failed: InvalidRequest")) {
      void Promise.all(
        message.args().map((argument) =>
          argument.evaluate((value) =>
            value instanceof Error
              ? {
                  name: value.name,
                  message: value.message,
                  stack: value.stack,
                }
              : String(value),
          ),
        ),
      ).then((details) => {
        const location = message.location();
        const error = new Error(
          `fatal startup transport error at ${location.url}:${location.lineNumber}:${location.columnNumber}: ${JSON.stringify(details)}`,
        );
        browserErrors.push(error.message);
        rejectStartupFatal(error);
      });
    }
  });
  page.on("requestfailed", (request) => {
    browserErrors.push(
      `request failed: ${request.url()} (${
        request.failure()?.errorText ?? "unknown"
      })`,
    );
  });
  await page.evaluateOnNewDocument((text) => {
    const startedAt = performance.now();
    const state = {
      ready: false,
      vfsWrites: [],
      startupTimings: [],
      projectProgressCaptures: [],
      projectBeforeFirstPollText: undefined,
    };
    let initialCaptured = false;
    let startupEdited = false;
    window.__rubrcLspTest = new Proxy(state, {
      set(target, property, value) {
        Reflect.set(target, property, value);
        if (property === "startup" && value?.phase) {
          const last = target.startupTimings.at(-1);
          if (last?.phase !== value.phase) {
            target.startupTimings.push({
              phase: value.phase,
              elapsedMs: performance.now() - startedAt,
            });
          }
        }
        if (property === "startup" && value?.phase === "project-activating") {
          const overlayText = document.body.innerText;
          if (
            value.projectProgress === undefined &&
            target.projectBeforeFirstPollText === undefined
          ) {
            Reflect.set(target, "projectBeforeFirstPollText", overlayText);
          }
          if (value?.projectProgress !== undefined) {
            const last = target.projectProgressCaptures.at(-1);
            if (last?.progress?.attempt !== value.projectProgress.attempt) {
              target.projectProgressCaptures.push({
                progress: value.projectProgress,
                overlayText,
              });
            }
          }
        }
        if (
          !initialCaptured &&
          property === "startup" &&
          value?.phase === "editor-visible"
        ) {
          initialCaptured = true;
          const model = target.model;
          const monaco = target.monaco;
          const editor = target.editor;
          const rustModels = monaco.editor
            .getModels()
            .filter((candidate) => candidate.getLanguageId() === "rust");
          Reflect.set(target, "task9Initial", {
            overlayVisible: value.overlayVisible,
            namedModel:
              rustModels.length === 1 &&
              rustModels[0] === model &&
              model.uri.toString() === "file:///src/main.rs",
            editable:
              editor.getOption(monaco.editor.EditorOption.readOnly) === false,
          });
        }
        if (
          !startupEdited &&
          property === "startup" &&
          value?.phase === "semantic-warming"
        ) {
          startupEdited = true;
          const model = target.model;
          model.setValue(text);
          Reflect.set(target, "startupEdit", {
            phase: value.phase,
            version: model.getVersionId(),
          });
        }
        return true;
      },
    });
  }, startupMain);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await Promise.race([
      page.waitForFunction(
        ({ startupText }) => {
          const testApi = window.__rubrcLspTest;
          if (testApi?.runtime?.reloadRequired)
            throw new Error("Runtime reload required");
          if (!testApi?.ready || !testApi.monaco || !testApi.editor)
            return false;
          const rustModels = testApi.monaco.editor
            .getModels()
            .filter((model) => model.getLanguageId() === "rust");
          return (
            rustModels.length === 1 &&
            rustModels[0].uri.toString() === "file:///src/main.rs" &&
            testApi.editor.getOption(
              testApi.monaco.editor.EditorOption.readOnly,
            ) === false &&
            testApi.startup?.phase === "ready" &&
            testApi.startup.overlayVisible === false &&
            testApi.startup.projectProgress?.ready === true &&
            testApi.projectProgressCaptures.length > 0 &&
            testApi.task9Initial?.overlayVisible === true &&
            testApi.task9Initial.namedModel === true &&
            testApi.task9Initial.editable === true &&
            testApi.startupEdit?.phase === "semantic-warming" &&
            testApi.model?.getValue() === startupText &&
            testApi.mainDidOpenComplete === true &&
            testApi.mainDiagnosticsPublicationCount > 0 &&
            testApi.vfsWrites.some((write) => write.path === "/src/main.rs")
          );
        },
        { timeout: STARTUP_TIMEOUT_MS },
        { startupText: startupMain },
      ),
      startupFatal,
      browserDisconnected,
      pageTerminated,
    ]);
  } catch (error) {
    const state = await safeFailureState(
      () =>
        page.evaluate(() => {
          const api = window.__rubrcLspTest;
          return {
            ready: api?.ready,
            startup: api?.startup,
            runtime: api?.runtime,
            task9Initial: api?.task9Initial,
            completedGeneration: api?.completedGenerations?.at(-1),
          };
        }),
      () => traceCollector.snapshot(),
    );
    throw new Error(
      `browser readiness failed: ${error.message}\nstate: ${JSON.stringify(
        state,
      )}\nbrowser errors:\n${browserErrors.join("\n")}`,
    );
  }

  const editedStartup = await page.evaluate(
    () => window.__rubrcLspTest.startupTimings,
  );
  assertStartupTimings("semantic-edit", editedStartup);
  if (coldStartup.at(-1)?.elapsedMs > STARTUP_TIMEOUT_MS) {
    throw new Error("cold startup exceeded the startup budget");
  }

  await page.evaluate(() => {
    const api = window.__rubrcLspTest;
    const progress = api.startup.projectProgress;
    if (progress === undefined) {
      throw new Error(
        "startup test state lacks production crate graph progress",
      );
    }
    if (!Object.isFrozen(progress) || !Object.isFrozen(progress.labels)) {
      throw new Error("production crate graph progress is mutable");
    }
    if (!progress.ready || progress.attempt < 1) {
      throw new Error(
        `invalid ready crate graph progress: ${JSON.stringify(progress)}`,
      );
    }
    if (progress.labels.join(",") !== "rubrc_main,core,alloc,std") {
      throw new Error(
        `unstable ready crate labels: ${progress.labels.join(",")}`,
      );
    }
    const initialText = api.projectBeforeFirstPollText ?? "";
    if (!initialText.includes("Project") || !initialText.includes("...")) {
      throw new Error(
        `Project did not render indeterminate startup: ${initialText}`,
      );
    }
    const capture = api.projectProgressCaptures.find(
      (item) => item.progress === progress,
    );
    if (capture === undefined) {
      throw new Error(
        "ready project progress was not captured from the overlay",
      );
    }
    const expectedSummary = `${Math.floor(progress.elapsedMs / 1_000)}s · poll ${progress.attempt} · crates 4/4`;
    if (!capture.overlayText.includes(expectedSummary)) {
      throw new Error(
        `overlay omitted ${expectedSummary}: ${capture.overlayText}`,
      );
    }
    for (const label of ["rubrc_main", "core", "alloc", "std"]) {
      if (!capture.overlayText.includes(label)) {
        throw new Error(`overlay omitted ${label}: ${capture.overlayText}`);
      }
    }
  });

  try {
    await waitForDiagnosticsQuiescence({
      stage: "initial diagnostics",
      waitForPublication: async () => {},
      requestSyntaxTree: () =>
        page.evaluate(() => {
          const request = window.__rubrcLspTest?.requestSyntaxTree;
          if (!request) {
            throw new Error("syntax-tree test request is unavailable");
          }
          return request("file:///src/main.rs");
        }),
    });
  } catch (error) {
    const state = await safeFailureState(
      () =>
        page.evaluate(() => ({
          mainDiagnosticsPublicationCount:
            window.__rubrcLspTest?.mainDiagnosticsPublicationCount,
          mainDidOpenComplete: window.__rubrcLspTest?.mainDidOpenComplete,
        })),
      () => traceCollector.snapshot(),
    );
    throw new Error(
      `initial diagnostics quiescence failed: ${error.message}\nstate: ${JSON.stringify(
        state,
      )}\nbrowser errors:\n${browserErrors.join("\n")}`,
    );
  }

  await page.evaluate((startupText) => {
    const api = window.__rubrcLspTest;
    const expectedHistory = [
      "editor-visible",
      "vfs-starting",
      "analyzer-initializing",
      "sysroots-loading",
      "project-activating",
      "semantic-warming",
      "ready",
    ];
    if (api.startup.history.join(",") !== expectedHistory.join(",")) {
      throw new Error(`exact phase history mismatch: ${api.startup.history}`);
    }
    if (api.model.getValue() !== startupText) {
      throw new Error("startup edit was not preserved");
    }
    if (api.startup.cargoCallsBeforeProjectActivation !== 0) {
      throw new Error("Cargo/rustc ran before project activation");
    }
    const modelVersion = api.model.getVersionId();
    if (
      api.startup.diagnosticsVersion !== modelVersion ||
      api.startup.inlayHintVersion !== modelVersion
    ) {
      throw new Error(
        `readiness versions do not match model ${modelVersion}: diagnostics=${api.startup.diagnosticsVersion}, inlay=${api.startup.inlayHintVersion}`,
      );
    }
    const progress = api.startup.projectProgress;
    if (
      progress?.ready !== true ||
      progress.labels.join(",") !== "rubrc_main,core,alloc,std"
    ) {
      throw new Error(
        `production crate graph progress is incomplete: ${JSON.stringify(progress)}`,
      );
    }
  }, startupMain);

  const analysisDeadline = Date.now() + ANALYSIS_TIMEOUT_MS;
  const remainingAnalysisBudget = () =>
    Math.max(1, analysisDeadline - Date.now());

  const beforeCompletionPublication = await page.evaluate(
    () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
  );
  await page.evaluate((text) => {
    window.__rubrcLspTest.model.setValue(text);
  }, completionMain);
  await page.waitForFunction(
    (previous) =>
      window.__rubrcLspTest.mainDiagnosticsPublicationCount > previous,
    { timeout: remainingAnalysisBudget() },
    beforeCompletionPublication,
  );

  const completion = await page.evaluate(async () => {
    const api = window.__rubrcLspTest;
    const result = await api.requestCompletion(
      "file:///src/main.rs",
      { line: 0, character: "fn main() { let _ = std::env::curr".length },
    );
    const items = Array.isArray(result) ? result : result?.items ?? [];
    return items.map((item) => item.label);
  });
  if (!completion.includes("current_dir")) {
    throw new Error(`std completion omitted current_dir: ${completion.join(",")}`);
  }

  const beforeValidStdPublication = await page.evaluate(
    () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
  );
  await page.evaluate((text) => {
    window.__rubrcLspTest.model.setValue(text);
  }, validStdMain);
  await waitForDiagnosticsQuiescence({
    stage: "valid std definition",
    waitForPublication: () =>
      page.waitForFunction(
        (previous) =>
          window.__rubrcLspTest.mainDiagnosticsPublicationCount > previous,
        { timeout: remainingAnalysisBudget() },
        beforeValidStdPublication,
      ),
    waitForMarkers: () =>
      page.waitForFunction(
        () => {
          const { monaco } = window.__rubrcLspTest;
          const uri = monaco.Uri.parse("file:///src/main.rs");
          return !monaco.editor
            .getModelMarkers({ resource: uri })
            .some((marker) => marker.severity === monaco.MarkerSeverity.Error);
        },
        { timeout: remainingAnalysisBudget() },
      ),
    requestSyntaxTree: () =>
      page.evaluate(() =>
        window.__rubrcLspTest.requestSyntaxTree("file:///src/main.rs")
      ),
    timeoutMs: remainingAnalysisBudget(),
  });

  const definitionUris = await page.evaluate(async () => {
    const api = window.__rubrcLspTest;
    const result = await api.requestDefinition(
      "file:///src/main.rs",
      { line: 0, character: "fn main() { let _ = std::env::current".length },
    );
    const values = result == null ? [] : Array.isArray(result) ? result : [result];
    return values.map((value) => value.uri ?? value.targetUri ?? "");
  });
  if (
    !definitionUris.some((uri) =>
      uri.includes("/sysroot/lib/rustlib/src/rust/library/std/")
    )
  ) {
    throw new Error(`std definition resolved outside rust-src: ${definitionUris}`);
  }

  const beforeInvalidStdPublication = await page.evaluate(
    () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
  );
  await page.evaluate((text) => {
    window.__rubrcLspTest.model.setValue(text);
  }, invalidStdMain);
  await waitForDiagnosticsQuiescence({
    stage: "invalid std diagnostics",
    waitForPublication: () =>
      page.waitForFunction(
        (previous) =>
          window.__rubrcLspTest.mainDiagnosticsPublicationCount > previous,
        { timeout: remainingAnalysisBudget() },
        beforeInvalidStdPublication,
      ),
    waitForMarkers: () =>
      page.waitForFunction(
        () => {
          const { monaco } = window.__rubrcLspTest;
          const uri = monaco.Uri.parse("file:///src/main.rs");
          return monaco.editor
            .getModelMarkers({ resource: uri })
            .some((marker) =>
              marker.severity === monaco.MarkerSeverity.Error &&
              marker.source === "rust-analyzer" &&
              marker.message.includes("definitely_missing")
            );
        },
        { timeout: remainingAnalysisBudget() },
      ),
    requestSyntaxTree: () =>
      page.evaluate(() =>
        window.__rubrcLspTest.requestSyntaxTree("file:///src/main.rs")
      ),
    timeoutMs: remainingAnalysisBudget(),
  });

  const beforeStdClearPublication = await page.evaluate(
    () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
  );
  await page.evaluate((text) => {
    window.__rubrcLspTest.model.setValue(text);
  }, validStdMain);
  await waitForDiagnosticsQuiescence({
    stage: "clearing std diagnostics",
    waitForPublication: () =>
      page.waitForFunction(
        (previous) =>
          window.__rubrcLspTest.mainDiagnosticsPublicationCount > previous,
        { timeout: remainingAnalysisBudget() },
        beforeStdClearPublication,
      ),
    waitForMarkers: () =>
      page.waitForFunction(
        () => {
          const { monaco } = window.__rubrcLspTest;
          const uri = monaco.Uri.parse("file:///src/main.rs");
          return !monaco.editor
            .getModelMarkers({ resource: uri })
            .some((marker) => marker.severity === monaco.MarkerSeverity.Error);
        },
        { timeout: remainingAnalysisBudget() },
      ),
    requestSyntaxTree: () =>
      page.evaluate(() =>
        window.__rubrcLspTest.requestSyntaxTree("file:///src/main.rs")
      ),
    timeoutMs: remainingAnalysisBudget(),
  });

  const readinessPublicationCount = await page.evaluate(
    () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
  );
  await page.evaluate((text) => {
    const { monaco } = window.__rubrcLspTest;
    monaco.editor
      .getModel(monaco.Uri.parse("file:///src/main.rs"))
      .setValue(text);
  }, invalidMain);
  try {
    await waitForDiagnosticsQuiescence({
      stage: "invalid diagnostics",
      waitForPublication: () =>
        page.waitForFunction(
          ({ previousPublicationCount }) => {
            return (
              window.__rubrcLspTest.mainDiagnosticsPublicationCount >
              previousPublicationCount
            );
          },
          { timeout: remainingAnalysisBudget() },
          { previousPublicationCount: readinessPublicationCount },
        ),
      waitForMarkers: () =>
        page.waitForFunction(
          () => {
            const { monaco } = window.__rubrcLspTest;
            const uri = monaco.Uri.parse("file:///src/main.rs");
            return monaco.editor
              .getModelMarkers({ resource: uri })
              .some(
                (marker) =>
                  marker.severity === monaco.MarkerSeverity.Error &&
                  marker.source === "rust-analyzer" &&
                  marker.message.includes("i32") &&
                  marker.message.includes("str") &&
                  marker.startLineNumber === 1,
              );
          },
          { timeout: remainingAnalysisBudget() },
        ),
      requestSyntaxTree: () =>
        page.evaluate(() => {
          const request = window.__rubrcLspTest?.requestSyntaxTree;
          if (!request) {
            throw new Error("syntax-tree test request is unavailable");
          }
          return request("file:///src/main.rs");
        }),
      timeoutMs: remainingAnalysisBudget(),
    });
  } catch (error) {
    const state = await safeFailureState(
      () =>
        page.evaluate(() => {
          const {
            mainDiagnosticsPublicationCount,
            mainDidOpenComplete,
            lspEvents,
            monaco,
            vfsWrites,
          } = window.__rubrcLspTest;
          const uri = monaco.Uri.parse("file:///src/main.rs");
          const model = monaco.editor.getModel(uri);
          return {
            modelText: model?.getValue(),
            languageId: model?.getLanguageId(),
            mainDiagnosticsPublicationCount,
            mainDidOpenComplete,
            lspEvents,
            modelUris: monaco.editor
              .getModels()
              .map((item) => item.uri.toString()),
            markers: monaco.editor.getModelMarkers({ resource: uri }),
            vfsWrites,
          };
        }),
      () => traceCollector.snapshot(),
    );
    throw new Error(
      `invalid diagnostics failed: ${error.message}\nstate: ${JSON.stringify(
        state,
      )}\nbrowser errors:\n${browserErrors.join("\n")}`,
    );
  }

  const invalidPublicationCount = await page.evaluate(
    () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
  );

  await page.evaluate((text) => {
    const { monaco } = window.__rubrcLspTest;
    monaco.editor
      .getModel(monaco.Uri.parse("file:///src/main.rs"))
      .setValue(text);
  }, validMain);
  try {
    await waitForDiagnosticsQuiescence({
      stage: "clearing diagnostics",
      waitForPublication: () =>
        page.waitForFunction(
          ({ previousPublicationCount }) => {
            return (
              window.__rubrcLspTest.mainDiagnosticsPublicationCount >
              previousPublicationCount
            );
          },
          { timeout: DIAGNOSTICS_TIMEOUT_MS },
          { previousPublicationCount: invalidPublicationCount },
        ),
      waitForMarkers: () =>
        page.waitForFunction(
          () => {
            const { monaco } = window.__rubrcLspTest;
            const uri = monaco.Uri.parse("file:///src/main.rs");
            return !monaco.editor
              .getModelMarkers({ resource: uri })
              .some(
                (marker) => marker.severity === monaco.MarkerSeverity.Error,
              );
          },
          { timeout: DIAGNOSTICS_TIMEOUT_MS },
        ),
      requestSyntaxTree: () =>
        page.evaluate(() => {
          const request = window.__rubrcLspTest?.requestSyntaxTree;
          if (!request) {
            throw new Error("syntax-tree test request is unavailable");
          }
          return request("file:///src/main.rs");
        }),
    });
  } catch (error) {
    const state = await safeFailureState(
      () =>
        page.evaluate(() => {
          const { mainDiagnosticsPublicationCount, monaco, vfsWrites } =
            window.__rubrcLspTest;
          const uri = monaco.Uri.parse("file:///src/main.rs");
          return {
            mainDiagnosticsPublicationCount,
            markers: monaco.editor.getModelMarkers({ resource: uri }),
            modelText: monaco.editor.getModel(uri)?.getValue(),
            vfsWrites,
          };
        }),
      () => traceCollector.snapshot(),
    );
    throw new Error(
      `diagnostics clearing failed: ${error.message}\nstate: ${JSON.stringify(
        state,
      )}\nbrowser errors:\n${browserErrors.join("\n")}`,
    );
  }

  await page.evaluate((text) => {
    const { monaco } = window.__rubrcLspTest;
    const uri = monaco.Uri.parse("file:///src/secondary.rs");
    monaco.editor.getModel(uri)?.dispose();
    monaco.editor.createModel(text, "rust", uri);
  }, invalidSecondary);
  await page.waitForFunction(
    ({ expectedText }) => {
      const { monaco, vfsWrites } = window.__rubrcLspTest;
      const uri = monaco.Uri.parse("file:///src/secondary.rs");
      const marked = monaco.editor
        .getModelMarkers({ resource: uri })
        .some((marker) => marker.severity === monaco.MarkerSeverity.Error);
      const mirrored = vfsWrites.some(
        ({ path, content }) =>
          path === "/src/secondary.rs" && content === expectedText,
      );
      return marked && mirrored;
    },
    { timeout: DIAGNOSTICS_TIMEOUT_MS },
    { expectedText: invalidSecondary },
  );

  const terminalText = await page.evaluate(() => document.body.innerText);
  if (
    terminalText.includes("textDocument/publishDiagnostics") ||
    terminalText.includes("Content-Length:")
  ) {
    throw new Error("LSP JSON-RPC was routed to the terminal");
  }
  const fileServiceErrors = browserErrors.filter(
    (error) =>
      error.includes("FileOperationError") ||
      error.includes("Unable to resolve nonexistent file"),
  );
  if (fileServiceErrors.length > 0) {
    throw new Error(
      `workspace file service errors:\n${fileServiceErrors.join("\n")}`,
    );
  }
  if (browserErrors.length > 0) {
    throw new Error(`browser errors:\n${browserErrors.join("\n")}`);
  }
  const lifecycleBrowserErrorStart = browserErrors.length;
  await page.evaluate(() => {
    const { monaco } = window.__rubrcLspTest;
    monaco.editor
      .getModel(monaco.Uri.parse("file:///src/secondary.rs"))
      ?.dispose();
  });

  await page.evaluate(async () => {
    const api = window.__rubrcLspTest;
    const target = api.loadTarget("wasm32-wasip2");
    let busyError;
    try {
      await api.runRuntime();
    } catch (error) {
      busyError = error;
    }
    if (!(busyError instanceof Error) || !busyError.message.includes("busy")) {
      throw new Error("Run did not reject while target loading was active");
    }
    await target;
    if (
      api.runtime.operation !== "idle" ||
      !api.runtime.completedTargets.includes("wasm32-wasip2")
    ) {
      throw new Error("post-ready target did not settle to idle");
    }
  });

  const readyGeneration = await page.evaluate(
    () => window.__rubrcLspTest.runtime.generation,
  );
  await page.evaluate((text) => {
    window.__rubrcLspTest.model.setValue(text);
    void window.__rubrcLspTest.remountRuntime();
  }, remountMain);
  await waitForMountedGeneration(page, readyGeneration);
  const startupDisposal = await page.evaluate(async () => {
    const api = window.__rubrcLspTest;
    const generation = api.runtime.generation;
    const preRuntimePhase = api.runtime.phase;
    const preStartupPhase = api.startup?.phase;
    await api.disposeRuntime();
    return {
      generation,
      preRuntimePhase,
      preStartupPhase,
      phase: api.runtime.phase,
      events: [...api.lifecycleEvents],
      resources: {
        utilityWorkers: api.runtime.utilityWorkers,
        lifecycleWorkers: api.runtime.lifecycleWorkers,
        farmCallbacks: api.runtime.farmCallbacks,
      },
    };
  });
  if (
    startupDisposal.generation === readyGeneration ||
    startupDisposal.preRuntimePhase === "ready" ||
    startupDisposal.preStartupPhase === "ready" ||
    startupDisposal.phase !== "disposed" ||
    Object.values(startupDisposal.resources).some((count) => count !== 0)
  ) {
    throw new Error(
      `startup disposal retained generation resources: ${JSON.stringify(startupDisposal)}`,
    );
  }
  assertLifecycleOrder(startupDisposal.events, "startup disposal");

  await page.evaluate(() => window.__rubrcLspTest.remountRuntime());
  await waitForReadyGeneration(
    page,
    startupDisposal.generation,
    remountMain,
    startupFatal,
  );
  const cleanRemount = await page.evaluate(() => {
    const api = window.__rubrcLspTest;
    const previous = api.completedGenerations.at(-1);
    return {
      generation: api.runtime.generation,
      currentEvents: [...api.lifecycleEvents],
      previous,
    };
  });
  if (
    cleanRemount.currentEvents.length !== 0 ||
    cleanRemount.previous?.runtime?.phase !== "disposed" ||
    cleanRemount.previous.runtime.utilityWorkers !== 0 ||
    cleanRemount.previous.runtime.lifecycleWorkers !== 0 ||
    cleanRemount.previous.runtime.farmCallbacks !== 0
  ) {
    throw new Error(
      `remount retained stale state: ${JSON.stringify(cleanRemount)}`,
    );
  }

  await page.evaluate(() => {
    const api = window.__rubrcLspTest;
    api.task9TargetOperation = api.loadTarget("wasm32-wasip2");
    api.task9TargetOperation.catch(() => undefined);
  });
  await page.waitForFunction(
    () => window.__rubrcLspTest.runtime?.activeTarget === "wasm32-wasip2",
    { timeout: ANALYSIS_TIMEOUT_MS },
  );
  const targetDisposal = await page.evaluate(async () => {
    const api = window.__rubrcLspTest;
    let busyError;
    try {
      await api.runRuntime();
    } catch (error) {
      busyError = error;
    }
    await api.disposeRuntime();
    await api.task9TargetOperation.catch(() => undefined);
    return {
      generation: api.runtime.generation,
      phase: api.runtime.phase,
      operation: api.runtime.operation,
      busy: busyError instanceof Error && busyError.message.includes("busy"),
      events: [...api.lifecycleEvents],
    };
  });
  if (
    !targetDisposal.busy ||
    targetDisposal.phase !== "disposed" ||
    targetDisposal.operation !== "idle"
  ) {
    throw new Error(
      `target disposal did not settle: ${JSON.stringify(targetDisposal)}`,
    );
  }
  assertLifecycleOrder(targetDisposal.events, "target disposal");

  await page.evaluate(() => window.__rubrcLspTest.remountRuntime());
  await waitForReadyGeneration(
    page,
    targetDisposal.generation,
    remountMain,
    startupFatal,
  );
  const forcedBrowserErrorStart = browserErrors.length;
  assertNoUnexpectedLifecycleBrowserErrors(
    browserErrors.slice(lifecycleBrowserErrorStart, forcedBrowserErrorStart),
  );
  const quarantine = await page.evaluate(async () => {
    const api = window.__rubrcLspTest;
    api.forceDestroyTimeout();
    await api.disposeRuntime().catch(() => undefined);
    const quarantineState = {
      phase: api.runtime.phase,
      reloadRequired: api.runtime.reloadRequired,
      events: [...api.lifecycleEvents],
    };
    await api.remountRuntime();
    const failureText =
      document.querySelector("#runtime-creation-failure")?.textContent ?? "";
    return {
      ...quarantineState,
      remountBlocked:
        window.__rubrcLspTest.mountFailure?.reloadRequired === true &&
        window.__rubrcLspTest.runtime === undefined &&
        failureText.includes("Reload required") &&
        failureText.includes("Reload page"),
    };
  });
  if (
    quarantine.phase !== "reload-required" ||
    !quarantine.reloadRequired ||
    !quarantine.events.includes("reload-required") ||
    !quarantine.remountBlocked
  ) {
    throw new Error(
      `quarantine acceptance failed: ${JSON.stringify(quarantine)}`,
    );
  }
  assertNoUnexpectedLifecycleBrowserErrors(
    browserErrors.slice(forcedBrowserErrorStart),
    { expectCleanupFailure: true },
  );
  console.log("browser displayed and cleared rust-analyzer markers");
} catch (error) {
  testFailure = error;
} finally {
  const cleanupErrors = [];
  try {
    await closeBrowserWithinDeadline(browser);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (staticServer !== undefined) {
      await closeBrowserStaticServer(staticServer);
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  const failures = [
    ...(testFailure === undefined ? [] : [testFailure]),
    ...cleanupErrors,
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "browser acceptance and cleanup failed");
  }
}
