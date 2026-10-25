# Waiter-Aware Memory Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute inline and retain verification checkpoints.

**Goal:** Avoid unnecessary last-reader notifications without losing writer wakeups, then measure desktop startup with unchanged readiness criteria.

**Architecture:** A private core-only lock state machine is shared between native tests and the existing WVL WASM exports. An opt-in Cargo feature selects the approved single-word waiting-marker protocol; feature-off retains the original algorithm. Generated-WASM relocation tests gate experimental Rubrc builds and paired desktop replay.

**Tech Stack:** Rust 2024, AtomicI32, existing WVL wait32/notify imports and CLI 0.10.0, Bun, GitHub Actions, existing browser measurement scripts.

## Global Constraints

- Specification: `docs/superpowers/specs/2026-10-25-waiter-aware-memory-lock-design.md`, approved by the user.
- Library MSRV 1.89.0; CLI MSRV 1.93.0; hosted toolchain `nightly-2026-09-13`.
- Heavy builds, stress tests, optimization and browser profiling only on hosted CI.
- Do not run `bun run vfs:truebuild`.
- No new JS Atomics/SharedArrayBuffer operations, WIT lists, Rust→JS→Rust reentry, or startup/DB/sysroot parallelization.
- Preserve cache identity checks, dependency/source-root ordering, fresh toolchain queries and readiness gates.
- Mobile work is on hold. No public deployment or main/develop updates.
- WVL worktree: `/tmp/opencode/wvl-waiter-aware`, branch `perf/waiter-aware-memory-lock` at base `657ba77`.
- Rubrc work stays on `ci/stdlib-cache-validation`; preserve existing generated/untracked changes.
- Both app variants use actual O1, initial heap 536870912 bytes, the same analyzer revision and the same source tuple.

## Task 1: Native protocol and unchanged export boundary

**Files (WVL):**
- Create `wasi_virt_layer/src/memory_lock.rs`.
- Modify `wasi_virt_layer/src/shared_global.rs` and `wasi_virt_layer/Cargo.toml`.
- Create `wasi_virt_layer/tests/memory_lock_protocol.rs` and `support/memory_lock_cases.rs`.

**Interfaces:** `MemoryAccessLock::new()` and the four acquire/release methods accept
a generic `WaitNotify` backend. Its `wait(&AtomicI32, i32)` compares and parks;
`notify(&AtomicI32, u32)` wakes waiters. Scheduling hooks exist only under
`cfg(test)`. Export names and WASM imports remain exactly as before.

- [x] First compile a native harness importing the existing `shared_global.rs`
  with native wait/notify symbols and a no-op `gen_alt_global` macro. Demonstrate
  this assertion against the real old implementation:

  ```rust
  lock_read_acquire();
  lock_read_release();
  assert_eq!(notify_count(), 0); // candidate expectation: must fail initially
  ```

- [x] Run the feature-off baseline expectation (one notify) and the candidate
  expectation (zero notify) before changing production code. Save the failure.

  ```bash
  rustc --test --edition=2024 wasi_virt_layer/tests/memory_lock_protocol.rs -o /tmp/opencode/wvl-lock-baseline
  /tmp/opencode/wvl-lock-baseline
  rustc --test --edition=2024 --cfg 'feature="waiter-aware-memory-lock"' wasi_virt_layer/tests/memory_lock_protocol.rs -o /tmp/opencode/wvl-lock-candidate
  /tmp/opencode/wvl-lock-candidate
  ```

- [x] Extract the baseline algorithm into the core-only module and delegate the
  unchanged exports to it. Native tests then import this actual production module
  directly; no duplicated lock model remains. Keep baseline tests green.
- [x] Add candidate tests for registration-before-release, release-before-
  registration, release-before-park, marked reader-count ABA, multiple waiting
  writers, reader blocked by a writer, spurious waits and count saturation.
- [x] Implement the exact approved transitions:

  ```text
  WAITING = 1 << 30; MAX_READERS = WAITING - 1; WRITER = -1
  reader acquire: CAS(old, old + 1, Acquire), preserving WAITING
  reader release: old = fetch_sub(1, Release)
                  notify(1) iff old == (WAITING | 1)
  writer acquire: CAS(0 or WAITING, WRITER, Acquire)
                  otherwise CAS readers -> readers|WAITING (Relaxed)
                  wait on the exact marked reader value or WRITER; retry
  writer release: store(0, Release); notify(u32::MAX)
  ```

  Saturated candidate readers spin/retry without parking or overflowing. On CAS
  failure reload rather than using stale state. Feature-off neither sets nor
  interprets WAITING. Private forwarding methods must inline.
