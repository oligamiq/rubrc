import puppeteer from "puppeteer";
import { assertCacheOutcome, monitorRenderer, withDeadline } from "./stdlib_cache_browser_support.mjs";
import {
  closeBrowserStaticServer,
  startBrowserStaticServer,
} from "./lsp_browser_static_server.mjs";

const port = Number(process.env.RUBRC_STDLIB_TEST_PORT ?? 4175);
const server = await startBrowserStaticServer({ hostname: "127.0.0.1", port });
try {
  const modes = process.env.RUBRC_STDLIB_ONLY === "cache"
    ? [true]
    : process.env.RUBRC_STDLIB_ONLY === "cold"
    ? [false]
    : [false, true];
  const runs = Number(process.env.RUBRC_STDLIB_RUNS ?? 1);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Error("invalid RUBRC_STDLIB_RUNS");
  }
  for (
    const [iteration, cached] of Array.from(
      { length: runs },
      (_, run) => modes.map((mode) => [run + 1, mode]),
    ).flat()
  ) {
    const browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 360_000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    let renderer;
    let started = performance.now();
    const cacheReports = [];
    try {
      const page = await browser.newPage();
      renderer = monitorRenderer(page);
      console.log(JSON.stringify({ iteration, cached, browserVersion: await browser.version() }));
      const recent = [];
      let finishAudit;
      const auditResult = new Promise((resolve) => {
        finishAudit = resolve;
      });
      let cacheDownloaded = false;
      let lspPagesPeak = 0;
      if (!cached) {
        // Intercept only the manifest, without pausing worker Wasm downloads.
        const client = await page.createCDPSession();
        await client.send("Fetch.enable", {
          patterns: [{ urlPattern: "*/std-cache.json" }],
        });
        client.on("Fetch.requestPaused", ({ requestId }) => {
          void client.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 404,
          }).catch(error => {
            if (!page.isClosed()) console.error("cache manifest interception:", String(error));
          });
        });
      }
      page.on("response", (response) => {
        if (/\.salsa\.part-\d+$/.test(response.url()) && response.ok()) {
          cacheDownloaded = true;
        }
      });
      page.on("pageerror", (error) => console.error(error.message));
      page.on("console", (message) => {
        const pages = message.text().match(/\blsp_pages=(\d+)/)?.[1];
        if (pages) lspPagesPeak = Math.max(lspPagesPeak, Number(pages));
        if (message.text().startsWith("[stdlib-cache]")) {
          cacheReports.push(message.text());
          if (message.text().includes("audit:")) finishAudit(message.text());
        }
        recent.push(`${message.type()}: ${message.text()}`);
        if (recent.length > 30) recent.shift();
        if (/cache|panicked|Error:/.test(message.text())) {
          console.log(message.text());
        }
      });
      started = performance.now();
      await renderer.race(page.goto(`http://127.0.0.1:${port}`, {
        waitUntil: "domcontentloaded",
      }));
      if (process.env.RUBRC_STDLIB_AUDIT_ONLY === "1") {
        let timer;
        try {
          const audit = await renderer.race(Promise.race([
            auditResult,
            new Promise((_, reject) => {
              timer = setTimeout(() =>
                reject(
                  new Error(
                    `cache audit not received: ${cacheReports.join("; ")}`,
                  ),
                ), 180_000);
            }),
          ]));
          if (!/std_crates=[1-9]\d*, recomputed_defmaps=0,/.test(audit)) {
            throw new Error(`standard-library memo reuse failed: ${audit}`);
          }
          if (audit.includes("item_tree_cache_enabled=true") && !/recomputed_item_trees=0\b/.test(audit)) {
            throw new Error(`standard-library ItemTree reuse failed: ${audit}`);
          }
          if (!cacheReports.some(line => /^\[stdlib-cache\] merged: moved_source_root_files=0(?:\s|$)/.test(line))) {
            throw new Error("cached source-root identities were not preserved");
          }
        } finally {
          clearTimeout(timer);
        }
        console.log(
          JSON.stringify({
            cacheReports,
            elapsedMs: performance.now() - started,
            auditOnly: true,
          }),
        );
        continue;
      }
      try {
        await renderer.race(page.waitForFunction(() => {
          const api = window.__rubrcLspTest;
          if (api?.startup?.phase === "failed") {
            throw new Error(api.startup.error);
          }
          return api?.ready && api?.startup?.phase === "ready";
        }, { timeout: Number(process.env.RUBRC_STDLIB_TIMEOUT_MS ?? 300_000) }));
      } catch (error) {
        console.error(recent);
        // Evaluating JS in a crashed renderer cannot produce useful diagnostics.
        if (renderer.error) throw error;
        console.error(JSON.stringify(
          await withDeadline(page.evaluate(async () => ({
            ready: window.__rubrcLspTest?.ready,
            startup: window.__rubrcLspTest?.startup,
            runtime: window.__rubrcLspTest?.runtime,
            events: window.__rubrcLspTest?.lspEvents?.slice(-20),
            mainDidOpenComplete: window.__rubrcLspTest?.mainDidOpenComplete,
            syntaxProbe: await Promise.race([
              window.__rubrcLspTest?.requestSyntaxTree?.("file:///src/main.rs")
                .then((value) => value.slice(0, 100)).catch((error) =>
                  String(error)
                ),
              new Promise((resolve) =>
                setTimeout(() => resolve("no response"), 5_000)
              ),
            ]),
            body: document.body.innerText.slice(-4000),
          })), 7_000, "startup diagnostics").catch(diagnosticError => ({
            diagnosticError: String(diagnosticError),
          })),
          null,
          2,
        ));
        throw error;
      }
      const elapsedMs = performance.now() - started;
      assertCacheOutcome(cached, cacheDownloaded, cacheReports);
      const graph = await withDeadline(renderer.race(page.evaluate(() =>
        window.__rubrcLspTest.requestCrateGraph()
      )), 30_000, "crate graph");
      if (!graph.includes("core") || !graph.includes("std")) {
        throw new Error("standard-library graph missing");
      }
      console.log(
        JSON.stringify({
          iteration,
          cached,
          elapsedMs,
          cacheDownloaded,
          lspLinearMemoryPeakBytes: lspPagesPeak * 65536,
          cacheReports,
        }),
      );
    } catch (error) {
      console.error(JSON.stringify({
        iteration, cached, outcome: "failed", elapsedMs: performance.now() - started,
        rendererCrashed: Boolean(renderer?.error), error: String(error), cacheReports,
      }));
      throw error;
    } finally {
      try {
        await withDeadline(browser.close(), 10_000, "browser cleanup");
      } catch (error) {
        browser.process()?.kill("SIGKILL");
        console.error(String(error));
      }
      renderer?.dispose();
    }
  }
} finally {
  await closeBrowserStaticServer(server);
}
