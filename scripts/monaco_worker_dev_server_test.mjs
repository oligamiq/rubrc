import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const pageRoot = fileURLToPath(new URL("../page/", import.meta.url));
const configFile = fileURLToPath(
  new URL("../page/vite.config.ts", import.meta.url),
);

function importedPath(source, predicate) {
  for (const match of source.matchAll(/import\s+["']([^"']+)["']/g)) {
    if (predicate(match[1])) return match[1];
  }
  return undefined;
}

test("fresh Vite graph serves the Monaco editor worker dependency", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "rubrc-vite-worker-"));
  const server = await createServer({
    root: pageRoot,
    configFile,
    cacheDir,
    optimizeDeps: { force: true, noDiscovery: true },
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });

  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert(address !== null && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const wrapperResponse = await fetch(
      `${origin}/src/workers/editor.worker.ts?worker`,
    );
    assert.equal(wrapperResponse.status, 200, "worker wrapper did not load");
    const wrapperSource = await wrapperResponse.text();
    const workerPath = wrapperSource.match(/new Worker\(["']([^"']+)["']/)?.[1];
    assert(workerPath, "worker wrapper did not contain a worker_file URL");

    const workerResponse = await fetch(new URL(workerPath, origin));
    assert.equal(workerResponse.status, 200, "worker module did not load");
    const workerSource = await workerResponse.text();
    const dependencyPath = importedPath(
      workerSource,
      (path) =>
        (path.includes("/node_modules/.vite/deps/") ||
          path.includes("/deps/")) &&
        path.includes("editor__worker__js.js"),
    );
    assert(
      dependencyPath,
      "worker module did not use the optimized editor entry",
    );

    const dependencyResponse = await fetch(new URL(dependencyPath, origin));
    assert.notEqual(
      dependencyResponse.status,
      504,
      "editor worker dependency returned 504 Outdated Optimize Dep",
    );
    assert.equal(dependencyResponse.status, 200);
    assert.match(
      dependencyResponse.headers.get("content-type") ?? "",
      /(?:java|type)script/i,
    );
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
