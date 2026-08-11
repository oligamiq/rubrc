import { prepareInstalledRustSrcArchive } from "./rust_src_archive.ts";

export const DEV_RUST_SRC_DIRECTORY = ".rubrc-cache/dev";
export const DEV_RUST_SRC_SIDECAR = `${DEV_RUST_SRC_DIRECTORY}/rust-src.sha256`;
export const DEV_RUST_SRC_RETAINED_ASSETS = 3;

async function pruneDevelopmentRustSrcAssets(
  directory: string,
  activeSha256: string,
): Promise<void> {
  const candidates: Array<{ path: string; active: boolean; mtime: number }> =
    [];
  for await (const entry of Deno.readDir(directory)) {
    const match = /^rust-src-([a-f0-9]{64})\.tar\.vfsbr$/.exec(entry.name);
    if (!entry.isFile || !match) continue;
    const path = `${directory}/${entry.name}`;
    const stat = await Deno.stat(path);
    candidates.push({
      path,
      active: match[1] === activeSha256,
      mtime: stat.mtime?.getTime() ?? 0,
    });
  }
  candidates.sort(
    (left, right) =>
      Number(right.active) - Number(left.active) || right.mtime - left.mtime,
  );
  await Promise.all(
    candidates
      .slice(DEV_RUST_SRC_RETAINED_ASSETS)
      .map((candidate) => Deno.remove(candidate.path).catch(() => undefined)),
  );
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
    await Deno.rename(temporaryAsset, assetPath).catch(async (error) => {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      await Deno.remove(temporaryAsset);
    });
    await Deno.writeTextFile(temporarySidecar, `${sha256}\n`);
    await Deno.rename(temporarySidecar, sidecarPath);
    await pruneDevelopmentRustSrcAssets(directory, sha256);
  } catch (error) {
    await Promise.all([
      Deno.remove(temporaryAsset).catch(() => undefined),
      Deno.remove(temporarySidecar).catch(() => undefined),
    ]);
    throw error;
  }

  return sha256;
}

if (import.meta.main) {
  const sha256 = await writeRustSrcDevAsset();
  console.log(`prepared validated rust-src development asset ${sha256}`);
}
