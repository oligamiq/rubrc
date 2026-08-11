/// <reference lib="deno.ns" />

import { resolve } from "node:path";
import {
  closeBrowserStaticServer,
  resolveStaticPath,
  startBrowserStaticServer,
} from "./lsp_browser_static_server.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("browser static server confines paths and serves GET/HEAD with explicit MIME", async () => {
  const directory = await Deno.makeTempDir();
  const assets = `${directory}/assets`;
  await Deno.mkdir(assets);
  await Deno.writeTextFile(`${directory}/index.html`, "<main>rubrc</main>");
  await Deno.writeTextFile(`${assets}/app.js`, "export const ready = true;");
  await Deno.writeTextFile(`${assets}/app.css`, "main { color: green; }");
  await Deno.writeFile(
    `${assets}/worker.wasm`,
    new Uint8Array([0, 97, 115, 109]),
  );
  await Deno.writeFile(
    `${directory}/rust-src.tar.vfsbr`,
    new Uint8Array([1, 2, 3]),
  );
  const server = await startBrowserStaticServer({
    rootDirectory: directory,
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const address = server.address();
    assert(
      address !== null && typeof address === "object",
      "server has no TCP address",
    );
    const base = `http://127.0.0.1:${address.port}`;

    for (const [path, contentType] of [
      ["/", "text/html; charset=utf-8"],
      ["/assets/app.js", "text/javascript; charset=utf-8"],
      ["/assets/app.css", "text/css; charset=utf-8"],
      ["/assets/worker.wasm", "application/wasm"],
      ["/rust-src.tar.vfsbr", "application/octet-stream"],
    ]) {
      const response = await fetch(`${base}${path}`);
      assert(response.status === 200, `${path} returned ${response.status}`);
      assert(
        response.headers.get("content-type") === contentType,
        `${path} returned ${response.headers.get("content-type")}`,
      );
      assert(
        response.headers.get("cross-origin-embedder-policy") ===
          "require-corp" &&
          response.headers.get("cross-origin-opener-policy") === "same-origin",
        `${path} omitted cross-origin isolation`,
      );
      assert(
        response.headers.get("cache-control") === null,
        `${path} unexpectedly enabled caching`,
      );
      await response.body?.cancel();
    }

    const head = await fetch(`${base}/rust-src.tar.vfsbr`, { method: "HEAD" });
    assert(head.status === 200, `HEAD returned ${head.status}`);
    assert(
      head.headers.get("content-length") === "3",
      "HEAD omitted content length",
    );
    assert((await head.arrayBuffer()).byteLength === 0, "HEAD returned a body");

    const fallback = await fetch(`${base}/deep/client/route`, {
      headers: { accept: "text/html" },
    });
    assert(fallback.status === 200, "SPA fallback did not return 200");
    assert(
      fallback.headers.get("content-type") === "text/html; charset=utf-8" &&
        (await fallback.text()) === "<main>rubrc</main>",
      "SPA fallback did not serve index.html",
    );

    const post = await fetch(`${base}/rust-src.tar.vfsbr`, { method: "POST" });
    assert(post.status === 405, `POST returned ${post.status}`);
    assert(
      post.headers.get("allow") === "GET, HEAD",
      "405 omitted Allow header",
    );
  } finally {
    await closeBrowserStaticServer(server);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("browser static path resolution rejects traversal", () => {
  const root = resolve("/tmp/rubrc-static-root");
  assert(
    resolveStaticPath(root, "/assets/app.js") ===
      resolve(root, "assets/app.js"),
    "normal static path changed",
  );
  for (const path of [
    "/../outside.txt",
    "/%2e%2e%2foutside.txt",
    "/..\\outside.txt",
    "/%00outside.txt",
  ]) {
    assert(
      resolveStaticPath(root, path) === null,
      `${path} escaped static root`,
    );
  }
});

Deno.test("browser static server prevents real-filesystem symlink escapes", async () => {
  const directory = await Deno.makeTempDir();
  const root = `${directory}/root`;
  const outside = `${directory}/outside`;
  await Deno.mkdir(root);
  await Deno.writeTextFile(outside, "secret");
  await Deno.symlink(outside, `${root}/symlink`);
  await Deno.symlink(outside, `${root}/index.html`);

  const server = await startBrowserStaticServer({
    rootDirectory: root,
    hostname: "127.0.0.1",
    port: 0,
  });

  try {
    const address = server.address();
    assert(
      address !== null && typeof address === "object",
      "server has no TCP address",
    );
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/symlink`);
    await response.body?.cancel();
    assert(
      response.status === 400 || response.status === 404,
      `Symlink escaped with status ${response.status}`,
    );

    const fallback = await fetch(`${base}/missing/route`, {
      headers: { accept: "text/html" },
    });
    assert(
      fallback.status === 404,
      "symlinked SPA fallback escaped static root",
    );
    assert(
      (await fallback.text()) !== "secret",
      "symlinked fallback leaked bytes",
    );
  } finally {
    await closeBrowserStaticServer(server);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("browser static server handles pre-header open/stream failure without partial 200", async () => {
  const directory = await Deno.makeTempDir();
  const file = `${directory}/unreadable.txt`;
  await Deno.writeTextFile(file, "test");
  await Deno.chmod(file, 0o000);

  const server = await startBrowserStaticServer({
    rootDirectory: directory,
    hostname: "127.0.0.1",
    port: 0,
  });

  try {
    const address = server.address();
    assert(
      address !== null && typeof address === "object",
      "server has no TCP address",
    );
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/unreadable.txt`);
    const body = await response.text();
    assert(response.status === 500, `Expected 500, got ${response.status}`);
    assert(
      response.headers.get("content-type") === "text/plain; charset=utf-8",
      `Outer 500 omitted text/plain Content-Type, got ${response.headers.get("content-type")}`,
    );
    assert(body === "Internal Server Error\n", "Outer 500 body changed");
    assert(
      response.headers.get("content-length") ===
        String(new TextEncoder().encode(body).byteLength),
      "Outer 500 retained stale response framing",
    );
  } finally {
    await Deno.chmod(file, 0o644);
    await closeBrowserStaticServer(server);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("browser static server SPA fallback is navigation/HTML-only", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(`${directory}/index.html`, "<main>rubrc</main>");

  const server = await startBrowserStaticServer({
    rootDirectory: directory,
    hostname: "127.0.0.1",
    port: 0,
  });

  try {
    const address = server.address();
    assert(
      address !== null && typeof address === "object",
      "server has no TCP address",
    );
    const base = `http://127.0.0.1:${address.port}`;

    const htmlReq = await fetch(`${base}/deep/client/route`, {
      headers: { accept: "text/html" },
    });
    assert(
      htmlReq.status === 200,
      "Accept: text/html missing route did not return 200",
    );
    assert(
      htmlReq.headers.get("content-type") === "text/html; charset=utf-8",
      "SPA fallback omitted text/html Content-Type",
    );
    await htmlReq.body?.cancel();

    const anyReq = await fetch(`${base}/deep/client/route`, {
      headers: { accept: "*/*" },
    });
    assert(
      anyReq.status === 404,
      `Accept: */* missing route did not return 404, got ${anyReq.status}`,
    );
    await anyReq.body?.cancel();

    const assetReq = await fetch(`${base}/missing-asset.js`, {
      headers: { accept: "text/html" },
    });
    assert(
      assetReq.status === 404,
      `Missing asset with text/html Accept did not return 404, got ${assetReq.status}`,
    );
    await assetReq.body?.cancel();
  } finally {
    await closeBrowserStaticServer(server);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("browser diagnostics uses the Bun static server without changing Vite preview", async () => {
  const rootPackage = JSON.parse(await Deno.readTextFile("package.json"));
  const harness = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );
  const vite = await Deno.readTextFile("page/vite.config.ts");

  assert(
    rootPackage.scripts["test:lsp-browser"] ===
      "VITE_RUBRC_LSP_TEST=1 bun run --cwd page build && bun run vfs:prepare:prod && bun run rust-src:prepare-asset && bun scripts/lsp_browser_diagnostics_test.mjs",
    "browser diagnostics is not executed by Bun",
  );
  assert(
    harness.includes('from "./lsp_browser_static_server.mjs"') &&
      harness.includes("await startBrowserStaticServer(") &&
      harness.includes("await closeBrowserStaticServer(staticServer)") &&
      !harness.includes('from "node:child_process"') &&
      !harness.includes('"serve"'),
    "browser harness still owns a Vite preview child",
  );
  assert(
    harness.includes("message.location().url") &&
      harness.includes('"/.rubrc-pages-build.json"') &&
      !harness.includes("optionalMetadataNotFoundResponses"),
    "browser harness does not bind the optional metadata 404 to its URL",
  );
  assert(
    vite.includes("preview: { headers: crossOriginIsolationHeaders }") &&
      !vite.includes("configurePreviewServer"),
    "production Vite preview configuration changed",
  );
});
