import { NETWORK_PROFILES, validateWorkerTransfer } from "./startup_measurement_support.mjs";
import { withDeadline } from "./stdlib_cache_browser_support.mjs";

export async function measureNetwork(browser, page, origin, profileName) {
  const profile = NETWORK_PROFILES[profileName];
  if (!profile) throw new Error(`unknown network profile: ${profileName}`);
  const sessions = new Map();
  const requests = new Map();
  const errors = [];
  const ruleIds = new Set();
  let closed = false;
  async function attach(target) {
    if (sessions.has(target)) return sessions.get(target);
    const promise = (async () => {
      const session = await withDeadline(target.createCDPSession(), 5000, "attach network target");
      await withDeadline(session.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }), 5000, "enable network target");
      const result = target === page.target() ? await withDeadline(session.send("Network.emulateNetworkConditionsByRule", {
        offline: false, matchedNetworkConditions: [{ urlPattern: "", ...profile }],
      }), 5000, "set network profile") : { ruleIds: [] };
      for (const id of result.ruleIds) ruleIds.add(id);
      const key = (id) => `${session.id()}:${id}`;
      const record = (id) => {
        const k = key(id);
        if (!requests.has(k)) requests.set(k, { target: target.type() });
        return requests.get(k);
      };
      session.on("Network.requestWillBeSent", e => Object.assign(record(e.requestId), { url: e.request.url, started: e.timestamp }));
      session.on("Network.requestWillBeSentExtraInfo", e => Object.assign(record(e.requestId), { rule: e.appliedNetworkConditionsId }));
      session.on("Network.responseReceived", e => Object.assign(record(e.requestId), {
        status: e.response.status, diskCache: e.response.fromDiskCache, serviceWorker: e.response.fromServiceWorker,
      }));
      session.on("Network.loadingFinished", e => Object.assign(record(e.requestId), { ended: e.timestamp, bytes: e.encodedDataLength }));
      session.on("Network.loadingFailed", e => Object.assign(record(e.requestId), { failed: e.errorText }));
      return session;
    })();
    sessions.set(target, promise);
    return promise;
  }
  const onTarget = target => {
    let belongsToMeasurement = false;
    try { belongsToMeasurement = new URL(target.url()).origin === origin; } catch {}
    if (!closed && belongsToMeasurement) {
      void attach(target).catch(error => {
        if (!/Target closed|Session closed|No target with given id/.test(String(error))) errors.push(String(error));
      });
    }
  };
  browser.on("targetcreated", onTarget);
  browser.on("targetchanged", onTarget);
  await attach(page.target());
  return {
    profile,
    async calibrate() {
      await page.goto(`${origin}/__rubrc_probe.html`, { waitUntil: "load" });
      const workerUrls = await page.evaluate(() => {
        const source = `onmessage = async ({data: url}) => {
          try { const start = performance.now(); const response = await fetch(url, {cache: 'no-store'});
            const bytes = (await response.arrayBuffer()).byteLength;
            postMessage({bytes, elapsedMs: performance.now() - start});
          } catch (error) { postMessage({error: String(error)}); }
        };`;
        const urls = [0, 1].map(() => URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        window.__rubrcProbeWorkers = urls.map(url => new Worker(url));
        return urls;
      });
      for (const url of workerUrls) {
        const target = await browser.waitForTarget(t => t.url() === url, { timeout: 10000 });
        await attach(target);
      }
      const result = await withDeadline(page.evaluate(async (urls) => {
        const workers = window.__rubrcProbeWorkers;
        const start = performance.now();
        try {
          const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
            worker.onmessage = e => resolve(e.data);
            worker.onerror = e => reject(new Error(e.message));
            worker.postMessage(`${location.origin}/__rubrc_probe.bin?n=${Math.random()}`);
          })));
          if (results.some(result => result.error)) throw new Error(JSON.stringify(results));
          return { bytes: results.reduce((sum, result) => sum + result.bytes, 0), elapsedMs: performance.now() - start, workers: results };
        } finally { workers.forEach(worker => worker.terminate()); urls.forEach(url => URL.revokeObjectURL(url)); }
      }, workerUrls), 30000, "Worker calibration");
      if (result.error) throw new Error(result.error);
      validateWorkerTransfer(profile, result.bytes, result.elapsedMs, 4 * 1024 * 1024);
      const matching = [...requests.values()].filter(r => r.url?.includes("/__rubrc_probe.bin"));
      return { ...result, ruleObserved: matching.some(r => ruleIds.has(r.rule)), requests: matching,
        verifiedBy: "shared page profile and concurrent Worker throughput" };
    },
    async disableHttpCache(disabled) { await (await attach(page.target())).send("Network.setCacheDisabled", { cacheDisabled: disabled }); },
    clear() { requests.clear(); },
    snapshot() { return { errors: [...errors], requests: [...requests.values()], ruleIds: [...ruleIds] }; },
    async dispose() {
      closed = true;
      browser.off("targetcreated", onTarget);
      browser.off("targetchanged", onTarget);
      await Promise.all([...sessions.values()].map(async pending => {
        const session = await pending.catch(() => null);
        if (!session) return;
        await withDeadline(session.send("Network.emulateNetworkConditionsByRule", {
          offline: false, matchedNetworkConditions: [],
        }), 3000, "network reset").catch(() => {});
        await withDeadline(session.detach(), 3000, "detach network target").catch(() => {});
      }));
    },
  };
}
