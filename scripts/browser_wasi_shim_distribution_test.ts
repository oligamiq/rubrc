import { assert, assertEquals } from "jsr:@std/assert";
import { parseTar } from "../lib/src/parse_tar.ts";

Deno.test("both installed WASI shim distributions match the published npm archive", async () => {
  const response = await fetch(
    "https://registry.npmjs.org/@oligami%2Fbrowser_wasi_shim-threads/0.5.0",
  );
  assert(response.ok, `registry metadata returned ${response.status}`);
  const metadata = await response.json();
  assertEquals(metadata.version, "0.5.0");
  const download = await fetch(metadata.dist.tarball);
  assert(download.ok, `registry tarball returned ${download.status}`);
  const archive = await download.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", archive));
  assertEquals(
    `sha512-${btoa(String.fromCharCode(...digest))}`,
    metadata.dist.integrity,
  );
  const files = new Map<string, Uint8Array>();
  await parseTar(
    new Blob([archive]).stream().pipeThrough(new DecompressionStream("gzip")),
    (file) => {
      if (file.type === "directory") return;
      assert(
        file.type === "file" && file.name.startsWith("package/") &&
          !file.name.split("/").includes(".."),
      );
      files.set(
        file.name.slice("package/".length),
        file.data ?? new Uint8Array(),
      );
    },
  );
  assert(files.size > 0);
  for (
    const base of [
      "node_modules/",
      "page/src/worker_process/vfs_bindings/node_modules/",
    ]
  ) {
    const installed = new URL(
      `../${base}@oligami/browser_wasi_shim-threads/`,
      import.meta.url,
    );
    for (const [name, expected] of files) {
      assertEquals(
        await Deno.readFile(new URL(name, installed)),
        expected,
        `${base}${name} differs from npm`,
      );
    }
  }
});
