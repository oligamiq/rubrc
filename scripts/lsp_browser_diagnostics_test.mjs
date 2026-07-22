import { spawn } from "node:child_process";
import puppeteer from "puppeteer";

const url = "http://127.0.0.1:4173";
const invalidMain = "fn main() { let value = ; }\n";
const validMain = "fn main() {}\n";
const invalidSecondary = "pub fn secondary() { let value = ; }\n";
let browser;
let preview;

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite preview did not start within 30 seconds");
}

try {
  preview = spawn(
    "bun",
    ["run", "--cwd", "page", "serve", "--host", "127.0.0.1", "--port", "4173"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  preview.stdout.resume();
  preview.stderr.resume();
  await waitForServer();

  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) =>
    browserErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("overly long loop turn took ")
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    browserErrors.push(
      `request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
    );
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(
      () => window.__rubrcLspTest?.ready && window.__rubrcLspTest.monaco,
      { timeout: 120_000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      hook:
        window.__rubrcLspTest === undefined
          ? "missing"
          : {
              ready: window.__rubrcLspTest.ready,
              hasMonaco: window.__rubrcLspTest.monaco !== undefined,
              vfsWriteCount: window.__rubrcLspTest.vfsWrites.length,
            },
      terminal: document.body.innerText.slice(-4_000),
    }));
    throw new Error(
      `browser readiness failed: ${error.message}\nstate: ${JSON.stringify(state)}\nbrowser errors:\n${browserErrors.join("\n")}`,
    );
  }

  await page.waitForFunction(
    () => window.__rubrcLspTest?.mainDidOpenComplete === true,
    { timeout: 15_000 },
  );

  await page.evaluate((text) => {
    const { monaco } = window.__rubrcLspTest;
    const uri = monaco.Uri.parse("file:///src/main.rs");
    const model = monaco.editor.getModel(uri);
    if (!model) throw new Error("main.rs Monaco model is missing");
    model.setValue(text);
  }, invalidMain);
  try {
    await page.waitForFunction(
      () => {
        const { monaco } = window.__rubrcLspTest;
        const uri = monaco.Uri.parse("file:///src/main.rs");
        return monaco.editor
          .getModelMarkers({ resource: uri })
          .some(
            (marker) =>
              marker.severity === monaco.MarkerSeverity.Error &&
              marker.startLineNumber === 1,
          );
      },
      { timeout: 15_000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const { mainDidOpenComplete, monaco, vfsWrites } = window.__rubrcLspTest;
      const uri = monaco.Uri.parse("file:///src/main.rs");
      const model = monaco.editor.getModel(uri);
      return {
        modelText: model?.getValue(),
        languageId: model?.getLanguageId(),
        mainDidOpenComplete,
        modelUris: monaco.editor.getModels().map((item) => item.uri.toString()),
        markers: monaco.editor.getModelMarkers({ resource: uri }),
        vfsWrites,
      };
    });
    throw new Error(
      `initial diagnostics failed: ${error.message}\nstate: ${JSON.stringify(state)}\nbrowser errors:\n${browserErrors.join("\n")}`,
    );
  }

  await page.evaluate((text) => {
    const { monaco } = window.__rubrcLspTest;
    monaco.editor
      .getModel(monaco.Uri.parse("file:///src/main.rs"))
      .setValue(text);
  }, validMain);
  await page.waitForFunction(
    () => {
      const { monaco } = window.__rubrcLspTest;
      const uri = monaco.Uri.parse("file:///src/main.rs");
      return !monaco.editor
        .getModelMarkers({ resource: uri })
        .some((marker) => marker.severity === monaco.MarkerSeverity.Error);
    },
    { timeout: 15_000 },
  );

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
    { timeout: 15_000 },
    { expectedText: invalidSecondary },
  );

  const terminalText = await page.evaluate(() => document.body.innerText);
  if (
    terminalText.includes("textDocument/publishDiagnostics") ||
    terminalText.includes("Content-Length:")
  ) {
    throw new Error("LSP JSON-RPC was routed to the terminal");
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
  if (preview && preview.exitCode === null) {
    preview.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        preview.kill("SIGKILL");
        resolve();
      }, 2_000);
      preview.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
