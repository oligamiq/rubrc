import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { fromFileUrl, join } from "jsr:@std/path";

const root = fromFileUrl(new URL("../", import.meta.url));

Deno.test("copy_vfs_bindings preserves an unpatched upstream installation", async () => {
  const tempRoot = await Deno.makeTempDir();
  try {
    const sourceDir = join(tempRoot, "dist");
    const targetDir = join(tempRoot, "page/src/worker_process/vfs_bindings");
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.mkdir(join(targetDir, "patches"), { recursive: true });
    await Deno.writeTextFile(
      join(sourceDir, "vfs.js"),
      "export const generated = true;\n",
    );
    await Deno.writeTextFile(
      join(targetDir, "patches", "must-be-deleted"),
      "local patch state",
    );
    await Deno.copyFile(
      join(root, "page/src/worker_process/vfs_bindings/package.json"),
      join(targetDir, "package.json"),
    );
    await Deno.copyFile(
      join(root, "page/src/worker_process/vfs_bindings/bun.lock"),
      join(targetDir, "bun.lock"),
    );

    const copy = await new Deno.Command("node", {
      args: [join(root, "scripts/copy_vfs_bindings.mjs")],
      env: {
        VFS_BINDINGS_SOURCE_DIR: sourceDir,
        VFS_BINDINGS_TARGET_DIR: targetDir,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(copy.success, new TextDecoder().decode(copy.stderr));

    const manifest = JSON.parse(
      await Deno.readTextFile(join(targetDir, "package.json")),
    );
    assertEquals(
      manifest.dependencies["@oligami/browser_wasi_shim-threads"],
      "0.5.0",
    );
    assertEquals(manifest.patchedDependencies, undefined);

    const install = await new Deno.Command("bun", {
      args: [
        "install",
        "--cwd",
        targetDir,
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(install.success, new TextDecoder().decode(install.stderr));

    const installed = join(
      targetDir,
      "node_modules/@oligami/browser_wasi_shim-threads",
    );
    const copiedSource = await Deno.readTextFile(
      join(installed, "src/destroyer_handle.ts"),
    );
    const rootSource = await Deno.readTextFile(
      join(
        root,
        "node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.ts",
      ),
    );
    assertEquals(copiedSource, rootSource);
    assertEquals(
      await Deno.readTextFile(
        join(installed, "dist/browser-wasi-shim-threads.es.js"),
      ),
      await Deno.readTextFile(
        join(
          root,
          "node_modules/@oligami/browser_wasi_shim-threads/dist/browser-wasi-shim-threads.es.js",
        ),
      ),
    );
    assertStringIncludes(
      await Deno.readTextFile(join(installed, "dist/index.d.ts")),
      "DestroyerHandleObject",
    );
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});
