import packageJson from "../package.json" with { type: "json" };

Deno.test("all VFS builds enable outer-module panic unwinding", () => {
  for (
    const scriptName of [
      "vfs:build",
      "vfs:build:prod",
      "vfs:build-debug",
    ] as const
  ) {
    const buildCommand = packageJson.scripts[scriptName].split("&&", 1)[0];
    const flags = buildCommand.split(/\s+/);
    if (!flags.includes("--vfs-unwind")) {
      throw new Error(`${scriptName} must include standalone --vfs-unwind`);
    }
    if (flags.includes("--wasm-unwind")) {
      throw new Error(
        `${scriptName} must not change embedded target unwinding`,
      );
    }
  }
});
