import {
  RUST_WASM_RELEASE_VERSION,
  rustWasmReleaseArchiveUrl,
} from "../lib/src/rust_wasm_release.ts";
import { parseTar } from "../lib/src/parse_tar.ts";
import {
  prepareCachedArchive,
  type SysrootCacheSource,
  validateRustSrcArchive,
  validateTarEntryName,
} from "./sysroot_cache.ts";

import {
  createRustSrcCacheMetadata,
  deterministicRustSrcSquashfsArgs,
  rustSrcCacheMatchesMetadata,
  rustSrcToolchainIdentity,
} from "./sysroot_cache.ts";

export { deterministicRustSrcSquashfsArgs } from "./sysroot_cache.ts";

type CommandOutput = {
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

export type RustSrcArchiveDeps = {
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

type RustSrcArchiveOptions = {
  cacheArchive?: string;
  deps?: RustSrcArchiveDeps;
};

const DEFAULT_CACHE_ARCHIVE = ".rubrc-cache/sysroot/rust-src.sqfs";
const decoder = new TextDecoder();
const REQUIRED_SQUASHFS_SENTINELS = [
  "Cargo.toml",
  "core/src/lib.rs",
  "alloc/src/lib.rs",
  "std/src/lib.rs",
] as const;

async function commandText(
  deps: RustSrcArchiveDeps,
  command: string,
  args: string[],
  failure: string,
): Promise<string> {
  const output = await deps.run(command, args);
  if (!output.success) {
    throw new Error(`${failure}: ${decoder.decode(output.stderr).trim()}`);
  }
  return decoder.decode(output.stdout).trim();
}

type PreparedArchive = {
  archive: Uint8Array;
  source: SysrootCacheSource;
  cacheArchive: string;
  url: string;
};

const DEFAULT_RELEASED_RUST_SRC_CACHE_DIR =
  `.rubrc-cache/sysroot/rust_wasm/${RUST_WASM_RELEASE_VERSION}`;

export type ReleasedRustSrcArchiveDeps = {
  prepare(options: {
    triple: string;
    cacheDir?: string;
    url: string;
  }): Promise<PreparedArchive>;
  validate(archive: Uint8Array): Promise<boolean>;
  remove(path: string): Promise<void>;
};

export type ReleasedRustSrcArchiveOptions = {
  cacheDir?: string;
  deps?: ReleasedRustSrcArchiveDeps;
};

const defaultDeps: ReleasedRustSrcArchiveDeps = {
  prepare: (options) => prepareCachedArchive(options),
  validate: validateRustSrcArchive,
  remove: async (path) => {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
};

export async function prepareReleasedRustSrcArchive(
  options: ReleasedRustSrcArchiveOptions = {},
): Promise<Omit<PreparedArchive, "url">> {
  const deps = options.deps ?? defaultDeps;
  const prepared = await deps.prepare({
    triple: "rust-src",
    cacheDir: options.cacheDir ?? DEFAULT_RELEASED_RUST_SRC_CACHE_DIR,
    url: rustWasmReleaseArchiveUrl("rust-src"),
  });
  if (!(await deps.validate(prepared.archive))) {
    await deps.remove(prepared.cacheArchive);
    throw new Error("released rust-src archive is invalid");
  }
  return {
    archive: prepared.archive,
    cacheArchive: prepared.cacheArchive,
    source: prepared.source,
  };
}

export async function prepareReleasedRustSrcSquashfs(
  options: {
    cacheDir?: string;
    prepare?: (options: ReleasedRustSrcArchiveOptions) => Promise<Omit<PreparedArchive, "url">>;
  } = {},
): Promise<{
  archive: Uint8Array;
  cacheArchive: string;
  source: "cache" | "generated";
}> {
  const released = await (options.prepare ?? prepareReleasedRustSrcArchive)({
    cacheDir: options.cacheDir,
  });
  const cacheArchive = `${options.cacheDir ?? DEFAULT_RELEASED_RUST_SRC_CACHE_DIR}/rust-src.sqfs`;
  const metadataPath = `${cacheArchive}.identity`;
  // Bind the conversion to both the release bytes and the image format recipe.
  const identity = await createRustSrcCacheMetadata(
    `${rustWasmReleaseArchiveUrl("rust-src")}:squashfs-v1`,
    released.archive,
  );
  const deps = denoRustSrcArchiveDeps;
  const cached = await deps.readCache(cacheArchive, metadataPath);
  if (
    cached !== null &&
    await rustSrcCacheMatchesMetadata(identity, cached.archive, cached.metadata) &&
    await deps.validate(cached.archive)
  ) {
    return { archive: cached.archive, cacheArchive, source: "cache" };
  }

  const entries: Array<{ name: string; type: string; data: Uint8Array }> = [];
  await parseTar(
    new Blob([new Uint8Array(released.archive)]).stream().pipeThrough(
      new DecompressionStream("brotli"),
    ),
    (file) => {
      const name = validateTarEntryName(file.name);
      if (file.type !== "file" && file.type !== "directory") {
        throw new Error(`unsupported released rust-src entry: ${file.name} (${file.type})`);
      }
      if (name === null) {
        if (file.type !== "directory") throw new Error(`unsafe rust-src entry: ${file.name}`);
        return;
      }
      entries.push({ name, type: file.type, data: file.data ?? new Uint8Array() });
    },
  );
  const directory = await Deno.makeTempDir({ prefix: "rubrc-released-rust-src-" });
  try {
    // Only regular files/directories reach this private tree; never follow archive links.
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.type === "directory") {
        await Deno.mkdir(path, { recursive: true });
      } else {
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
        await Deno.writeFile(path, entry.data);
      }
    }
    const archive = await deps.buildSquashfs(directory);
    if (!(await deps.validate(archive))) {
      throw new Error("generated released rust-src SquashFS is invalid");
    }
    const metadata = await createRustSrcCacheMetadata(identity, archive);
    await deps.publishCache(cacheArchive, metadataPath, archive, metadata);
    const published = await deps.readCache(cacheArchive, metadataPath);
    if (
      published === null ||
      !(await rustSrcCacheMatchesMetadata(identity, published.archive, published.metadata)) ||
      !(await deps.validate(published.archive))
    ) {
      throw new Error("published released rust-src cache does not match validated metadata");
    }
    return { archive: published.archive, cacheArchive, source: "generated" };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

export async function prepareInstalledRustSrcArchive(
  options: RustSrcArchiveOptions = {},
): Promise<{
  archive: Uint8Array;
  cacheArchive: string;
  source: "cache" | "generated";
}> {
  const deps = options.deps ?? denoRustSrcArchiveDeps;
  const cacheArchive = options.cacheArchive ?? DEFAULT_CACHE_ARCHIVE;
  const cacheMetadata = `${cacheArchive}.identity`;
  const sysroot = await commandText(
    deps,
    "rustc",
    ["--print", "sysroot"],
    "failed to locate installed Rust sysroot",
  );
  const identity = rustSrcToolchainIdentity(
    await commandText(
      deps,
      "rustc",
      ["-vV"],
      "failed to identify installed Rust toolchain",
    ),
    sysroot,
  );

  const cached = await deps.readCache(cacheArchive, cacheMetadata);
  if (
    cached !== null &&
    (await rustSrcCacheMatchesMetadata(
      identity,
      cached.archive,
      cached.metadata,
    )) &&
    (await deps.validate(cached.archive))
  ) {
    return { archive: cached.archive, cacheArchive, source: "cache" };
  }

  const libraryPath = `${sysroot}/lib/rustlib/src/rust/library`;
  let archive: Uint8Array;
  try {
    archive = await deps.buildSquashfs(libraryPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to build installed rust-src SquashFS at ${libraryPath}: ${detail}`,
      { cause: error },
    );
  }
  if (!(await deps.validate(archive))) {
    throw new Error("generated installed rust-src archive is invalid");
  }

  const metadata = await createRustSrcCacheMetadata(identity, archive);
  await deps.publishCache(cacheArchive, cacheMetadata, archive, metadata);

  const published = await deps.readCache(cacheArchive, cacheMetadata);
  if (
    published === null ||
    !(await rustSrcCacheMatchesMetadata(
      identity,
      published.archive,
      published.metadata,
    )) ||
    !(await deps.validate(published.archive))
  ) {
    throw new Error(
      "published rust-src cache bytes do not match validated metadata",
    );
  }
  return { archive: published.archive, cacheArchive, source: "generated" };
}

const denoRustSrcArchiveDeps: RustSrcArchiveDeps = {
  async run(command, args) {
    return await new Deno.Command(command, { args }).output();
  },
  async readCache(archivePath, metadataPath) {
    try {
      const [archive, metadata] = await Promise.all([
        Deno.readFile(archivePath),
        Deno.readTextFile(metadataPath),
      ]);
      return { archive, metadata };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  },
  async publishCache(archivePath, metadataPath, archive, metadata) {
    const parent = archivePath.slice(0, archivePath.lastIndexOf("/"));
    if (parent) await Deno.mkdir(parent, { recursive: true });
    const suffix = `${crypto.randomUUID()}.tmp`;
    const temporaryArchive = `${archivePath}.${suffix}`;
    const temporaryMetadata = `${metadataPath}.${suffix}`;
    try {
      await Deno.writeFile(temporaryArchive, archive);
      await Deno.writeTextFile(temporaryMetadata, metadata);
      await Deno.rename(temporaryArchive, archivePath);
      await Deno.rename(temporaryMetadata, metadataPath);
    } finally {
      await Promise.all([
        Deno.remove(temporaryArchive).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }),
        Deno.remove(temporaryMetadata).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }),
      ]);
    }
  },
  async buildSquashfs(libraryPath) {
    const directory = await Deno.makeTempDir({ prefix: "rubrc-rust-src-" });
    const outputPath = `${directory}/rust-src.sqfs`;
    try {
      const output = await new Deno.Command("mksquashfs", {
        args: deterministicRustSrcSquashfsArgs(libraryPath, outputPath),
      }).output();
      if (!output.success) {
        throw new Error(decoder.decode(output.stderr).trim() || "mksquashfs failed");
      }
      return await Deno.readFile(outputPath);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  },
  validate: validateInstalledRustSrcSquashfs,
};

async function validateInstalledRustSrcSquashfs(archive: Uint8Array): Promise<boolean> {
  const directory = await Deno.makeTempDir({ prefix: "rubrc-rust-src-validate-" });
  const archivePath = `${directory}/rust-src.sqfs`;
  try {
    await Deno.writeFile(archivePath, archive);
    const stat = await new Deno.Command("unsquashfs", {
      args: ["-stat", archivePath],
    }).output();
    if (!stat.success) return false;
    const description = decoder.decode(stat.stdout);
    if (
      !description.includes("valid SQUASHFS 4:0 superblock") ||
      !description.includes("Compression zstd") ||
      !description.includes("compression-level 22") ||
      !description.includes("Block size 262144")
    ) {
      return false;
    }
    for (const path of REQUIRED_SQUASHFS_SENTINELS) {
      const file = await new Deno.Command("unsquashfs", {
        args: ["-cat", archivePath, path],
      }).output();
      if (!file.success || file.stdout.byteLength === 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await Deno.remove(directory, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}
