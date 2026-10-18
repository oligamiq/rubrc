# Hosted Startup Profiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move CPU and process-memory profiling from the faulty local PC to an identifiable GitHub-hosted runtime.

**Architecture:** Reuse the existing preview-download/checksum path and startup measurement driver. An opt-in observer captures either CPU profiles or OS-side process memory; each mode gets a fresh browser and runs sequentially on the same unchanged preview. Keep resource evidence and instrumentation failures in short-lived artifacts.

**Tech Stack:** Node 22.22.1, Bun 1.4.2, locked Puppeteer/Chrome, CDP, Ubuntu 24.04.

## Global Constraints

- Public standard hosted runner; no local browser profiling or new application behavior.
- No WASM rebuild for profile replay. Input preview must still be available and its archive checksum must match.
- CPU and memory modes run sequentially. Each process has a 25-minute fallback deadline; the profiling job has a 70-minute emergency deadline.
- Existing individual startup deadlines and cache-adoption/editor checks remain intact.
- Browser-tree sampled RSS budget: 12 GiB. This is a conservative sum of RSS, not exact unique physical memory or a virtual-address-space limit.
- CPU profile output budget: 64 MiB per mode. Raw traces retained one day.
- Do not treat wait32 stack samples as on-CPU execution time or profiling durations as uninstrumented benchmarks.
- Preserve failures and partial observations; no successful profile claim when attachment, output budget or observation coverage fails.

## Task 1: Observation helpers and bounded capture

**Files:**
- `scripts/startup_runtime_profile_support.mjs`
- `scripts/startup_runtime_profile_support_test.mjs`
- `scripts/startup_runtime_profile.mjs`
- `scripts/measure_startup_device.mjs`

**Interfaces:** `processTree(psText, rootPid)` returns only numeric process metrics and process kinds for browser descendants. `startRuntimeProfile({browser,page,origin,output,mode})` returns `checkpoint(label)` and `dispose()`.

- [x] Observe failing tests for process-tree filtering and memory constructor observation.
- [x] Implement filtering independent of row order, excluding unrelated process arguments and invalid metrics.
- [x] Verify native-constructor forwarding, subclass behavior, failure propagation, growth observations and restoration with a controlled realm.
- [x] Add opt-in CI-only capture, bounded CDP operations, five-second memory samples, per-visit CPU checkpoints, 64 MiB output accounting and explicit observation outcomes.
- [x] Verify helpers plus the existing measurement-support tests and JavaScript syntax (16 tests passed).

## Task 2: Replay workflow and hosted verification

**Files:** `.github/workflows/stdlib-cache-ci.yml`, `scripts/ci/stdlib_cache.sh`, `docs/ci-execution-environment.md`.

- [x] Add `startup-profile` as an explicit dispatch mode using the existing replay download and archive verification. Skip Rust/WASM build jobs in this mode.
- [x] Run CPU and memory captures separately with the existing normal-network cold/reload driver and editor checks. Preserve a failed CPU result while still attempting the memory mode.
- [x] Check shell syntax, actionlint and diff; review lifecycle cleanup and partial capture handling.
- [x] Commit only the observer/workflow/documentation changes with `[skip ci]` and AI disclosure.
- [x] Wait for the active optimizer validation before dispatching profiling, because the workflow currently serializes runs by branch.
- [x] Dispatch one profile replay using the latest available verified preview; download its logs promptly, inspect observation coverage and failures, and record results.

## Validation commands

```sh
node --test scripts/startup_runtime_profile_support_test.mjs scripts/startup_measurement_support_test.mjs scripts/stdlib_cache_browser_support_test.mjs
node --check scripts/startup_runtime_profile.mjs
node --check scripts/measure_startup_device.mjs
bash -n scripts/ci/stdlib_cache.sh
/tmp/opencode/actionlint -shellcheck= -pyflakes= .github/workflows/stdlib-cache-ci.yml
git diff --check
```

## Review checkpoint

The observer deliberately launches Chrome on the hosted runner; connecting to the
faulty PC's browser is rejected. Browser-PID reads are inside the sampling error
boundary, attachment promises are awaited before stopping profiles, and sampling
is serialized by a busy guard. Failed instrumentation sets a nonzero Node exit
status, which the shell mode retains across both captures. Page-only CPU output
is rejected by regression test; separate cold/reload WASI samples pass. Disposal
allows 60 seconds for bounded sampling, attachment, profile-stop and detach work.

Optimizer run `39068855482` has completed with a usable, explicitly unoptimized
fallback preview. Use that run for the first hosted profiling replay.

## First replay and observer simplification

Run `39087573235` completed CPU capture with 45 profiles (34 WASI-worker profiles)
and successful startup/editor checks. The memory-constructor observation pass
timed out at VFS startup without a renderer crash. Its cause remains unconfirmed;
the unit-level constructor checks did not establish browser-level compatibility.

Remove the constructor observer and its now-inapplicable forwarding test; use
OS process-tree RSS for the memory pass. This comparison preserves the application
runtime and avoids claiming linear-memory coverage. Recheck the remaining helper
and capture coverage tests, then replay the same preview once to verify this path.

## Verified follow-up

The simplified observer passed 15 local lightweight helper/support tests and
shell/JavaScript/workflow static checks. Hosted replay `39089520461` then passed
both CPU and OS-memory modes on preview `39068855482`. Cold/reload readiness,
cache adoption and editor interactions succeeded in both modes. The observer
saved 45 CPU profiles (34 WASI-worker profiles), 56 CPU-mode memory samples and
48 OS-memory-mode samples with no recorded instrumentation errors. Downloaded
file counts/sizes and measurement outcomes were verified against the JSONL records.

See `docs/ci-execution-environment.md` for exact timing and memory values. CPU and
process-memory profiling no longer requires executing the application on the
faulty local PC. Whole-core optimization still needs a revised capacity strategy;
that unsuccessful resource experiment is recorded separately.
