import assert from "node:assert/strict";
import puppeteer from "puppeteer";

const scripts = new Map();
for (
  const name of [
    "browser_wasi_shim_browser_lifecycle_entry.ts",
    "browser_wasi_shim_owner_worker.ts",
    "browser_wasi_shim_failing_coordinator.ts",
  ]
) {
  const result = await Bun.build({
    entrypoints: [new URL(name, import.meta.url).pathname],
    target: "browser",
    format: "esm",
    write: false,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `build failed: ${name}`);
  }
  scripts.set(`/${name}`, await result.outputs[0].text());
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const headers = {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    };
    if (path === "/") {
      return new Response(
        '<script type="module" src="/browser_wasi_shim_browser_lifecycle_entry.ts"></script>',
        {
          headers: { ...headers, "Content-Type": "text/html" },
        },
      );
    }
    const source = scripts.get(path);
    return new Response(source ?? "not found", {
      status: source === undefined ? 404 : 200,
      headers: { ...headers, "Content-Type": "text/javascript" },
    });
  },
});
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(server.url.href);
  await page.waitForFunction(() => globalThis.lifecycleResult !== undefined, {
    timeout: 10_000,
  });
  const result = await page.evaluate(() =>
    Promise.race([
      globalThis.lifecycleResult,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("public browser lifecycle timed out")),
          10_000,
        )
      ),
    ])
  );
  assert.deepEqual(result, { generations: 3, bootstrapFailure: "rejected" });
  console.log("unpatched 0.5.0 browser lifecycle passed", result);
} finally {
  await browser?.close();
  server.stop(true);
}
