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

  const project = createRustAnalyzerProjectSettings().linkedProjects[0] as
    & Record<string, unknown>
    & { sysroot_src: string };
  if ("sysroot_project" in project) {
    throw new Error(
      "full project still overrides rust-analyzer sysroot discovery",
    );
  }
  if (project.sysroot_src !== "/sysroot/lib/rustlib/src/rust/library") {
    throw new Error("full project lost the installed rust-src root");
  }
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
