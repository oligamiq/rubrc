export function createRustAnalyzerLightweightOptions(): {
  linkedProjects: [];
  cargo: { buildScripts: { enable: false }; autoreload: false };
  procMacro: { enable: false };
  checkOnSave: { enable: false };
  cachePriming: { enable: false };
} {
  return {
    linkedProjects: [],
    cargo: { buildScripts: { enable: false }, autoreload: false },
    procMacro: { enable: false },
    checkOnSave: { enable: false },
    cachePriming: { enable: false },
  };
}

export function createRustAnalyzerProjectSettings(): {
  linkedProjects: Array<{
    sysroot: "/sysroot";
    sysroot_src: "/sysroot/lib/rustlib/src/rust/library";
    sysroot_project: {
      crates: Array<{
        display_name: "core";
        root_module: "/sysroot/lib/rustlib/src/rust/library/core/src/unit.rs";
        edition: "2021";
        deps: [];
      }>;
    };
    crates: Array<{
      display_name: "rubrc-main";
      root_module: "/src/main.rs";
      edition: "2021";
      deps: [];
    }>;
  }>;
  cargo: {
    sysroot: "/sysroot";
    buildScripts: { enable: false };
    autoreload: true;
  };
  procMacro: { enable: false };
  checkOnSave: { enable: false };
  cachePriming: { enable: false };
} {
  return {
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
  };
}

export function createRustAnalyzerConfigurationState() {
  let settings:
    | ReturnType<typeof createRustAnalyzerLightweightOptions>
    | ReturnType<typeof createRustAnalyzerProjectSettings> =
      createRustAnalyzerLightweightOptions();

  return {
    initializationOptions: () => settings,
    activateProject: () => {
      settings = createRustAnalyzerProjectSettings();
    },
    response: (items: readonly { section?: string | null }[]) =>
      items.map((item) => item.section === "rust-analyzer" ? settings : null),
  };
}
