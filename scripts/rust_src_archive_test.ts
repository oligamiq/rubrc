import { rustWasmReleaseArchiveUrl } from "../lib/src/rust_wasm_release.ts";
import { prepareReleasedRustSrcArchive } from "./rust_src_archive.ts";
import { prepareCachedArchive } from "./sysroot_cache.ts";

Deno.test("released rust-src preparation uses the pinned release and validates bytes", async () => {
  const calls: unknown[] = [];
  const archive = new Uint8Array([7]);
  const result = await prepareReleasedRustSrcArchive({
    deps: {
      prepare: async (options) => {
        calls.push(options);
        return {
          archive,
          source: "download",
          cacheArchive: ".cache/rust-src.tar.br",
          url: rustWasmReleaseArchiveUrl("rust-src"),
        };
      },
      validate: async (bytes) => bytes === archive,
      remove: async () => {
        throw new Error("valid archive was removed");
      },
    },
  });
  if (result.archive !== archive || result.source !== "download") {
    throw new Error("released archive was not returned");
  }
  const options = calls[0] as { triple: string; url: string };
  if (
    options.triple !== "rust-src" ||
    options.url !== rustWasmReleaseArchiveUrl("rust-src")
  ) throw new Error(`wrong release request: ${JSON.stringify(options)}`);
});

Deno.test("released rust-src never reuses the legacy installed-toolchain cache", async () => {
  const legacyCacheArchive = ".rubrc-cache/sysroot/rust-src.tar.br";
  const releaseArchive = new Uint8Array([7]);
  let downloaded = false;
  const result = await prepareReleasedRustSrcArchive({
    deps: {
      prepare: (options) =>
        prepareCachedArchive({
          ...options,
          deps: {
            exists: async (path) => path === legacyCacheArchive,
            remove: async () => {},
            mkdir: async () => {},
            readFile: async () => new Uint8Array([6]),
            writeFile: async () => {},
            rename: async () => {},
            fetchBytes: async () => {
              downloaded = true;
              return releaseArchive;
            },
            extractTarBr: async () => {},
          },
        }),
      validate: async () => true,
      remove: async () => {},
    },
  });

  if (!downloaded || result.source !== "download") {
    throw new Error("legacy installed-toolchain cache was reused");
  }
  if (
    result.cacheArchive !==
      ".rubrc-cache/sysroot/rust_wasm/v0.2.1/rust-src.tar.br"
  ) {
    throw new Error(`release cache was not versioned: ${result.cacheArchive}`);
  }
});

Deno.test("invalid released rust-src is removed from cache", async () => {
  let removed = "";
  await prepareReleasedRustSrcArchive({
    deps: {
      prepare: async () => ({
        archive: new Uint8Array([9]),
        source: "cache",
        cacheArchive: ".cache/rust-src.tar.br",
        url: rustWasmReleaseArchiveUrl("rust-src"),
      }),
      validate: async () => false,
      remove: async (path) => {
        removed = path;
      },
    },
  }).then(
    () => {
      throw new Error("invalid released rust-src was accepted");
    },
    (error) => {
      if (!(error instanceof Error) || !error.message.includes("invalid")) {
        throw error;
      }
    },
  );
  if (removed !== ".cache/rust-src.tar.br") {
    throw new Error(`invalid cache was not removed: ${removed}`);
  }
});

Deno.test("rust-src asset command writes validated bytes into dist", async () => {
  let assetModule: {
    writeRustSrcAsset?: (
      outputPath: string,
      prepare: () => Promise<{
        archive: Uint8Array;
        cacheArchive: string;
        source: "cache" | "download";
      }>,
    ) => Promise<void>;
  };
  try {
    assetModule = await import("./prepare_rust_src_asset.ts");
  } catch (error) {
    throw new Error("rust-src asset command is missing", { cause: error });
  }
  if (typeof assetModule.writeRustSrcAsset !== "function") {
    throw new Error("rust-src asset writer is missing");
  }

  const directory = await Deno.makeTempDir();
  const outputPath = `${directory}/dist/rust-src.tar.vfsbr`;
  try {
    await assetModule.writeRustSrcAsset(outputPath, async () => ({
      archive: new Uint8Array([4, 5, 6]),
      cacheArchive: ".cache/rust-src.tar.br",
      source: "download",
    }));
    const written = await Deno.readFile(outputPath);
    if (written.join(",") !== "4,5,6") {
      throw new Error(`wrong asset bytes: ${written}`);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
