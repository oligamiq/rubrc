# Initial VFS Heap Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test whether provisioning the existing host heap budget at link time reduces resident memory without reducing usable host capacity.

**Architecture:** Add an opt-in build script to the VFS cdylib only. For `wasm32-wasip1-threads`, `RUBRC_VFS_INITIAL_HEAP_BYTES=536870912` emits the link argument `--initial-heap=536870912`. This adds heap space after data/stack at link time. The intended effect is for own-memory logical initialization to expose that space before VFS main, allowing the existing thread-margin check to skip repeated physical growth. No guest-module linker flags, read-lock algorithms or default reservation behavior are changed.

**Tech Stack:** Cargo build script, LLVM wasm linker, existing WVL 0.10 own-memory runtime, scalar capacity telemetry, hosted measurements and Pixel acceptance.

## Evidence and hypothesis

Diagnostic run `39502399591` measured host physical capacity 1.125 MiB immediately
after instantiation and 513.125 MiB after VFS main, with logical size 17.125 MiB at
that point. Hosted startup/editing logical high-water was 161.75 MiB; the last
Pixel snapshot before its crash was 163 MiB against the same 513.125 MiB capacity.
Thus one 64 MiB margin is not a sufficient replacement policy.

The linker advertises `--initial-heap`; wasi-libc dlmalloc has an initial allocator
path using the space between `__heap_base` and `__heap_end`. Relevant sources:
`lld/wasm/Writer.cpp`, `lld/wasm/Options.td`, and
`https://github.com/WebAssembly/wasi-libc/blob/main/dlmalloc/src/malloc.c`.
The pinned CI linker must also pass a help/preflight check before building.

WVL physical growth currently copies later memory regions and fills the newly
inserted gap. The hypothesis is that initial zero-backed heap space avoids
eagerly touching the entire unused host reservation. This is not established by
the link flag alone; RSS and real startup/editor behavior must be measured.

## Constraints

- Default remains off. Use the explicit `initial_vfs_heap` workflow input for the experiment.
- Emit `cargo:rustc-link-arg-cdylib`, scoped to package `vfs`; do not alter vfs-shell, analyzer, rustc or LLVM guest link arguments.
- Ignore the option for native checks; reject unsupported WASM targets and arbitrary heap sizes rather than mislabeling a trial.
- Do not reduce the established 512 MiB added host budget. Confirm initial capacity is present and does not grow again during VFS main.
- No new JS Atomics/SAB, WIT list, Rust-callback re-entry or startup parallelization.
- Logical size after predeclaring heap is not actual allocated/live heap or RSS; do not compare it to the old logical high-water as a memory regression.
- Heavy builds/profiling remain in CI. Use `core_opt=none` initially to isolate allocation policy and avoid another optimizer pass. Preserve preview/logs for three days with automatic retrieval.
- No deployment or default-on rollout until application acceptance succeeds.

## Task 1: Opt-in linker policy and assertions

**Files:** `crates/vfs/build.rs`, `.github/workflows/stdlib-cache-ci.yml`,
`scripts/ci/stdlib_cache.sh`, `scripts/startup_measurement_support.mjs`,
`scripts/startup_measurement_support_test.mjs`, `scripts/measure_startup_device.mjs`.

- [x] Observe failing build-script tests, then implement target/flag validation and the VFS-only linker directive.
- [x] Add failing measurement assertions for a flag that did not take effect and accidental repeated reservation after an initial heap.
- [x] Implement assertions and explicit preview metadata for initial heap bytes.
- [x] Add pinned-linker preflight and OS-side process RSS capture for the experiment.
- [x] Verify build-script/helper/startup tests (4 Rust, 21 Node, 5 Deno passed)
  and workflow syntax; inspect the diff for guest flag leakage and default changes.
- [x] Commit only intended source files, preserving existing local generated changes.

## Task 2: Hosted and physical acceptance

- [x] Dispatch one full `mobile-baseline`, `core_opt=none`, `initial_vfs_heap=true` run.
- [x] Start the artifact retrieval controller and verify cache generation, observed initial physical capacity, no repeated host reservation, desktop cold/reload/editor checks, and process RSS.
- [x] Download/hash-verify the same preview and test Pixel. Preserve failures; do not claim mobile success before ready/completion/diagnostic acceptance.
- [x] Decide whether to retain, revise or reject the experiment from actual behavior and memory evidence.

## Outcome

Run `39863026104` passed with 513.125 MiB host capacity both before and after VFS
main; all desktop acceptance checks passed. The same preview on Pixel confirmed
the mechanism but still ended in LOW_MEMORY: normal at 57.293 s (about 2.6 GB RSS),
constrained at 351.329 s (about 2.7 GB RSS). The constrained trial reached cache
merge confirmation, but neither reached ready or editor acceptance.

Keep the option disabled by default and retain the result as an experiment,
not a completed mobile fix. Detailed identities and timings are in
`docs/mobile-startup-measurement-results.md`. The remaining work includes the
compiler/workspace subprocesses and per-access runtime overhead; simply reducing
or moving host reservation has not resolved the original problem.

## Task 3: Check the combined candidate

The allocation-policy trial used an unoptimized core to isolate the mechanism.
Before rejecting the combined candidate, run one coupled build with both
`initial_vfs_heap=true` and `core_opt=O1`. Use the same cache-generation and
desktop/device acceptance checks; this is not another identical retry of the
failed unoptimized trial. Keep the option off by default.

- [x] Dispatch the combined build and start automatic artifact retrieval.
- [x] Verify O1 applied, initial capacity assertions, cache adoption and desktop
  acceptance, then test the same preview on Pixel.
- [x] Preserve failures and decide whether further reservation-only experiments
  are justified. If mobile acceptance still fails, investigate the remaining
  compiler/workspace loading architecture rather than declaring this a fix.

Run `39922942192` passed desktop checks and confirmed O1 plus the predeclared
heap. Pixel still failed in both profiles with LOW_MEMORY at about 2.9 GB RSS
(57.728 s normal; 342.087 s constrained). The combined candidate therefore does
not justify default-on rollout or a mobile-fix claim. Stop further reservation-only
tuning and use the workspace/sysroot-loading architecture as the next design
checkpoint; full results and the proposed contained Cargo-metadata bypass scope
are recorded in `docs/mobile-startup-measurement-results.md`.
