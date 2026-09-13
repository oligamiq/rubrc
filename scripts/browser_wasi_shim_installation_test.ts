import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "../node_modules/vite/dist/node/index.js";

const root = new URL("../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("threaded WASI shim uses unpatched upstream 0.5.0 in every root", async () => {
  for (
    const path of [
      "package.json",
      "page/package.json",
      "lib/package.json",
      "page/src/worker_process/vfs_bindings/package.json",
    ]
  ) {
    const manifest = JSON.parse(await read(path));
    assertEquals(
      manifest.dependencies["@oligami/browser_wasi_shim-threads"],
      "0.5.0",
    );
    assert(
      !Object.keys(manifest.patchedDependencies ?? {}).some((name) =>
        name.startsWith("@oligami/browser_wasi_shim-threads@")
      ),
    );
  }
  for (const base of ["", "page/src/worker_process/vfs_bindings/"]) {
    assertEquals(
      JSON.parse(
        await read(
          `${base}node_modules/@oligami/browser_wasi_shim-threads/package.json`,
        ),
      ).version,
      "0.5.0",
    );
    const source = await read(
      `${base}node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.ts`,
    );
    assertStringIncludes(source, "WorkerBackgroundRef.init_self(obj.sender)");
    assertStringIncludes(source, "sender: this.sender.get_object()");
    assertStringIncludes(source, "async_destroy()");
    assertStringIncludes(
      await read(
        `${base}node_modules/@oligami/browser_wasi_shim-threads/dist/index.d.ts`,
      ),
      "DestroyerHandleObject",
    );
  }

  await assertRejects(
    () =>
      Deno.stat(
        new URL(
          "patches/@oligami%252Fbrowser_wasi_shim-threads@0.4.1.patch",
          root,
        ),
      ),
    Deno.errors.NotFound,
  );
  await assertRejects(() =>
    Deno.stat(new URL("page/src/worker_process/vfs_bindings/patches/", root))
  );

  for (
    const path of [
      "package-lock.json",
      "page/package-lock.json",
      "lib/package-lock.json",
    ]
  ) {
    const lock = JSON.parse(await read(path));
    assertEquals(
      lock.packages["node_modules/@oligami/browser_wasi_shim-threads"]?.version,
      "0.5.0",
      `${path} resolves the wrong threaded WASI shim version`,
    );
    for (
      const entry of Object.values(lock.packages) as Array<
        { dependencies?: Record<string, string> }
      >
    ) {
      const spec = entry.dependencies?.["@oligami/browser_wasi_shim-threads"];
      if (spec !== undefined) {
        assertEquals(
          spec,
          "0.5.0",
          `${path} contains a stale dependency snapshot`,
        );
      }
    }
  }
});

Deno.test("Vite retains worker dependency optimization exclusions", async () => {
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "test" },
    fileURLToPath(new URL("../page/vite.config.ts", import.meta.url)),
    fileURLToPath(root),
  );

  assert(loaded !== null);
  const excluded = loaded.config.optimizeDeps?.exclude ?? [];
  assert(
    excluded.includes("@oligami/browser_wasi_shim-threads"),
  );
  assert(
    excluded.includes(
      "@oligami/browser_wasi_shim-threads/worker_background_worker",
    ),
  );
});