- [x] A Condvar test backend holds a mutex while checking the expected state and
  registering its wait; notifications hold the same mutex. A watchdog timeout
  fails the test instead of supplying a recovery wakeup. Tests use separate lock
  instances, and payload assertions use atomics to avoid UB on a broken lock.
- [x] Run both native feature variants, then format only changed Rust files:

  ```bash
  rustfmt --edition 2024 --check wasi_virt_layer/src/memory_lock.rs wasi_virt_layer/src/shared_global.rs wasi_virt_layer/tests/memory_lock_protocol.rs wasi_virt_layer/tests/support/memory_lock_cases.rs
  ```

- [x] Review notification conditions, acquire/release ordering and no-waiter
  fast-path operations. Commit only this task's files with AI disclosure.

## Task 2: Hosted generated-WASM relocation gate

**Files (WVL):** `wasi_virt_layer-cli/tests/test_memory_lock_relocation.rs`,
`wasi_virt_layer-cli/tests/fixtures/memory_lock_relocation_vfs/{Cargo.toml,src/lib.rs,wit/world.wit}`,
target fixture and workspace member entries, `.github/workflows/memory-lock.yml`.

**Interfaces:** Use existing `utils::run_wasi_virt_layer`, `OutDir::Random`,
`--own-memory`, `--validate`, the existing pool machinery and the Task 1 feature.

- [x] Create a fixture whose guest repeatedly verifies sentinel data while the
  VFS physically reserves additional host pages, shifting the guest base. Assert
  that the guest base actually changes; logical growth alone is not acceptance.
- [x] Test both feature states and assert explicit completion/data-integrity
  markers. Set an outer timeout; a timeout or missing target is a failure.
- [x] Add a read-only hosted workflow, manually dispatched or triggered by a push
  to the dedicated experimental branch, with the pinned
  toolchain, both WASI targets, rust-src, Deno and required WVL generation tools.
  Run native protocol tests first, then the new fixture and these regressions:

  ```bash
  cargo test -p wasi_virt_layer-cli --test test_memory_lock_relocation -- --nocapture
  cargo test -p wasi_virt_layer-cli --test test_pool_own_memory -- --nocapture
  cargo test -p wasi_virt_layer-cli --test test_atomic_wait_reset -- --nocapture
  ```

- [x] Preserve generated cores/logs. Inspect exports and the candidate notify
  guard; reject extra hot-path forwarding calls or missing feature activation.
- [x] Push the isolated WVL branch and dispatch the bounded workflow. Inspect
  actual results/artifacts before proceeding to application builds.

## Task 3: Coherent experimental app variants and paired replay

**Files (Rubrc):** `.github/stdlib-cache-wvl-revision`,
`.github/workflows/stdlib-cache-ci.yml`, `.github/workflows/memory-lock-comparison.yml`,
`scripts/ci/stdlib_cache.sh`, `scripts/ci/paired_startup.mjs`,
`scripts/ci/wvl_experiment.mjs` and their tests. VFS feature forwarding is injected
only into the disposable experimental checkout's `crates/vfs/Cargo.toml`.

**Interfaces:** Add VFS feature forwarding for `waiter-aware-memory-lock`.
Experimental builds record `wvlRevision` and `memoryLockMode` (`baseline` or
`waiter-aware`). Existing `sourceSha`, `analyzerSha`, `coreOptimization` and
`vfsInitialHeapBytes` remain authoritative.

- [x] Test that paired replay rejects differing source tuples, optimization,
  heap settings, unexpected feature states, or failed checksum validation.
- [ ] Add a CI-only dependency override to the exact successful WVL commit.
  Verify Cargo resolves that revision and the intended feature state for VFS.
- [ ] Build feature-off and feature-on core/bindings/cache/page sets sequentially,
  with the same existing O1 optimizer budget and initial heap. Generate each cache
  from its own distributed WASM. Keep normal builds unchanged.
- [ ] The paired replay driver consumes two verified preview directories and
  invokes the existing measurement driver with fresh browsers, normal networking
  and separate output directories in baseline/candidate/candidate/baseline order.
  Set `RUBRC_MEASURE_ROOT` and `RUBRC_MEASURE_OUTPUT` per invocation; preserve all
  failure records and return nonzero if any session fails.
