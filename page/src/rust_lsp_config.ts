import { RUST_ANALYZER_MAIN_LOOP_THREADS_WASI } from "./runtime_parallelism.ts";

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

const freezeConfiguration = <T extends object>(value: T): T => {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freezeConfiguration(child);
  }
  return Object.freeze(value);
};

export function createRustAnalyzerConfigurationState(
  numThreads = RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
  singleProjectInitialization = false,
) {
  // One immutable full snapshot preserves project identity and selected threads
  // across initialization, configuration responses, and legacy activation.
  const projectSettings = freezeConfiguration(
    createRustAnalyzerProjectSettings(numThreads),
  );
  const initializationOptions = singleProjectInitialization
    ? projectSettings
    : freezeConfiguration(createRustAnalyzerLightweightOptions(numThreads));
  let settings = initializationOptions;

  return {
    initializationOptions: () => initializationOptions,
    activateProject: () => {
      if (singleProjectInitialization) return null;
      settings = projectSettings;
      return projectSettings;
    },
    response: (items: readonly { section?: string | null }[]) =>
      items.map((item) => item.section === "rust-analyzer" ? settings : null),
  };
}
