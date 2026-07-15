import packageJson from "../package.json" with { type: "json" };

const wvlCliPrefix = "wasi_virt_layer build ";
const copyScriptCommand = "node scripts/copy_vfs_bindings.mjs";

Deno.test("vfs build scripts use the installed wasi_virt_layer CLI", () => {
  for (const scriptName of ["vfs:build", "vfs:build-debug"] as const) {
    const script = packageJson.scripts[scriptName];

    if (!script.startsWith(wvlCliPrefix)) {
      throw new Error(
        `${scriptName} must start with ${wvlCliPrefix}, got: ${script}`,
      );
    }

    if (script.includes("../wasi_virt_layer")) {
      throw new Error(
        `${scriptName} must not require a sibling wasi_virt_layer checkout`,
      );
    }

    if (script.includes("cargo run") || script.includes("--manifest-path")) {
      throw new Error(`${scriptName} must not shell out through cargo run`);
    }

    if (script.includes("node -e")) {
      throw new Error(
        `${scriptName} must use a maintainable copy script, not inline node -e`,
      );
    }

    if (!script.includes(copyScriptCommand)) {
      throw new Error(
        `${scriptName} must copy bindings with ${copyScriptCommand}`,
      );
    }

    if (
      script.includes(
        "git restore page/src/worker_process/vfs_bindings/inst.ts",
      )
    ) {
      throw new Error(
        `${scriptName} must preserve inst.ts without git restore`,
      );
    }
  }
});

Deno.test("vfs copy script preserves local binding overrides and lockfile", () => {
  const copyScriptPath = new URL("./copy_vfs_bindings.mjs", import.meta.url);
  try {
    if (!Deno.statSync(copyScriptPath).isFile) {
      throw new Error("copy script must exist");
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error("copy script must exist");
    }
    throw error;
  }

  const copyScript = Deno.readTextFileSync(copyScriptPath);
  for (
    const fileName of [
      "inst.ts",
      "http_import.ts",
      "child_process_import.ts",
      "child_process_worker.ts",
      "bun.lock",
    ] as const
  ) {
    if (!copyScript.includes(fileName)) {
      throw new Error(`copy script must preserve ${fileName}`);
    }
  }
});

Deno.test("vfs copy script normalizes generated JS and preserves authored overlays", () => {
  const copyScriptPath = new URL("./copy_vfs_bindings.mjs", import.meta.url);
  const copyScript = Deno.readTextFileSync(copyScriptPath);
  if (
    !copyScript.includes("VFS_BINDINGS_SOURCE_DIR") ||
    !copyScript.includes("VFS_BINDINGS_TARGET_DIR")
  ) {
    throw new Error("copy script must support explicit source and target dirs");
  }

  const tempDir = Deno.makeTempDirSync();
  try {
    const sourceDir = `${tempDir}/dist`;
    const targetDir = `${tempDir}/vfs_bindings`;
    Deno.mkdirSync(sourceDir);
    Deno.mkdirSync(targetDir);
    Deno.writeTextFileSync(
      `${sourceDir}/vfs.js`,
      "generated vfs  \nconst tab = true;\t\r\nconst inside = 'keep  spaces';\n",
    );
    Deno.writeTextFileSync(`${sourceDir}/other.js`, "other generated  \n");
    Deno.writeTextFileSync(`${sourceDir}/inst.ts`, "generated inst");
    Deno.writeTextFileSync(`${targetDir}/inst.ts`, "custom inst  \n");
    Deno.writeTextFileSync(
      `${targetDir}/http_import.ts`,
      "custom HTTP imports\t\n",
    );
    Deno.writeTextFileSync(
      `${targetDir}/child_process_import.ts`,
      "custom child import  \n",
    );
    Deno.writeTextFileSync(
      `${targetDir}/child_process_worker.ts`,
      "custom child worker\t\n",
    );
    Deno.writeTextFileSync(`${targetDir}/bun.lock`, "locked deps");
    Deno.writeTextFileSync(`${targetDir}/stale.txt`, "stale");

    const result = new Deno.Command("node", {
      args: ["scripts/copy_vfs_bindings.mjs"],
      env: {
        VFS_BINDINGS_SOURCE_DIR: sourceDir,
        VFS_BINDINGS_TARGET_DIR: targetDir,
      },
      cwd: new URL("..", import.meta.url).pathname,
    }).outputSync();

    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }

    if (
      Deno.readTextFileSync(`${targetDir}/vfs.js`) !==
        "generated vfs\nconst tab = true;\r\nconst inside = 'keep  spaces';\n"
    ) {
      throw new Error(
        "copy script must normalize trailing whitespace in vfs.js",
      );
    }
    if (
      Deno.readTextFileSync(`${targetDir}/other.js`) !== "other generated  \n"
    ) {
      throw new Error("copy script must not normalize other generated files");
    }
    if (Deno.readTextFileSync(`${targetDir}/inst.ts`) !== "custom inst  \n") {
      throw new Error("copy script must preserve inst.ts");
    }
    if (
      Deno.readTextFileSync(`${targetDir}/http_import.ts`) !==
        "custom HTTP imports\t\n"
    ) {
      throw new Error("copy script must preserve http_import.ts");
    }
    if (
      Deno.readTextFileSync(`${targetDir}/child_process_import.ts`) !==
        "custom child import  \n"
    ) {
      throw new Error("copy script must preserve child_process_import.ts");
    }
    if (
      Deno.readTextFileSync(`${targetDir}/child_process_worker.ts`) !==
        "custom child worker\t\n"
    ) {
      throw new Error("copy script must preserve child_process_worker.ts");
    }
    if (Deno.readTextFileSync(`${targetDir}/bun.lock`) !== "locked deps") {
      throw new Error("copy script must preserve bun.lock");
    }
    let staleExists = true;
    try {
      Deno.statSync(`${targetDir}/stale.txt`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        staleExists = false;
      } else {
        throw error;
      }
    }
    if (staleExists) {
      throw new Error("copy script must remove stale generated files");
    }
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("vfs copy script keeps the target when the source directory is missing", () => {
  const tempDir = Deno.makeTempDirSync();
  try {
    const sourceDir = `${tempDir}/missing-dist`;
    const targetDir = `${tempDir}/vfs_bindings`;
    Deno.mkdirSync(targetDir);
    Deno.writeTextFileSync(`${targetDir}/sentinel.txt`, "keep me");

    const result = new Deno.Command("node", {
      args: ["scripts/copy_vfs_bindings.mjs"],
      env: {
        VFS_BINDINGS_SOURCE_DIR: sourceDir,
        VFS_BINDINGS_TARGET_DIR: targetDir,
      },
      cwd: new URL("..", import.meta.url).pathname,
    }).outputSync();

    if (result.success) {
      throw new Error("copy must fail when source is missing");
    }
    if (Deno.readTextFileSync(`${targetDir}/sentinel.txt`) !== "keep me") {
      throw new Error("missing source must not modify the target directory");
    }
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});
