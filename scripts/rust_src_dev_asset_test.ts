/// <reference lib="deno.ns" />

import {
  pruneDevelopmentRustSrcAssets,
  writeRustSrcDevAsset,
} from "./prepare_rust_src_dev_asset.ts";

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

Deno.test("development pruning removes only temporary files older than one hour", async () => {
  const directory = await Deno.makeTempDir();
  const oldTemporary = `${directory}/rust-src-old.tmp`;
  const recentTemporary = `${directory}/rust-src-recent.tmp`;
  try {
    await Deno.writeFile(oldTemporary, new Uint8Array([1]));
    await Deno.writeFile(recentTemporary, new Uint8Array([2]));
    const now = Date.now();
    await Deno.utime(
      oldTemporary,
      new Date(now - 3_600_001),
      new Date(now - 3_600_001),
    );
    await Deno.utime(
      recentTemporary,
      new Date(now - 3_599_999),
      new Date(now - 3_599_999),
    );

    await pruneDevelopmentRustSrcAssets(directory, "a".repeat(64), undefined);

    let oldExists = true;
    try {
      await Deno.stat(oldTemporary);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      oldExists = false;
    }
    assert(!oldExists, "temporary file older than one hour was retained");
    assert(
      (await Deno.stat(recentTemporary)).isFile,
      "temporary file younger than one hour was removed",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development pruning ignores only NotFound stat and remove races", async () => {
  const entry: Deno.DirEntry = {
    name: "abandoned.tmp",
    isFile: true,
    isDirectory: false,
    isSymlink: false,
  };
  const entries = async function* () {
    yield entry;
  };

  for (const operation of ["stat", "remove"] as const) {
    for (const error of [
      new Deno.errors.NotFound("concurrent removal"),
      new Deno.errors.PermissionDenied("permission denied"),
    ]) {
      let rejection: unknown;
      try {
        await pruneDevelopmentRustSrcAssets("/virtual/dev", "a".repeat(64), {
          readDir: entries,
          async stat() {
            if (operation === "stat") throw error;
            return { mtime: new Date(0) } as Deno.FileInfo;
          },
          async remove() {
            if (operation === "remove") throw error;
          },
          now: () => 3_600_001,
        });
      } catch (caught) {
        rejection = caught;
      }

      if (error instanceof Deno.errors.NotFound) {
        assert(rejection === undefined, `${operation} NotFound was propagated`);
      } else {
        assert(rejection === error, `${operation} filesystem error was hidden`);
      }
    }
  }
});

Deno.test("same-hash replacement requires a regular destination", async () => {
  const directory = await Deno.makeTempDir();
  const outputDirectory = `${directory}/dev`;
  const archive = new Uint8Array([4, 5, 6]);
  const prepare = async () => ({
    archive,
    cacheArchive: ".rubrc-cache/sysroot/rust-src.tar.vfsbr",
    source: "cache" as const,
  });
  try {
    const sha256 = await writeRustSrcDevAsset(outputDirectory, prepare);
    const repeatedSha256 = await writeRustSrcDevAsset(outputDirectory, prepare);
    assert(
      repeatedSha256 === sha256,
      "same-hash POSIX replacement changed identity",
    );
    assert(
      (await Deno.stat(`${outputDirectory}/rust-src-${sha256}.tar.vfsbr`))
        .isFile,
      "same-hash destination stopped being a regular file",
    );

    const emptySha256 =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const blockingDirectory = `${outputDirectory}/rust-src-${emptySha256}.tar.vfsbr`;
    await Deno.mkdir(blockingDirectory);
    let rejection: unknown;
    try {
      await writeRustSrcDevAsset(outputDirectory, async () => ({
        archive: new Uint8Array(),
        cacheArchive: ".rubrc-cache/sysroot/rust-src.tar.vfsbr",
        source: "cache",
      }));
    } catch (error) {
      rejection = error;
    }
    assert(rejection instanceof Error, "non-file destination was accepted");
    assert(
      rejection.message.includes("not a regular file"),
      "non-file destination error was unclear",
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
      prepareSource.includes("DEV_RUST_SRC_TMP_MAX_AGE_MS = 60 * 60 * 1_000") &&
      prepareSource.includes("await Deno.rename(temporaryAsset, assetPath)") &&
      prepareSource.includes(
        "await Deno.rename(temporarySidecar, sidecarPath)",
      ) &&
      !prepareSource.includes("Deno.errors.AlreadyExists"),
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
      vite.includes('request.method !== "GET" && request.method !== "HEAD"') &&
      vite.includes('requestUrl.searchParams.get("v") !== asset.sha256') &&
      vite.includes("response.statusCode = 409") &&
      vite.includes(
        'response.setHeader("Content-Type", "application/octet-stream")',
      ) &&
      vite.includes(
        'response.setHeader("Content-Length", String(stat.size))',
      ) &&
      vite.includes('"Cache-Control"') &&
      vite.includes('"public, max-age=31536000, immutable"') &&
      vite.includes('request.method === "HEAD"') &&
      vite.includes("stream = file.createReadStream()") &&
      vite.includes("await pipeline(stream, response)") &&
      vite.includes("if (response.destroyed)") &&
      vite.includes("void serveDevelopmentRustSrcAsset(") &&
      vite.includes("if (!response.destroyed) next(error)"),
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
