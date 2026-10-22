# VFS Host Capacity Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine VFS host logical usage and physical reservation before selecting a safe startup-memory policy.

**Architecture:** A test-only utility-worker observer retains the real core export handles after instantiation. At independent JS startup boundaries and five-second timer intervals, it acquires the existing read lock, reads scalar logical-size and guest-base getters, observes the existing shared memory's byte length, and releases the lock before logging. No memory constructor replacement or Rust policy change is introduced.

**Tech Stack:** Existing WVL 0.10 core exports, TypeScript/Deno unit tests, existing hosted preview build and Pixel driver.

## Constraints and data semantics

- No new JS Atomics, SharedArrayBuffer allocation, WIT lists, startup parallelization, or Rust calls from Rust-to-JS callbacks.
- The instantiation observer only stores export handles; actual getter calls occur after `custom_instantiate` or `animal.start` returns, or from a JS timer.
- Existing scalar APIs: `__wasip1_vfs_host_own_memory_size_get`, the read acquire/release exports, and `*_memory_grow_global_alt_get_no_wait`.
- In the current single-memory layout, the host begins at zero and its physical boundary is the first positive guest base. Validate page alignment/bounds and retain all raw offsets; reject inconsistent geometry rather than guessing.
- Logical size is pages, converted at 65,536 bytes/page. It is not live heap bytes; physical capacity is not RSS. `-1` means logical initialization has not completed.
- Missing exports produce `unsupported`; invalid geometry produces `invalid`. Getter exceptions still release an acquired lock and are logged as observation errors.
- Enable only with `VITE_RUBRC_LSP_TEST=1`. Stop timers on utility failure, replacement or after ten minutes. Worker termination also ends its timers.
- Retain full snapshots in separate per-visit JSON files, including on renderer failure. New preview metadata marks telemetry version 1; successful startup tests require at least one valid snapshot for that version.
- Heavy execution remains in CI. Use a diagnostic non-O1 build initially to verify the metadata path without repeating the costly optimizer. Label it explicitly; it is not a speed comparison with the optimized acceptance baseline.

## Task 1: Collector and test-only wiring

**Files:** `page/src/vfs_memory_measurements.ts`, its `_test.ts`,
`page/src/worker_process/vfs_bindings/inst.ts`, `page/src/worker_process/util_cmd.ts`.

- [x] Observe failing collector tests for unit conversion, initialization, invalid geometry and lock release.
- [x] Implement scalar collection with the existing lock and explicit supported/initialized/valid states.
- [x] Pass core exports through an optional post-instantiation observer; do not expose them globally or modify the fake component export interface.
- [x] Add bounded test-only reporting at instantiation, after VFS main returns, and from five-second timers.
- [x] Verify the collector and surrounding startup regressions (47 passed);
  inspect all new getter call sites for callback re-entry and lifecycle cleanup.

## Task 2: Retention, coverage and hosted diagnostic preview

**Files:** `scripts/measure_startup_device.mjs`, `scripts/ci/stdlib_cache.sh`, `.github/workflows/stdlib-cache-ci.yml`.

- [x] Capture `[startup-memory]` reports and save full per-visit/failure snapshots separately from compact timing records.
- [x] Mark new coupled previews with `vfsMemoryTelemetry: 1`; require valid coverage on successful visits while preserving old-preview replay compatibility.
- [x] Include the collector tests in hosted checks.
- [x] Commit only intended source files after syntax/workflow checks, leaving local generated WASM/vfs.js/worker.ts changes untouched.
- [x] Dispatch a diagnostic `mobile-baseline` / `core_opt=none` build and start automatic artifact retrieval.
- [x] Confirm host-capacity observations on hosted desktop, then use the same verified preview on Pixel. Only select a reservation-policy change after reading the measured capacity and logical high-water values.

Run `39502399591` passed with valid capacity snapshots in all four desktop visits.
Host physical capacity was 1.125 MiB after instantiation and 513.125 MiB after
VFS main; logical size after main was only 17.125 MiB. The desktop logical
high-water was 161.75 MiB. The same hash-verified diagnostic preview on Pixel
crashed after 57.928 s; its last valid snapshot reported 163 MiB logical size
against 513.125 MiB physical capacity. Android recorded LOW_MEMORY at about
2.9 GB RSS. These are unoptimized diagnostic results, not an O1 speed comparison.

The next experiment preserves the added 512 MiB budget but supplies it through
the VFS-only linker initial heap, testing whether this avoids eagerly touching
unused reserved pages. See `2026-10-21-initial-vfs-heap.md`.
