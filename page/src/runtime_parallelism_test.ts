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
    4,
  );
  assertEquals(parallelism.wasiPoolInitialCapacity, VFS_THREAD_INITIAL_CAPACITY);
  assertEquals(parallelism.browserHardwareConcurrency, 12);
  assertEquals(
    presentRustAnalyzerParallelism(parallelism),
    "RA main pool (numThreads): 4 · VTP starts 8 (auto-grow) · browser 12",
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

Deno.test("rust-analyzer parallelism derives a capped worker count", () => {
  assertEquals(getRustAnalyzerParallelism(2).mainLoopThreads, 2);
  assertEquals(getRustAnalyzerParallelism(8).mainLoopThreads, 4);
  assertEquals(getRustAnalyzerParallelism(64).mainLoopThreads, 4);
});

Deno.test("rust-analyzer parallelism falls back for sub-one concurrency", () => {
  assertEquals(
    getRustAnalyzerParallelism(1).mainLoopThreads,
    RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
  );
  assertEquals(
    getRustAnalyzerParallelism(0).mainLoopThreads,
    RUST_ANALYZER_MAIN_LOOP_THREADS_WASI,
  );
});
