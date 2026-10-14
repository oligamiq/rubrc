import puppeteer from "puppeteer";
import { mkdir, writeFile, appendFile, access, readFile, readdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { startBrowserStaticServer, closeBrowserStaticServer } from "./lsp_browser_static_server.mjs";
import { monitorRenderer, withDeadline, assertCacheOutcome } from "./stdlib_cache_browser_support.mjs";
import { measureNetwork } from "./startup_network_measurement.mjs";
import { installLspEventTiming, startupReachedTerminalState, summarizeStartup } from "./startup_measurement_support.mjs";
import { measureEditorInteractions } from "./startup_interaction_measurement.mjs";

const root = resolve(process.env.RUBRC_MEASURE_ROOT ?? "page/dist");
const output = resolve(process.env.RUBRC_MEASURE_OUTPUT ?? "ci-logs/startup");
const profile = process.env.RUBRC_MEASURE_PROFILE ?? "normal";
const port = Number(process.env.RUBRC_MEASURE_PORT ?? 4187);
const timeout = Number(process.env.RUBRC_MEASURE_TIMEOUT_MS ?? 600000);
const remote = process.env.RUBRC_MEASURE_CDP;
const reportedCpus = Number(process.env.RUBRC_MEASURE_REPORTED_CPUS ?? 0);
if (!Number.isInteger(reportedCpus) || reportedCpus < 0 || reportedCpus > 16) throw new Error("invalid reported CPU override");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid measurement port");
await access(join(root, "index.html"));
await mkdir(output, { recursive: true });
await writeFile(join(root, "__rubrc_probe.html"), "<!doctype html><meta charset=utf-8><title>Network calibration</title>");
await writeFile(join(root, "__rubrc_probe.bin"), Buffer.alloc(2 * 1024 * 1024, 123));
const origin = `http://127.0.0.1:${port}`;
const server = await startBrowserStaticServer({ rootDirectory: root, port });
let browser, page, network, renderer;
const file = join(output, `${profile}.jsonl`);
const record = async data => {
  console.log(JSON.stringify(data));
  await appendFile(file, `${JSON.stringify(data)}\n`);
};
try {
  browser = remote
    ? await puppeteer.connect({ browserURL: remote, defaultViewport: null, protocolTimeout: timeout + 30000 })
    : await puppeteer.launch({ headless: true, protocolTimeout: timeout + 30000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"], defaultViewport: { width: 1280, height: 900 } });
  page = await browser.newPage();
  await page.bringToFront();
  // This port is a dedicated measurement origin, never the user's normal site.
  const storage = await page.createCDPSession();
  await storage.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  await storage.detach();
  renderer = monitorRenderer(page);
  page.on("pageerror", error => console.error("PAGE ERROR", String(error)));
  const cacheReports = [];
  const sysrootReports = [];
  let cacheDownloaded = false;
  page.on("console", message => {
    if (message.text().startsWith("[stdlib-cache]")) { cacheReports.push(message.text()); console.log(message.text()); }
    if (message.text().startsWith("[startup-sysroot] ")) sysrootReports.push(JSON.parse(message.text().slice("[startup-sysroot] ".length)));
  });
  page.on("response", response => { if (/\.salsa\.part-\d+$/.test(response.url()) && response.ok()) cacheDownloaded = true; });
  network = await measureNetwork(browser, page, origin, profile);
  const calibration = await renderer.race(network.calibrate());
  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
  }));
  await record({ kind: "calibration", profile, remote: Boolean(remote), browser: await browser.version(),
    limits: network.profile, ...environment, calibration });
  if (process.env.RUBRC_MEASURE_CALIBRATION_ONLY !== "1") {
    if (reportedCpus) {
      await page.evaluateOnNewDocument(value => Object.defineProperty(navigator, "hardwareConcurrency", { get: () => value }), reportedCpus);
      await record({ kind: "configuration-experiment", actualReportedCpus: environment.hardwareConcurrency, overriddenReportedCpus: reportedCpus });
    }
    const build = JSON.parse(await readFile(join(root, "__rubrc_measurement_build.json"), "utf8"));
    if (!/^[0-9a-f]{40}$/.test(build.sourceSha) || !/^[0-9a-f]{40}$/.test(build.analyzerSha)) throw new Error("invalid preview build identity");
    await record({ kind: "build", ...build });
    const manifestName = (await readdir(join(root, "assets"))).find(name => name.endsWith(".wasm.br.json"));
    if (!manifestName) throw new Error("missing VFS distribution manifest");
    const vfsManifest = JSON.parse(await readFile(join(root, "assets", manifestName), "utf8"));
    const cacheManifest = JSON.parse(await readFile(join(root, "std-cache.json"), "utf8"));
    const expectedPaths = ["/rust-src.sqfs", ...vfsManifest.parts.map(part => `/assets/${part.file}`), ...cacheManifest.parts.map(part => `/${part.file}`)];
    await page.evaluateOnNewDocument(installLspEventTiming);
    for (const visit of ["cold", "reload"]) {
      cacheReports.length = 0;
      sysrootReports.length = 0;
      cacheDownloaded = false;
      network.clear();
      await network.disableHttpCache(visit === "cold");
      const start = performance.now();
      try {
        await renderer.race(page.goto(origin, { waitUntil: "domcontentloaded" }));
        if (remote) {
          const lock = await page.evaluate(async () => {
            if (document.visibilityState !== "visible") throw new Error("measurement tab is not visible");
            window.__rubrcScreenLock = await navigator.wakeLock.request("screen");
            return !window.__rubrcScreenLock.released;
          });
          if (!lock) throw new Error("screen wake lock was not acquired");
        }
        await renderer.race(page.waitForSelector("[data-rust-analyzer-parallelism]", { timeout: 60000 }));
        const parallelism = await page.$eval("[data-rust-analyzer-parallelism]", node => node.textContent);
        await renderer.race(page.waitForFunction(startupReachedTerminalState, { timeout, polling: 250 }));
        const terminalState = await page.evaluate(() => window.__rubrcLspTest?.startup);
        if (terminalState?.phase === "failed") throw new Error(terminalState.error ?? "startup failed");
        const elapsedMs = performance.now() - start;
        assertCacheOutcome(true, cacheDownloaded, cacheReports);
        const state = await renderer.race(page.evaluate(() => ({
          startup: window.__rubrcLspTest.startup,
          measurements: window.__rubrcLspTest.startupMeasurements,
          events: window.__rubrcMeasureEvents,
          modelVersion: window.__rubrcLspTest.model.getVersionId(),
          timeOrigin: performance.timeOrigin,
        })));
        state.parallelism = parallelism;
        const installedSysroots = Object.fromEntries(sysrootReports.filter(report => report.epochMs >= state.timeOrigin)
          .map(report => [report.kind, report.epochMs - state.timeOrigin]));
        const summary = summarizeStartup(state.measurements, installedSysroots);
        if (summary.postSysrootMs === undefined) throw new Error("missing individual sysroot timestamps");
        const net = network.snapshot();
        const assetRows = net.requests.filter(r => /\.br\.part-|\.salsa\.part-|rust-src\.sqfs|\.vfsbr/.test(r.url ?? ""));
        // Chrome's Worker Network events may omit the optional rule ID. Use
        // the shared-profile calibration and verify that every cold asset was
        // actually observed, rather than silently treating missing data as fast.
        const missingAssets = visit === "cold" ? expectedPaths.filter(path => !assetRows.some(r => new URL(r.url).pathname === path && r.bytes > 0)) : [];
        await writeFile(join(output, `${profile}-${visit}-network.json`), JSON.stringify(net, null, 2));
        await page.screenshot({ path: join(output, `${profile}-${visit}.png`) });
        await record({ kind: "startup", profile, visit, elapsedMs, ...summary, ...state, installedSysroots,
          cacheReports: [...cacheReports], networkRequests: net.requests.length,
          networkCalibration: calibration, missingAssets,
          assetRuleMetadataAvailable: assetRows.filter(r => net.ruleIds.includes(r.rule)).length,
          workerSetupErrors: net.errors });
        if (missingAssets.length) throw new Error(`missing cold asset network observations: ${missingAssets.join(", ")}`);
        if (net.errors.length) throw new Error("worker network instrumentation failed");
        if (visit === "reload") {
          const interactions = await renderer.race(measureEditorInteractions(page, join(output, profile)));
          await page.screenshot({ path: join(output, `${profile}-interactions.png`) });
          await record({ kind: "interactions", profile, ...interactions });
        }
      } catch (error) {
        const state = renderer.error ? null : await withDeadline(page.evaluate(() => ({
          startup: window.__rubrcLspTest?.startup, measurements: window.__rubrcLspTest?.startupMeasurements,
          events: window.__rubrcMeasureEvents, body: document.body.innerText.slice(-3000),
        })), 5000, "failure snapshot").catch(String);
        await record({ kind: "failure", profile, visit, elapsedMs: performance.now() - start,
          error: String(error), rendererCrashed: Boolean(renderer.error), cacheReports: [...cacheReports], state });
        await writeFile(join(output, `${profile}-${visit}-failure-network.json`), JSON.stringify(network.snapshot(), null, 2));
        if (!renderer.error) await withDeadline(page.screenshot({ path: join(output, `${profile}-${visit}-failure.png`) }), 5000, "failure screenshot").catch(() => {});
        throw error;
      }
    }
  }
} finally {
  await network?.dispose();
  renderer?.dispose();
  if (remote) {
    if (page) await withDeadline(page.close(), 5000, "close measurement tab").catch(() => {});
    browser?.disconnect();
  } else if (browser) {
    await withDeadline(browser.close(), 10000, "close measurement browser").catch(() => browser.process()?.kill("SIGKILL"));
  }
  await withDeadline(closeBrowserStaticServer(server), 5000, "close measurement server");
  await Promise.all(["__rubrc_probe.html", "__rubrc_probe.bin"].map(name => unlink(join(root, name)).catch(() => {})));
}
