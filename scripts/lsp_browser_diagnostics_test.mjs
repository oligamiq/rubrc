import { readdir, readFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import {
  ANALYSIS_TIMEOUT_MS,
  DIAGNOSTICS_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  waitForDiagnosticsQuiescence,
} from "./lsp_browser_quiescence.mjs";
import { shouldSuppressOptionalMetadataNotFound } from "./lsp_browser_console_error.mjs";
import { safeFailureState } from "./lsp_browser_failure_state.mjs";
import {
  closeBrowserStaticServer,
  startBrowserStaticServer,
} from "./lsp_browser_static_server.mjs";
import { VfsDebugTraceCollector } from "../page/src/vfs_debug_trace.ts";

const url = "http://127.0.0.1:4173";
const invalidMain = 'fn main() { let value: i32 = "wrong"; }\n';
const validMain = "fn main() {}\n";
const invalidSecondary = "pub fn secondary() { let value = ; }\n";
const DEFAULT_API_NOT_READY = "Default api is not ready yet";
let browser;
let staticServer;

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

try {
  await assertSingleDefaultApiBundle();
  staticServer = await startBrowserStaticServer({
    hostname: "127.0.0.1",
    port: 4173,
  });
  await waitForServer();

  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  const browserErrors = [];
  const traceCollector = new VfsDebugTraceCollector();
  page.on("pageerror", (error) =>
    browserErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    const text = message.text();
    console.log(`[Browser Console] ${text}`);
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
        !shouldSuppressOptionalMetadataNotFound(text, message.location().url)
      ) {
        browserErrors.push(text);
      }
    }
  });
  page.on("requestfailed", (request) => {
    browserErrors.push(
      `request failed: ${request.url()} (${
        request.failure()?.errorText ?? "unknown"
      })`,
    );
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(
      () => {
        const testApi = window.__rubrcLspTest;
        if (!testApi?.ready || !testApi.monaco || !testApi.editor) return false;
        const rustModels = testApi.monaco.editor
          .getModels()
          .filter((model) => model.getLanguageId() === "rust");
        return (
          rustModels.length === 1 &&
          rustModels[0].uri.toString() === "file:///src/main.rs" &&
          testApi.editor.getOption(
            testApi.monaco.editor.EditorOption.readOnly,
          ) === false &&
          testApi.mainDidOpenComplete === true &&
          testApi.mainDiagnosticsPublicationCount > 0 &&
          testApi.vfsWrites.some((write) => write.path === "/src/main.rs")
        );
      },
      { timeout: STARTUP_TIMEOUT_MS },
    );
  } catch (error) {
    const state = await safeFailureState(
      () =>
        page.evaluate(() => ({
          hook: window.__rubrcLspTest,
        })),
      () => traceCollector.snapshot(),
    );
    throw new Error(
      `browser readiness failed: ${error.message}\nstate: ${JSON.stringify(
        state,
      )}\nbrowser errors:\n${browserErrors.join("\n")}`,
    );
  }

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

  const readinessPublicationCount = await page.evaluate(
    () => window.__rubrcLspTest.mainDiagnosticsPublicationCount,
  );

  const analysisDeadline = Date.now() + ANALYSIS_TIMEOUT_MS;
  const remainingAnalysisBudget = () =>
    Math.max(1, analysisDeadline - Date.now());
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
  await page.evaluate(() => {
    const { monaco } = window.__rubrcLspTest;
    monaco.editor
      .getModel(monaco.Uri.parse("file:///src/secondary.rs"))
      ?.dispose();
  });
  console.log("browser displayed and cleared rust-analyzer markers");
} finally {
  await browser?.close();
  await closeBrowserStaticServer(staticServer);
}
