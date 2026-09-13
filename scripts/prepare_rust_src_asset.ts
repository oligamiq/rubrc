import { dirname } from "node:path";
import { prepareReleasedRustSrcArchive, prepareReleasedRustSrcSquashfs } from "./rust_src_archive.ts";

type PrepareRustSrcArchive = () => Promise<{
  archive: Uint8Array;
  cacheArchive: string;
  source: "cache" | "download" | "generated";
}>;

export async function writeRustSrcAsset(
  outputPath = "page/dist/rust-src.sqfs",
  prepare: PrepareRustSrcArchive = outputPath.endsWith(".tar.vfsbr")
    ? prepareReleasedRustSrcArchive
    : prepareReleasedRustSrcSquashfs,
): Promise<void> {
  const { archive } = await prepare();
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  await Deno.writeFile(outputPath, archive);
}

if (import.meta.main) {
  const outputPath = Deno.args[0] ?? "page/dist/rust-src.sqfs";
  await writeRustSrcAsset(outputPath);
  console.log(`wrote validated rust-src asset to ${outputPath}`);
}