- [ ] Capture runner CPU model, browser versions and worker counts. Do not enable
  CPU sampling during the primary A–B–B–A timings. Each session includes cold,
  reload, completion and diagnostic checks with unchanged readiness criteria.
- [ ] Require all four sessions to pass and both candidate session medians to be
  below both baseline session medians for semantic warming. Overlap is
  inconclusive. Report raw observations, median/range and peak RSS regardless of
  outcome; do not change the default feature based only on a successful build.
- [ ] If timing warrants attribution, reuse the candidate preview in the existing
  hosted `startup-profile` mode. Save artifacts immediately.

## Task 4: Final review and result record

**Files:** `docs/desktop-startup-bottleneck.md`, this plan and the approved spec.

- [ ] Review the final scoped diffs in both repositories, native results, actual
  WASM coverage and paired measurements. Verify no skipped test is called passed.
- [ ] Record exact commits, hashes, toolchain, feature states, failures and the
  measured decision. Keep the feature default off pending a separate rollout.
- [ ] Commit/push intended files only, with `[skip ci]` where appropriate and AI
  disclosure. Leave public deployment and existing local generated files alone.

## Execution checkpoint — implementation and gate blocker

WVL branch: `perf/waiter-aware-memory-lock`, worktree
`/tmp/opencode/wvl-waiter-aware`. Protocol commit `3d5911a`; current gate revision
`e429cef230cb73d72347f79ed26e859d7a2c5c59`. Both are pushed.

Task 1 is implemented. The initial regression executed the original exported
lock functions: baseline passed, candidate expectation failed with three
notifications instead of zero. The extracted production protocol now passes
9 baseline and 11 candidate native tests. The tests also exercise the real
export wrappers. The concurrency reviewer withdrew its lost-wakeup allegations
after checking compare-and-park and address-based wake semantics; reader
preference/starvation under unbounded reader traffic is documented and unchanged.

Task 2 evidence:

| Hosted run | Observation |
| --- | --- |
| `40187836843` | Fixture invocation rejected unsupported `--no-cache`; removed. |
| `40188275119` | Fixture required guest `wasi_thread_start` ABI; added an unreachable stub because only VFS threads execute the guest. VFS feature argument placement was also corrected. |
| `40210607581` | Both generated lock modes completed 32 physical relocations and sentinel checks; generated release guards passed inspection. Two existing non-threaded reset cases failed with `undefined.buffer`. |
| `40212316762` | Repeated relocation success, 9/11 native tests, threaded pool success and atomic-wait-reset success. The same two non-threaded reset failures reproduced on untouched base `657ba779ce611edda36386696f4eba26480d8c88`. Overall gate remains **failed**. |

The failing existing cases are
`test_own_memory_reset_restores_logical_size` and
`test_own_memory_reset_clears_unreachable_wrapper_state`. The control was built
from a separate worktree at the original revision in the same hosted job; this
is stronger evidence than assuming that an unrelated-looking failure pre-existed.
Artifacts are saved at `/tmp/opencode/wvl-lock-gate-40212316762/`.

Task 3 wiring and its nine focused Node tests are prepared. The reusable workflow
requires a successful gate at the exact pinned WVL revision and permits only push
or workflow_dispatch gates, not synthetic PR merge runs. It builds the two modes
sequentially; replay verifies archive, decoded core and cache checksums, requires
identical analyzer binaries and distinct core binaries, and measures A–B–B–A.
Regression and overlap are distinguished, preserved in the result file and return
nonzero rather than being accepted as improvements. No application comparison
build has been dispatched because the full WVL gate is still failed.

Cargo checks dependency-feature references even when a feature is off. Therefore
normal `crates/vfs/Cargo.toml` remains unchanged; both the path override and VFS
feature forwarding are applied only inside the disposable CI checkout. Local
default offline metadata resolution passed that feature-selection check but could
not finish because `aho-corasick v1.1.5` was absent from the local download cache.
No heavy build was run on the local host.

**Decision required:** the approved spec requires the existing reset tests to
pass. Either repair the pre-existing non-threaded runtime problem as a separate
task, or explicitly narrow this experiment's gate to the affected threaded
configuration while retaining the known-failure control as diagnostic evidence.
Do not silently skip these failures or declare desktop acceleration proven.
