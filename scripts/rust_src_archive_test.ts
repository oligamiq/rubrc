import { rustWasmReleaseArchiveUrl } from "../lib/src/rust_wasm_release.ts";
import { prepareReleasedRustSrcArchive } from "./rust_src_archive.ts";
import { prepareCachedArchive } from "./sysroot_cache.ts";

function tarFixture(entries: { name: string; type?: string; text?: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = encoder.encode(entry.text ?? "fixture\n");
    const header = new Uint8Array(512);
    header.set(encoder.encode(entry.name), 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.set(encoder.encode("ustar\0"), 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    const payload = new Uint8Array(Math.ceil(data.length / 512) * 512);
    payload.set(data);
    chunks.push(header, payload);
  }
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 1024));
  let offset = 0;
  for (const chunk of chunks) { tar.set(chunk, offset); offset += chunk.length; }
  return tar;
}

async function releaseFixture(extra: { name: string; type?: string; text?: string }[] = []) {
  const tar = tarFixture([
    { name: "./Cargo.toml", text: "[workspace]\n" },
    ...["core", "alloc", "std"].map((name) => ({ name: `./${name}/src/lib.rs` })),
    ...extra,
  ]);
  return new Uint8Array(await new Response(
    new Blob([tar]).stream().pipeThrough(new CompressionStream("brotli")),
  ).arrayBuffer());
}

