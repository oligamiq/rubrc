export function createRustAnalyzerInitializationOptions() {
  return {
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
  };
}
