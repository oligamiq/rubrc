// Rubrc prewarms the wasi_virt_layer 0.6.1 VirtualThreadPool to 8 workers.
// This is not a hard maximum: VirtualThreadPool::run() automatically grows
// the configured capacity when all workers are occupied.
export const VFS_THREAD_INITIAL_CAPACITY = 8;

// Fresh fork A/B confirms the main TaskPool follows numThreads: auto/2/8
// produced 9/10/16 pre-host workers. num_cpus 1.17.0 on wasm32-wasip1-threads
// reports get_physical()=1, so the auto main TaskPool resolves to 1.
export const RUST_ANALYZER_MAIN_LOOP_THREADS_WASI = 1;

export type RustAnalyzerParallelism = {
  mainLoopThreads: number;
  wasiPoolInitialCapacity: number;
  browserHardwareConcurrency?: number;
};

export function getRustAnalyzerParallelism(
  browserHardwareConcurrency = globalThis.navigator?.hardwareConcurrency,
): RustAnalyzerParallelism {
  return {
    mainLoopThreads: RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
    wasiPoolInitialCapacity: VFS_THREAD_INITIAL_CAPACITY,
    ...(typeof browserHardwareConcurrency === "number" &&
    Number.isFinite(browserHardwareConcurrency) &&
    browserHardwareConcurrency > 0
      ? { browserHardwareConcurrency }
      : {}),
  };
}

export function presentRustAnalyzerParallelism(
  parallelism: RustAnalyzerParallelism,
): string {
  const browser =
    parallelism.browserHardwareConcurrency === undefined
      ? "browser ?"
      : `browser ${parallelism.browserHardwareConcurrency}`;
  return `RA main pool (numThreads): ${parallelism.mainLoopThreads} · VTP starts ${parallelism.wasiPoolInitialCapacity} (auto-grow) · ${browser}`;
}
