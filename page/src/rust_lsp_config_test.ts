import {
  createRustAnalyzerConfigurationState,
  createRustAnalyzerLightweightOptions,
  createRustAnalyzerProjectSettings,
} from "./rust_lsp_config.ts";

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected: ${JSON.stringify(expected)}\nactual: ${
        JSON.stringify(actual)
      }`,
    );
  }
};

Deno.test("lightweight rust-analyzer options have the exact startup shape", () => {
  assertEquals(
    createRustAnalyzerLightweightOptions(),
    {
      linkedProjects: [],
      cargo: { buildScripts: { enable: false }, autoreload: false },
      procMacro: { enable: false },
      checkOnSave: { enable: false },
      cachePriming: { enable: false },
    },
    "lightweight options include project paths or differ from the startup shape",
  );
});

Deno.test("full rust-analyzer settings preserve the validated project shape", () => {
  assertEquals(
    createRustAnalyzerProjectSettings(),
    {
      linkedProjects: [
        {
          sysroot: "/sysroot",
          sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
          sysroot_project: {
            crates: [
              {
                display_name: "core",
                root_module:
                  "/sysroot/lib/rustlib/src/rust/library/core/src/unit.rs",
                edition: "2021",
                deps: [],
              },
            ],
          },
          crates: [
            {
              display_name: "rubrc-main",
              root_module: "/src/main.rs",
              edition: "2021",
              deps: [],
            },
          ],
        },
      ],
      cargo: {
        sysroot: "/sysroot",
        buildScripts: { enable: false },
        autoreload: true,
      },
      procMacro: { enable: false },
      checkOnSave: { enable: false },
      cachePriming: { enable: false },
    },
    "full project settings differ from the validated integration",
  );
});

Deno.test("rust-analyzer configuration builders return fresh objects", () => {
  const lightweight = createRustAnalyzerLightweightOptions();
  const nextLightweight = createRustAnalyzerLightweightOptions();
  const full = createRustAnalyzerProjectSettings();
  const nextFull = createRustAnalyzerProjectSettings();

  if (lightweight === nextLightweight || full === nextFull) {
    throw new Error("configuration builders reused a top-level object");
  }
  if (
    lightweight.cargo === nextLightweight.cargo ||
    full.linkedProjects === nextFull.linkedProjects
  ) {
    throw new Error("configuration builders reused a nested object");
  }
});

Deno.test("rust-analyzer configuration responses switch from lightweight to the full project", () => {
  const configuration = createRustAnalyzerConfigurationState();
  assertEquals(
    configuration.initializationOptions(),
    createRustAnalyzerLightweightOptions(),
    "initialization did not use lightweight settings",
  );
  assertEquals(
    configuration.response([
      { section: "rust-analyzer" },
      { section: "other-server" },
    ]),
    [createRustAnalyzerLightweightOptions(), null],
    "lightweight workspace/configuration response mismatch",
  );

  configuration.activateProject();

  assertEquals(
    configuration.response([{ section: "rust-analyzer" }]),
    [createRustAnalyzerProjectSettings()],
    "project workspace/configuration response stayed lightweight",
  );
});
