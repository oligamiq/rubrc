/// <reference lib="deno.ns" />

import { writeRustSrcDevAsset } from "./prepare_rust_src_dev_asset.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("development rust-src writer publishes bytes and atomic SHA sidecar", async () => {
  const directory = await Deno.makeTempDir();
  const outputDirectory = `${directory}/dev`;
  try {
    const sha256 = await writeRustSrcDevAsset(outputDirectory, async () => ({
      archive: new Uint8Array([4, 5, 6]),
      cacheArchive: ".rubrc-cache/sysroot/rust-src.tar.vfsbr",
      source: "cache",
    }));

    assert(
      sha256 ===
        "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
      "development writer returned the wrong SHA-256",
    );
    const asset = await Deno.readFile(
      `${outputDirectory}/rust-src-${sha256}.tar.vfsbr`,
    );
    assert(asset.join(",") === "4,5,6", "development asset bytes changed");
    const sidecar = await Deno.readTextFile(
      `${outputDirectory}/rust-src.sha256`,
    );
    assert(sidecar === `${sha256}\n`, "SHA-256 sidecar content changed");
    const entries = [];
    for await (const entry of Deno.readDir(`${directory}/dev`)) {
      entries.push(entry.name);
    }
    assert(
      entries.sort().join(",") ===
        `rust-src-${sha256}.tar.vfsbr,rust-src.sha256`,
      `temporary sidecar leaked: ${entries.join(",")}`,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development rust-src writer retains only three immutable versions", async () => {
  const directory = await Deno.makeTempDir();
  const outputDirectory = `${directory}/dev`;
  try {
    let activeSha256 = "";
    for (const byte of [1, 2, 3, 4]) {
      activeSha256 = await writeRustSrcDevAsset(outputDirectory, async () => ({
        archive: new Uint8Array([byte]),
        cacheArchive: ".rubrc-cache/sysroot/rust-src.tar.vfsbr",
        source: "generated",
      }));
    }
    const assets = [];
    for await (const entry of Deno.readDir(outputDirectory)) {
      if (/^rust-src-[a-f0-9]{64}\.tar\.vfsbr$/.test(entry.name)) {
        assets.push(entry.name);
      }
    }
    assert(assets.length === 3, `retained ${assets.length} archive versions`);
    assert(
      assets.includes(`rust-src-${activeSha256}.tar.vfsbr`),
      "active content-addressed archive was pruned",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development rust-src lifecycle stays ignored and outside production", async () => {
  const rootPackage = JSON.parse(await Deno.readTextFile("package.json"));
  const pagePackage = JSON.parse(await Deno.readTextFile("page/package.json"));
  const ignore = await Deno.readTextFile(".gitignore");
  const prepareSource = await Deno.readTextFile(
    "scripts/prepare_rust_src_dev_asset.ts",
  );

  assert(
    rootPackage.scripts["rust-src:prepare-dev-asset"] ===
      "deno run --no-lock --allow-read --allow-write --allow-run scripts/prepare_rust_src_dev_asset.ts",
    "root development preparation command changed",
  );
  assert(
    pagePackage.scripts.predev ===
      "bun run --cwd .. rust-src:prepare-dev-asset" &&
      pagePackage.scripts.prestart ===
        "bun run --cwd .. rust-src:prepare-dev-asset",
    "page dev/start lifecycle does not prepare the validated asset",
  );
  assert(
    ignore.split(/\r?\n/).includes(".rubrc-cache/"),
    ".rubrc-cache is not ignored",
  );
  assert(
    prepareSource.includes("export const DEV_RUST_SRC_DIRECTORY") &&
      prepareSource.includes('".rubrc-cache/dev"') &&
      prepareSource.includes("const { archive } = await prepare()") &&
      prepareSource.includes("rust-src-${sha256}.tar.vfsbr") &&
      prepareSource.includes("DEV_RUST_SRC_RETAINED_ASSETS = 3") &&
      prepareSource.includes(
        "await pruneDevelopmentRustSrcAssets(directory, sha256)",
      ) &&
      prepareSource.includes("await Deno.rename(temporaryAsset, assetPath)") &&
      prepareSource.includes(
        "await Deno.rename(temporarySidecar, sidecarPath)",
      ),
    "development writer does not use validated output and atomic sidecar publication",
  );
  assert(
    !rootPackage.scripts["rust-src:prepare-dev-asset"].includes(
      "page/public",
    ) && !prepareSource.includes("page/public"),
    "development asset leaks into Vite public assets",
  );
});

Deno.test("Vite development identity and middleware are hash-bound", async () => {
  const vite = await Deno.readTextFile("page/vite.config.ts");

  assert(
    vite.includes(
      "export default defineConfig(async ({ command, isPreview }) =>",
    ) &&
      vite.includes(
        'const isDevelopmentServer = command === "serve" && isPreview !== true;',
      ),
    "Vite config is not asynchronous and dev-only",
  );
  assert(
    vite.includes("rust-src.sha256") &&
      vite.includes("rust-src-${sha256}.tar.vfsbr") &&
      vite.includes("developmentRustSrcAsset?.sha256") &&
      vite.includes('process.env.SOURCE_SHA ?? "development"'),
    "Vite source revision does not separate development hash from production SHA",
  );
  assert(
    vite.includes('requestUrl.pathname !== "/rust-src.tar.vfsbr"') &&
      vite.includes('requestUrl.searchParams.get("v") !== asset.sha256') &&
      vite.includes("response.statusCode = 409") &&
      vite.includes(
        'response.setHeader("Content-Type", "application/octet-stream")',
      ) &&
      vite.includes(
        'response.setHeader("Content-Length", String(stat.size))',
      ) &&
      vite.includes("await pipeline(file.createReadStream(), response)") &&
      vite.includes("if (response.headersSent)") &&
      vite.includes("response.destroy()") &&
      vite.includes("void serveDevelopmentRustSrcAsset(") &&
      vite.includes(".catch(next)"),
    "Vite middleware is not path-, hash-, MIME-, and error-bound",
  );
  assert(
    !vite.includes("page/public") && !vite.includes("configurePreviewServer"),
    "development middleware leaks into public or preview serving",
  );
  for (const dependency of [
    '"vscode"',
    '"@codingame/monaco-vscode-api"',
    '"@codingame/monaco-vscode-extension-api"',
    '"@codingame/monaco-vscode-extensions-service-override"',
  ]) {
    assert(vite.includes(dependency), `Vite dedupe lost ${dependency}`);
  }
});
