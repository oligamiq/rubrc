import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error(
    "Usage: prepare_std_cache_asset.ts <generated-cache> <output-directory>",
  );
}
const bytes = await readFile(input);
const hash = createHash("sha256").update(bytes).digest("hex");
await mkdir(output, { recursive: true });
// Match the existing VFS asset limit for static-host deployments.
const partSize = 24 * 1024 * 1024;
const parts = [];
for (let offset = 0; offset < bytes.length; offset += partSize) {
  const part = bytes.subarray(offset, offset + partSize);
  const file = `std-${hash}.salsa.part-${
    String(parts.length).padStart(3, "0")
  }`;
  await writeFile(join(output, file), part);
  parts.push({ file, size: part.length });
}
await writeFile(
  join(output, "std-cache.json"),
  JSON.stringify({ version: 1, hash, size: bytes.length, parts }),
);
console.log(
  `Prepared std cache ${hash} (${bytes.byteLength} bytes, ${parts.length} parts)`,
);
