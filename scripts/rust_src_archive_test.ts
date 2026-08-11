type CommandOutput = {
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type RustSrcArchiveDeps = {
  run(command: string, args: string[]): Promise<CommandOutput>;
  readCache(
    archivePath: string,
    metadataPath: string,
  ): Promise<{ archive: Uint8Array; metadata: string } | null>;
  publishCache(
    archivePath: string,
    metadataPath: string,
    archive: Uint8Array,
    metadata: string,
  ): Promise<void>;
  compress(data: Uint8Array): Promise<Uint8Array>;
  validate(archive: Uint8Array): Promise<boolean>;
};

type RustSrcArchiveModule = {
  prepareInstalledRustSrcArchive(options: {
    cacheArchive: string;
    deps: RustSrcArchiveDeps;
  }): Promise<{
    archive: Uint8Array;
    cacheArchive: string;
    source: "cache" | "generated";
  }>;
};

async function loadModule(): Promise<RustSrcArchiveModule> {
  try {
    return (await import("./rust_src_archive.ts")) as RustSrcArchiveModule;
  } catch (error) {
    throw new Error("installed rust-src archive module is missing", {
      cause: error,
    });
  }
}

const bytes = (value: string) => new TextEncoder().encode(value);

Deno.test("installed rust-src preparation uses deterministic toolchain archive", async () => {
  const { prepareInstalledRustSrcArchive } = await loadModule();
  const commands: string[] = [];
  let published: { archive: Uint8Array; metadata: string } | undefined;
  let cacheReads = 0;
  const result = await prepareInstalledRustSrcArchive({
    cacheArchive: ".cache/rust-src.tar.br",
    deps: {
      async run(command, args) {
        commands.push(`${command} ${args.join(" ")}`);
        if (command === "rustc" && args[0] === "--print") {
          return {
            success: true,
            stdout: bytes("/toolchain\n"),
            stderr: bytes(""),
          };
        }
        if (command === "rustc") {
          return {
            success: true,
            stdout: bytes("rustc exact\n"),
            stderr: bytes(""),
          };
        }
        return {
          success: true,
          stdout: new Uint8Array([1, 2]),
          stderr: bytes(""),
        };
      },
      async readCache() {
        cacheReads++;
        return cacheReads === 1 || published === undefined ? null : published;
      },
      async publishCache(_archivePath, _metadataPath, archive, metadata) {
        published = { archive, metadata };
      },
      async compress() {
        return new Uint8Array([7]);
      },
      async validate(archive) {
        return archive[0] === 7;
      },
    },
  });

  if (result.source !== "generated" || result.archive[0] !== 7) {
    throw new Error("generated archive was not returned");
  }
  const tar = commands.find((command) => command.startsWith("tar "));
  if (
    !tar?.includes("--sort=name") ||
    !tar.includes("--mtime=@0") ||
    !tar.includes("--directory /toolchain/lib/rustlib/src/rust/library")
  ) {
    throw new Error(`tar invocation was not deterministic: ${tar}`);
  }
});

Deno.test("installed rust-src preparation rejects missing source", async () => {
  const { prepareInstalledRustSrcArchive } = await loadModule();
  let rejected = false;
  try {
    await prepareInstalledRustSrcArchive({
      cacheArchive: ".cache/rust-src.tar.br",
      deps: {
        async run(command, args) {
          if (command === "rustc" && args[0] === "--print") {
            return {
              success: true,
              stdout: bytes("/missing\n"),
              stderr: bytes(""),
            };
          }
          if (command === "rustc") {
            return {
              success: true,
              stdout: bytes("rustc exact\n"),
              stderr: bytes(""),
            };
          }
          return {
            success: false,
            stdout: bytes(""),
            stderr: bytes("Cannot open: No such file or directory"),
          };
        },
        async readCache() {
          return null;
        },
        async publishCache() {
          throw new Error("missing source must not be published");
        },
        async compress() {
          throw new Error("missing source must not be compressed");
        },
        async validate() {
          return false;
        },
      },
    });
  } catch (error) {
    rejected =
      error instanceof Error &&
      error.message.includes("failed to archive installed rust-src") &&
      error.message.includes("/missing/lib/rustlib/src/rust/library");
  }
  if (!rejected) throw new Error("missing installed rust-src was accepted");
});

Deno.test("installed rust-src preparation rejects invalid generated archive", async () => {
  const { prepareInstalledRustSrcArchive } = await loadModule();
  let published = false;
  let rejected = false;
  try {
    await prepareInstalledRustSrcArchive({
      cacheArchive: ".cache/rust-src.tar.br",
      deps: {
        async run(command, args) {
          if (command === "rustc" && args[0] === "--print") {
            return {
              success: true,
              stdout: bytes("/toolchain\n"),
              stderr: bytes(""),
            };
          }
          if (command === "rustc") {
            return {
              success: true,
              stdout: bytes("rustc exact\n"),
              stderr: bytes(""),
            };
          }
          return {
            success: true,
            stdout: new Uint8Array([1]),
            stderr: bytes(""),
          };
        },
        async readCache() {
          return null;
        },
        async publishCache() {
          published = true;
        },
        async compress() {
          return new Uint8Array([9]);
        },
        async validate() {
          return false;
        },
      },
    });
  } catch (error) {
    rejected =
      error instanceof Error &&
      error.message.includes("generated installed rust-src archive is invalid");
  }
  if (!rejected || published) {
    throw new Error("invalid installed rust-src was accepted or published");
  }
});

Deno.test("rust-src asset command writes validated bytes into dist", async () => {
  let assetModule: {
    writeRustSrcAsset?: (
      outputPath: string,
      prepare: () => Promise<{
        archive: Uint8Array;
        cacheArchive: string;
        source: "cache" | "generated";
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
      source: "cache",
    }));
    const written = await Deno.readFile(outputPath);
    if (written.join(",") !== "4,5,6") {
      throw new Error(`wrong asset bytes: ${written}`);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
