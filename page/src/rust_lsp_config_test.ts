import { createRustAnalyzerInitializationOptions } from "./rust_lsp_config.ts";

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected: ${JSON.stringify(expected)}\nactual: ${
        JSON.stringify(actual)
      }`,
    );
  }
};

Deno.test("browser rust-analyzer configuration matches the validated integration", () => {
  assertEquals(
    createRustAnalyzerInitializationOptions(),
    {
      cargo: { sysroot: "/sysroot", buildScripts: { enable: false } },
      linkedProjects: [
        {
          sysroot: "/sysroot",
          sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
          sysroot_project: { crates: [] },
          crates: [
            {
              root_module: "/src/main.rs",
              edition: "2021",
              deps: [],
            },
          ],
        },
      ],
      procMacro: { enable: false },
      checkOnSave: { enable: false },
      cachePriming: { enable: false },
    },
    "browser initialization options differ from the GREEN integration",
  );
});