Deno.test("released SquashFS converts real tar, reuses validated cache and repairs corruption", async () => {
  const { prepareReleasedRustSrcSquashfs } = await import("./rust_src_archive.ts");
  const directory = await Deno.makeTempDir();
  let archive = await releaseFixture();
  let sourceCacheDir: string | undefined;
  const prepare = async (options?: { cacheDir?: string }) => {
    sourceCacheDir = options?.cacheDir;
    return { archive, source: "cache" as const, cacheArchive: "fixture.tar.br" };
  };
  try {
    const first = await prepareReleasedRustSrcSquashfs({ cacheDir: directory, prepare });
    if (sourceCacheDir !== directory) throw new Error("release source cache escaped conversion cache directory");
    if (new TextDecoder().decode(first.archive.subarray(0, 4)) !== "hsqs" || first.source !== "generated") {
      throw new Error("released tar was not converted to raw SquashFS");
    }
    const cached = await prepareReleasedRustSrcSquashfs({ cacheDir: directory, prepare });
    if (cached.source !== "cache") throw new Error("validated conversion was not cached");
    await Deno.writeFile(first.cacheArchive, new Uint8Array([9]));
    const repaired = await prepareReleasedRustSrcSquashfs({ cacheDir: directory, prepare });
    if (repaired.source !== "generated" || repaired.archive.join(",") !== first.archive.join(",")) {
      throw new Error("conversion was not deterministic or corrupt cache was reused");
    }
    archive = await releaseFixture([{ name: "extra.rs", text: "changed release input\n" }]);
    const changed = await prepareReleasedRustSrcSquashfs({ cacheDir: directory, prepare });
    if (changed.source !== "generated" || changed.archive.join(",") === first.archive.join(",")) {
      throw new Error("conversion cache ignored released tar identity");
    }
    const file = await new Deno.Command("unsquashfs", { args: ["-cat", changed.cacheArchive, "extra.rs"] }).output();
    if (!file.success || new TextDecoder().decode(file.stdout) !== "changed release input\n") {
      throw new Error("released library contents were not preserved");
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("released conversion rejects unsafe names, symlinks and hardlinks before publication", async () => {
  const { prepareReleasedRustSrcSquashfs } = await import("./rust_src_archive.ts");
  const directory = await Deno.makeTempDir();
  try {
    for (const entry of [
      { name: "../escape" }, { name: "/absolute" }, { name: "nested/../../escape" },
      { name: "link", type: "2" }, { name: "hardlink", type: "1" },
      { name: "./", type: "2" },
    ]) {
      const archive = await releaseFixture([entry]);
      let rejection: unknown;
      try {
        await prepareReleasedRustSrcSquashfs({ cacheDir: directory, prepare: async () => ({ archive, source: "cache", cacheArchive: "fixture.tar.br" }) });
      } catch (error) { rejection = error; }
      if (!(rejection instanceof Error) || !/unsafe|unsupported/.test(rejection.message)) {
        throw new Error(`unsafe entry accepted or wrong failure: ${JSON.stringify(entry)}: ${rejection}`);
      }
      for await (const entry of Deno.readDir(directory)) {
        throw new Error(`failed conversion published ${entry.name}`);
      }
    }
  } finally { await Deno.remove(directory, { recursive: true }); }
});

Deno.test("asset entrypoints and diagnostic callers use released SquashFS, not tar or host source", async () => {
  for (const path of ["scripts/prepare_rust_src_asset.ts", "scripts/prepare_rust_src_dev_asset.ts", "scripts/vfs_lsp_diagnostics_test.ts", "scripts/vfs_rust_src_cargo_metadata_test.ts"]) {
    const source = await Deno.readTextFile(path);
    if (!source.includes("prepareReleasedRustSrcSquashfs") || source.includes("prepareInstalledRustSrcArchive")) {
      throw new Error(`${path} does not use released SquashFS`);
    }
  }
  const pkg = JSON.parse(await Deno.readTextFile("package.json"));
  for (const name of ["rust-src:prepare-asset", "rust-src:prepare-dev-asset"]) {
    if (!pkg.scripts[name].includes("--allow-net") || !pkg.scripts[name].includes("--allow-run=mksquashfs,unsquashfs")) {
      throw new Error(`${name} lacks release conversion permissions`);
    }
  }
});

Deno.test("asset writer supports a flat output filename without creating a spurious directory", async () => {
  const { writeRustSrcAsset } = await import("./prepare_rust_src_asset.ts");
  const cwd = Deno.cwd();
  const directory = await Deno.makeTempDir();
  try {
    Deno.chdir(directory);
    await writeRustSrcAsset("rust-src.sqfs", async () => ({
      archive: new Uint8Array([1]), cacheArchive: "fixture", source: "generated",
    }));
    const entries = [];
    for await (const entry of Deno.readDir(".")) entries.push(entry.name);
    if (entries.join(",") !== "rust-src.sqfs") {
      throw new Error(`unexpected output entries: ${entries}`);
    }
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("released rust-src preparation uses the pinned release and validates bytes", async () => {
  const calls: unknown[] = [];
  const archive = new Uint8Array([7]);
  const result = await prepareReleasedRustSrcArchive({
    deps: {
      prepare: async (options) => {
        calls.push(options);
        return { archive, source: "download", cacheArchive: ".cache/rust-src.tar.br", url: rustWasmReleaseArchiveUrl("rust-src") };
      },
      validate: async (bytes) => bytes === archive,
      remove: async () => { throw new Error("valid archive was removed"); },
    },
  });
  if (result.archive !== archive || result.source !== "download") {
    throw new Error("released archive was not returned");
  }
  const options = calls[0] as { triple: string; url: string };
  if (options.triple !== "rust-src" || options.url !== rustWasmReleaseArchiveUrl("rust-src")) {
    throw new Error(`wrong release request: ${JSON.stringify(options)}`);
  }
});

type CommandOutput = { success: boolean; stdout: Uint8Array; stderr: Uint8Array };
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
  buildSquashfs(libraryPath: string): Promise<Uint8Array>;
  validate(archive: Uint8Array): Promise<boolean>;
};

type RustSrcArchiveModule = {
  deterministicRustSrcSquashfsArgs(source: string, output: string): string[];
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

Deno.test("rust-src SquashFS arguments fix format compression and metadata", async () => {
  const { deterministicRustSrcSquashfsArgs } = await loadModule();
  const args = deterministicRustSrcSquashfsArgs("/toolchain/library", "/tmp/rust-src.sqfs");
  const expected = [
    "/toolchain/library",
    "/tmp/rust-src.sqfs",
    "-noappend",
    "-comp",
    "zstd",
    "-Xcompression-level",
    "22",
    "-b",
    "262144",
    "-repro-time",
    "0",
    "-all-root",
    "-force-file-mode",
    "0644",
    "-force-dir-mode",
    "0755",
    "-no-xattrs",
    "-no-exports",
    "-no-progress",
    "-quiet",
    "-processors",
    "1",
  ];
  if (args.join("\n") !== expected.join("\n")) {
    throw new Error(`unexpected deterministic SquashFS arguments:\n${args.join("\n")}`);
  }
});

Deno.test("installed rust-src preparation uses deterministic toolchain archive", async () => {
  const { prepareInstalledRustSrcArchive } = await loadModule();
  const commands: string[] = [];
  let published: { archive: Uint8Array; metadata: string } | undefined;
  let cacheReads = 0;
  const result = await prepareInstalledRustSrcArchive({
    cacheArchive: ".cache/rust-src.sqfs",
    deps: {
      async run(command, args) {
        commands.push(`${command} ${args.join(" ")}`);
        return { success: true, stdout: bytes(args[0] === "--print" ? "/toolchain\n" : "rustc exact\n"), stderr: bytes("") };
      },
      async readCache() {
        cacheReads++;
        return cacheReads === 1 || published === undefined ? null : published;
      },
      async publishCache(_archivePath, _metadataPath, archive, metadata) {
        published = { archive, metadata };
      },
      async buildSquashfs(libraryPath) {
        commands.push(`build-squashfs ${libraryPath}`);
        return new Uint8Array([7]);
      },
      async validate(archive) {
        return archive[0] === 7;
      },
    },
  });
  if (result.archive[0] !== 7 || result.source !== "generated") {
    throw new Error("generated archive was not returned");
  }
  if (!commands.includes("build-squashfs /toolchain/lib/rustlib/src/rust/library")) {
    throw new Error(`SquashFS source was wrong: ${commands.join(" | ")}`);
  }
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

Deno.test("installed rust-src preparation rejects missing source", async () => {
  const { prepareInstalledRustSrcArchive } = await loadModule();
  let rejected = false;
  try {
    await prepareInstalledRustSrcArchive({
      cacheArchive: ".cache/rust-src.sqfs",
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
        async buildSquashfs() {
          throw new Error("Cannot open: No such file or directory");
        },
        async validate() {
          return false;
        },
      },
    });
  } catch (error) {
    rejected =
      error instanceof Error &&
      error.message.includes("failed to build installed rust-src SquashFS") &&
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
      cacheArchive: ".cache/rust-src.sqfs",
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
        async buildSquashfs() {
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
        source: "cache" | "download" | "generated";
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
  const outputPath = `${directory}/dist/rust-src.sqfs`;
  try {
    await assetModule.writeRustSrcAsset(outputPath, async () => ({
      archive: new Uint8Array([4, 5, 6]),
      cacheArchive: ".cache/rust-src.sqfs",
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
