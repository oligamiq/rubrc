import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { withDeadline } from "./stdlib_cache_browser_support.mjs";
import { processTree } from "./startup_runtime_profile_support.mjs";

const exec = promisify(execFile);
const MAX_PROFILE_BYTES = 64 * 1024 * 1024;
const MAX_BROWSER_RSS_KIB = 12 * 1024 * 1024;

export async function startRuntimeProfile({ browser, page, origin, output, mode }) {
  if (process.env.GITHUB_ACTIONS !== "true" || !browser.process()) {
    throw new Error("runtime profiling requires a locally launched browser on the hosted CI runner");
  }
  if (!["cpu", "memory"].includes(mode)) throw new Error("invalid runtime profile mode");
  await mkdir(output, { recursive: true });
  const started = performance.now();
  const targets = new Map();
  const errors = [];
  let stopped = false, busy = false, processSamples = 0, profileBytes = 0, profileCount = 0, wasiProfileCount = 0;
  let pendingSample = Promise.resolve();
  let writes = Promise.resolve();
  const record = data => {
    const row = { elapsedMs: performance.now() - started, mode, ...data };
    writes = writes.then(() => appendFile(join(output, "runtime-profile.jsonl"), `${JSON.stringify(row)}\n`));
    return writes;
  };
  const report = async (where, error) => {
    errors.push({ where, error: String(error) });
    await record({ kind: "instrumentation-error", ...errors.at(-1) });
  };
  function attach(target) {
    if (mode !== "cpu" || stopped || targets.has(target) || !target.url().startsWith(origin)) return;
    const state = { id: targets.size, url: target.url(), running: false };
    targets.set(target, state);
    state.pending = (async () => {
      state.session = await withDeadline(target.createCDPSession(), 5000, "attach runtime target");
      const send = (method, params) => withDeadline(state.session.send(method, params), 5000, method);
      await send("Profiler.enable");
      await send("Profiler.setSamplingInterval", { interval: 10000 });
      await send("Profiler.start");
      state.running = true;
      await record({ kind: "attached", id: state.id, url: state.url });
    })().catch(error => report("attach", error));
  }
  browser.on("targetcreated", attach);
  browser.on("targetchanged", attach);
  for (const target of browser.targets()) attach(target);

  async function sample() {
    if (stopped || busy) return;
    busy = true;
    try {
      const { stdout } = await exec("ps", ["-eo", "pid=,ppid=,rss=,args="], { timeout: 5000 });
      const processes = processTree(stdout, browser.process().pid);
      if (!processes.length) throw new Error("browser process tree is no longer observable");
      const totalRssKiB = processes.reduce((sum, row) => sum + row.rssKiB, 0);
      await record({ kind: "process-memory", processes, totalRssKiB });
      processSamples++;
      if (totalRssKiB > MAX_BROWSER_RSS_KIB) {
        await report("memory-budget", new Error(`browser tree exceeded ${MAX_BROWSER_RSS_KIB} KiB RSS`));
        stopped = true;
        await withDeadline(browser.close(), 10000, "close over-budget browser")
          .catch(() => browser.process()?.kill("SIGKILL"));
        return;
      }
      const state = await withDeadline(page.evaluate(() => ({
        phase: window.__rubrcLspTest?.startup?.phase, timeOrigin: performance.timeOrigin,
      })), 5000, "profile phase");
      await record({ kind: "phase", ...state });
    } catch (error) {
      if (!/Target closed|Session closed|Execution context was destroyed|Cannot find context/.test(String(error))) {
        await report("sample", error);
      }
    } finally { busy = false; }
  }
  const onDestroyed = target => { const state = targets.get(target); if (state) state.closed = true; };
  browser.on("targetdestroyed", onDestroyed);
  const timer = setInterval(() => {
    if (busy || stopped) return;
    pendingSample = sample().catch(error => { errors.push({ where: "sample-log", error: String(error) }); });
  }, 5000);

  async function checkpoint(label) {
    if (mode !== "cpu") return;
    let visitWorkerProfiles = 0;
    await Promise.all([...targets.values()].map(async target => {
      await target.pending;
      if (!target.running) return;
      target.running = false;
      try {
        const { profile } = await withDeadline(target.session.send("Profiler.stop"), 10000, "stop CPU profile");
        const bytes = JSON.stringify(profile);
        profileBytes += Buffer.byteLength(bytes);
        if (profileBytes > MAX_PROFILE_BYTES) throw new Error("CPU profile output exceeded 64 MiB budget");
        const file = `cpu-${label}-${target.id}.cpuprofile`;
        await writeFile(join(output, file), bytes);
        profileCount++;
        if (target.url.startsWith(`${origin}/assets/thread_spawn-`) && profile.samples?.length) {
          visitWorkerProfiles++;
          wasiProfileCount++;
        }
        await record({ kind: "cpu-profile", id: target.id, url: target.url, file,
          samples: profile.samples?.length ?? 0, startTime: profile.startTime, endTime: profile.endTime });
      } catch (error) { await report("cpu-profile", error); }
    }));
    if (["cold", "reload"].includes(label) && !visitWorkerProfiles) {
      await report("coverage", new Error(`no WASI worker CPU samples saved for ${label}`));
    }
  }
  return {
    checkpoint,
    async dispose() {
      stopped = true;
      clearInterval(timer);
      browser.off("targetcreated", attach);
      browser.off("targetchanged", attach);
      browser.off("targetdestroyed", onDestroyed);
      await withDeadline(pendingSample, 15000, "last runtime sample");
      await checkpoint("final");
      await Promise.all([...targets.values()].map(async target => {
        await target.pending;
        if (!target.session || target.closed) return;
        await withDeadline(target.session.detach(), 3000, "detach runtime target").catch(() => {});
      }));
      if (mode === "memory" && !processSamples) errors.push({ where: "coverage", error: "no process memory samples saved" });
      if (mode === "cpu" && !wasiProfileCount) errors.push({ where: "coverage", error: "no WASI worker CPU profiles saved" });
      await record({ kind: "profile-outcome", errors, profileCount, wasiProfileCount, profileBytes, processSamples });
      await writes;
      if (errors.length) process.exitCode = 1;
    },
  };
}
