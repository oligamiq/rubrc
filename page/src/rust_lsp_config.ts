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

export function createRustAnalyzerProjectJson() {
  return {
    sysroot: "/sysroot" as const,
    sysroot_src: "/sysroot/lib/rustlib/src/rust/library" as const,
    crates: [
      {
        display_name: "rubrc-main",
        root_module: "/src/main.rs",
        edition: "2021",
        deps: [],
      },
    ],
  };
}

export function createRustAnalyzerProjectSettings() {
  return {
    linkedProjects: [createRustAnalyzerProjectJson()],
    cargo: {
      sysroot: "/sysroot" as const,
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
