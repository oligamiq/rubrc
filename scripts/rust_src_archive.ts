import {
  createRustSrcCacheMetadata,
  deterministicRustSrcTarArgs,
  rustSrcCacheMatchesMetadata,
  rustSrcToolchainIdentity,
  validateRustSrcArchive,
} from "./sysroot_cache.ts";

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
  compress(data: Uint8Array): Promise<Uint8Array>;
  validate(archive: Uint8Array): Promise<boolean>;
};

type RustSrcArchiveOptions = {
  cacheArchive?: string;
  deps?: RustSrcArchiveDeps;
};

const DEFAULT_CACHE_ARCHIVE = ".rubrc-cache/sysroot/rust-src.tar.br";
const decoder = new TextDecoder();

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
  const tar = await deps.run("tar", deterministicRustSrcTarArgs(libraryPath));
  if (!tar.success) {
    throw new Error(
      `failed to archive installed rust-src at ${libraryPath}: ${decoder
        .decode(tar.stderr)
        .trim()}`,
    );
  }
  const archive = await deps.compress(tar.stdout);
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
  async compress(data) {
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    return new Uint8Array(
      await new Response(
        new Blob([buffer])
          .stream()
          .pipeThrough(new CompressionStream("brotli")),
      ).arrayBuffer(),
    );
  },
  validate: validateRustSrcArchive,
};
