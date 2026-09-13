import {
  getRustAnalyzerParallelism,
  presentRustAnalyzerParallelism,
  RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
  VFS_THREAD_INITIAL_CAPACITY,
} from "./runtime_parallelism.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
};

Deno.test("rust-analyzer parallelism reports runtime and browser limits", () => {
  const parallelism = getRustAnalyzerParallelism(12);
  assertEquals(
    parallelism.mainLoopThreads,
    RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
  );
  assertEquals(parallelism.wasiPoolInitialCapacity, VFS_THREAD_INITIAL_CAPACITY);
  assertEquals(parallelism.browserHardwareConcurrency, 12);
  assertEquals(
    presentRustAnalyzerParallelism(parallelism),
    `RA main pool (numThreads): ${RUST_ANALYZER_MAIN_LOOP_THREADS_WASI} · VTP starts ${VFS_THREAD_INITIAL_CAPACITY} (auto-grow) · browser 12`,
  );
});

Deno.test("rust-analyzer parallelism tolerates unavailable browser concurrency", () => {
  const parallelism = getRustAnalyzerParallelism(Number.NaN);
  assertEquals(parallelism.browserHardwareConcurrency, undefined);
  assertEquals(
    presentRustAnalyzerParallelism(parallelism),
    `RA main pool (numThreads): ${RUST_ANALYZER_MAIN_LOOP_THREADS_WASI} · VTP starts ${VFS_THREAD_INITIAL_CAPACITY} (auto-grow) · browser ?`,
  );
});
