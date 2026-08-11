import { prepareInstalledRustSrcArchive } from "./rust_src_archive.ts";

export const DEV_RUST_SRC_DIRECTORY = ".rubrc-cache/dev";
export const DEV_RUST_SRC_SIDECAR = `${DEV_RUST_SRC_DIRECTORY}/rust-src.sha256`;
export const DEV_RUST_SRC_RETAINED_ASSETS = 3;
export const DEV_RUST_SRC_TMP_MAX_AGE_MS = 60 * 60 * 1_000;

export type DevelopmentRustSrcPruneDependencies = {
  readDir(path: string): AsyncIterable<Deno.DirEntry>;
  stat(path: string): Promise<Deno.FileInfo>;
  remove(path: string): Promise<void>;
  now(): number;
};

const defaultPruneDependencies: DevelopmentRustSrcPruneDependencies = {
  readDir: (path) => Deno.readDir(path),
  stat: (path) => Deno.stat(path),
  remove: (path) => Deno.remove(path),
  now: () => Date.now(),
};

async function statIfPresent(
  path: string,
  dependencies: DevelopmentRustSrcPruneDependencies,
): Promise<Deno.FileInfo | null> {
  try {
    return await dependencies.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function removeIfPresent(
  path: string,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  try {
    await remove(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

export async function pruneDevelopmentRustSrcAssets(
  directory: string,
  activeSha256: string,
  dependencies: DevelopmentRustSrcPruneDependencies = defaultPruneDependencies,
): Promise<void> {
  const priorArchives: Array<{ path: string; mtime: number }> = [];
  for await (const entry of dependencies.readDir(directory)) {
    if (!entry.isFile) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.name.endsWith(".tmp")) {
      const stat = await statIfPresent(path, dependencies);
      const mtime = stat?.mtime?.getTime() ?? stat?.birthtime?.getTime();
      if (
        mtime !== undefined &&
        dependencies.now() - mtime > DEV_RUST_SRC_TMP_MAX_AGE_MS
      ) {
        await removeIfPresent(path, dependencies.remove);
      }
      continue;
    }

    const match = /^rust-src-([a-f0-9]{64})\.tar\.vfsbr$/.exec(entry.name);
    if (!match || match[1] === activeSha256) continue;
    const stat = await statIfPresent(path, dependencies);
    if (stat === null) continue;
    priorArchives.push({ path, mtime: stat.mtime?.getTime() ?? 0 });
  }

  priorArchives.sort(
    (left, right) =>
      right.mtime - left.mtime || right.path.localeCompare(left.path),
  );
  for (const candidate of priorArchives.slice(
    DEV_RUST_SRC_RETAINED_ASSETS - 1,
  )) {
    await removeIfPresent(candidate.path, dependencies.remove);
  }
}

async function validateAssetDestination(path: string): Promise<void> {
  const stat = await statIfPresent(path, defaultPruneDependencies);
  if (stat !== null && !stat.isFile) {
    throw new Error(
      `development rust-src destination is not a regular file: ${path}`,
    );
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function writeRustSrcDevAsset(
  directory = DEV_RUST_SRC_DIRECTORY,
  prepare = prepareInstalledRustSrcArchive,
): Promise<string> {
  const { archive } = await prepare();
  const digest = await crypto.subtle.digest("SHA-256", archive as BufferSource);
  const sha256 = bytesToHex(new Uint8Array(digest));
  const assetPath = `${directory}/rust-src-${sha256}.tar.vfsbr`;
  const sidecarPath = `${directory}/rust-src.sha256`;
  const temporaryAsset = `${assetPath}.${crypto.randomUUID()}.tmp`;
  const temporarySidecar = `${sidecarPath}.${crypto.randomUUID()}.tmp`;

  await Deno.mkdir(directory, { recursive: true });
  try {
    await Deno.writeFile(temporaryAsset, archive);
    await validateAssetDestination(assetPath);
    await Deno.rename(temporaryAsset, assetPath);
    await Deno.writeTextFile(temporarySidecar, `${sha256}\n`);
    await Deno.rename(temporarySidecar, sidecarPath);
    await pruneDevelopmentRustSrcAssets(directory, sha256);
  } catch (error) {
    const cleanup = await Promise.allSettled([
      removeIfPresent(temporaryAsset, Deno.remove),
      removeIfPresent(temporarySidecar, Deno.remove),
    ]);
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "development rust-src preparation and cleanup failed",
      );
    }
    throw error;
  }

  return sha256;
}

if (import.meta.main) {
  const sha256 = await writeRustSrcDevAsset();
  console.log(`prepared validated rust-src development asset ${sha256}`);
}
