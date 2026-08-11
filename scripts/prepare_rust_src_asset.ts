import { prepareInstalledRustSrcArchive } from "./rust_src_archive.ts";

type PrepareRustSrcArchive = () => Promise<{
  archive: Uint8Array;
  cacheArchive: string;
  source: "cache" | "generated";
}>;

export async function writeRustSrcAsset(
  outputPath = "page/dist/rust-src.tar.vfsbr",
  prepare: PrepareRustSrcArchive = prepareInstalledRustSrcArchive,
): Promise<void> {
  const { archive } = await prepare();
  const parent = outputPath.slice(0, outputPath.lastIndexOf("/"));
  if (parent) await Deno.mkdir(parent, { recursive: true });
  await Deno.writeFile(outputPath, archive);
}

if (import.meta.main) {
  const outputPath = Deno.args[0] ?? "page/dist/rust-src.tar.vfsbr";
  await writeRustSrcAsset(outputPath);
  console.log(`wrote validated rust-src asset to ${outputPath}`);
}
