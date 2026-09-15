// Rubrc prewarms the wasi_virt_layer 0.6.1 VirtualThreadPool to 8 workers.
// This is not a hard maximum: VirtualThreadPool::run() automatically grows
// the configured capacity when all workers are occupied.
export const VFS_THREAD_INITIAL_CAPACITY = 8;

// wasm32-wasip1-threads reports one physical CPU even when the browser can
// provide more Workers. Keep the browser-derived value conservative because
// each analyzer worker shares the VFS Wasm memory and its virtual thread pool.
export const RUST_ANALYZER_MAIN_LOOP_THREADS_WASI = 1;
export const RUST_ANALYZER_MAIN_LOOP_THREADS_MAX = 4;

export type RustAnalyzerParallelism = {
  mainLoopThreads: number;
  wasiPoolInitialCapacity: number;
  browserHardwareConcurrency?: number;
};

export function getRustAnalyzerParallelism(
  browserHardwareConcurrency = globalThis.navigator?.hardwareConcurrency,
): RustAnalyzerParallelism {
  const mainLoopThreads =
    typeof browserHardwareConcurrency === "number" &&
      Number.isFinite(browserHardwareConcurrency) &&
      browserHardwareConcurrency > 1
      ? Math.min(
        RUST_ANALYZER_MAIN_LOOP_THREADS_MAX,
        Math.max(2, Math.floor(browserHardwareConcurrency / 2)),
      )
      : RUST_ANALYZER_MAIN_LOOP_THREADS_WASI;
  return {
    mainLoopThreads,
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
