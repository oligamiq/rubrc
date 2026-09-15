import {
  RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
} from "./runtime_parallelism.ts";

export function createRustAnalyzerLightweightOptions(
  numThreads = RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
): {
  linkedProjects: [];
  cargo: { buildScripts: { enable: false }; autoreload: false };
  procMacro: { enable: false };
  checkOnSave: { enable: false };
  cachePriming: { enable: false };
  numThreads: number;
} {
  return {
    linkedProjects: [],
    cargo: { buildScripts: { enable: false }, autoreload: false },
    procMacro: { enable: false },
    checkOnSave: { enable: false },
    cachePriming: { enable: false },
    numThreads,
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

export function createRustAnalyzerProjectSettings(
  numThreads = RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
) {
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
    numThreads,
  };
}

export function createRustAnalyzerConfigurationState(
  numThreads = RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
) {
  let settings:
    | ReturnType<typeof createRustAnalyzerLightweightOptions>
    | ReturnType<typeof createRustAnalyzerProjectSettings> =
      createRustAnalyzerLightweightOptions(numThreads);

  return {
    initializationOptions: () => settings,
    activateProject: () => {
      settings = createRustAnalyzerProjectSettings(numThreads);
    },
    response: (items: readonly { section?: string | null }[]) =>
      items.map((item) => item.section === "rust-analyzer" ? settings : null),
  };
}
