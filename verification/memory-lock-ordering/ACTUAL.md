# Actual-source Acquire/Release payload verification

## Result and scope (2026-11-26)

**PASS for the two small models, both legacy and waiter-aware variants, under
explicit Loom bounds. This is not exhaustive verification of arbitrary
executions or a proof of wait/notify correctness or liveness.** No production
source was edited; no commit or push was made by this task.

The requested worktree/commit resolves to
[the actual source](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs>)
at `77f45543eb976e4e7843e78fcd67bd837acac6bd` in
`.worktrees/wvl-lock-batching` (not a directory with the commit appended).
The source SHA256 is
`d9c08f4561376fbe356d67ca8451e99fcdb9c79c29d78bbf7bb82a651a896961`.

### Final increased-budget run

[Machine-readable summary](<results/actual-20261126T055136.995248Z/summary.json>)
contains exact commands, UTC timestamp, per-command timeouts/status/durations,
source and harness hashes, dependency-lock hash, and environment paths.
[Toolchain](<results/actual-20261126T055136.995248Z/rustc-version.log>):
`rustc 1.98.1 (48a229cea 2026-09-01)`; Cargo 1.98.1.

| Variant | Case | Started = completed | Assertions per completion | Raw log |
|---|---|---:|---:|---|
| Legacy | Writer Release → reader Acquire | 5 | 1 | [log](<results/actual-20261126T055136.995248Z/legacy-writer_release_to_reader_payload.log>) |
| Legacy | Two reader Releases → writer Acquire | 840 | 2 | [log](<results/actual-20261126T055136.995248Z/legacy-readers_release_to_writer_disjoint_payloads.log>) |
| Waiter-aware | Writer Release → reader Acquire | 5 | 1 | [log](<results/actual-20261126T055136.995248Z/waiter-aware-writer_release_to_reader_payload.log>) |
| Waiter-aware | Two reader Releases → writer Acquire | 1715 | 2 | [log](<results/actual-20261126T055136.995248Z/waiter-aware-readers_release_to_writer_disjoint_payloads.log>) |

Final limits: **4 threads total, 128 branches per execution, preemption bound
2, max_permutations 10000, max_duration 30 seconds, checkpoint_interval 1**;
120-second external timeout per build, 60-second timeout per individual test
command (including Cargo startup). No timeout, branch-limit failure, or
assertion failure occurred. All four returned below iteration/time caps;
according to Loom 0.7.2's control flow, the configured bounded search finished.
This still excludes schedules requiring more preemptions and does not imply
arbitrary execution exhaustiveness. Each completion necessarily executes the
listed payload assertions; no conditional assertion or skip masks vacuity.
The final waiter-aware two-reader case took477ms inside the model. Parent independently reran the same expanded command; [parent summary](results/actual-20261126T055232.991202Z/summary.json) and sibling raw logs reproduce5/840/5/1715 starts=completions, with all commands exit0. Both runs' original/instrumented source hashes were rechecked against their source manifests.

The [initial run summary](<results/actual-20261126T054835.920103Z/summary.json>)
preserves a separate 1000-permutation/10-second experiment. It passed with
5, 840, 5, **999** starts respectively; the waiter-aware two-reader case was
a **cap-limited prefix**. Loom checks its 1-based iteration counter before
running, so max_permutations 1000 permits 999 starts. The initial code had
only a started counter; the final code separately records completions.
Initial dependency/build time was 9.23s. Historical initial evidence is not
overwritten; final harness/source snapshots are also durable.

## Precise source relationship

The isolated crate is described by [Cargo.toml](<actual-harness/Cargo.toml>),
with exact direct dependency `loom = "=0.7.2"` and a checked-in deliverable
[Cargo.lock](<actual-harness/Cargo.lock>) fixing transitive dependencies.
It is not a member of the WVL production workspace.

[build.rs](<actual-harness/build.rs>) runs the standard-library Python
[source transformer](<actual-harness/source_transform.py>) at Cargo build
time. It verifies the complete input SHA256 and checks **exactly one** match
for each of these substitutions, failing closed on mismatch:

1. `use core::sync::atomic::{AtomicI32, Ordering};` →
   `use loom::sync::atomic::{AtomicI32, Ordering};`
2. `pub(super) const fn new() -> Self {` → non-const `fn new` (Loom constructor
   cannot be const).
3. Remove only the terminal `#[cfg(test)]` native test-module declaration
   pointing at `../tests/support/memory_lock_cases.rs`.

Nothing else in the algorithm, orderings, lock loops, marker logic, or
native-test hooks is edited. Test hooks in the trait remain, with their
original empty default methods; the harness backend does not override them.
The generated file is compiled through a generated path module, preserving
its original module-level comments. [Source manifest](<results/actual-20261126T055136.995248Z/source/source-manifest.json>)
records replacements and source/generated hashes, alongside the
[original source snapshot](<results/actual-20261126T055136.995248Z/source/memory_lock_original.rs>)
and [instrumented snapshot](<results/actual-20261126T055136.995248Z/source/memory_lock_instrumented.rs>).
The source is not manually reimplemented as a litmus here.

## Cases and anti-masking argument

The only harness test module is in [lib.rs](<actual-harness/src/lib.rs>).
Payloads are Loom `AtomicUsize` with **Relaxed** stores/loads and assertions;
they are not synchronization helper flags.

- **Writer publishes then reader:** main acquires the writer before spawning
  the reader. Main stores payload only **after** the spawn, then releases.
  The reader must acquire a later lock epoch, asserts 41, then releases.
  Spawn cannot publish the later payload write. The reader's assertion is
  before the main-thread join.
- **Reader releases then writer sees disjoint writes:** main initially holds
  two read permits, transfers their release obligations to two worker threads,
  and spawns the writer before those workers. The low-level lock has no
  thread-local owner state. Each reader worker writes only its own Relaxed
  payload (17 or 29), then performs the actual reader release. The writer
  cannot acquire while either permit remains; it asserts both payloads after
  acquisition. Main-thread joins do not publish reader stores into the writer:
  the writer assertions happen before any joins in main complete. There are
  no helper Acquire/Release gates or mutexes protecting the payloads.

The two initial read acquires deliberately model already-held permits, not
arbitrary concurrent read-acquisition workloads. Arc is used only for storage
ownership; payload reads occur before thread-exit drops can create unrelated
lifetime synchronization. Non-Loom counters count entire model closures only;
they never select model behavior or establish an in-model payload edge.

## Backend and Loom limitations

The backend's `wait` is `loom::thread::yield_now()`; `notify` is a no-op. This
allows the **actual lock loops** to be scheduled, while intentionally not
modeling production compare-and-park behavior, wake delivery, fairness,
waiter-registration races, starvation, or liveness. Reader saturation and
arbitrary reader/writer populations are outside these two models.

[Implementation notes](<actual-harness/LOOM-NOTES.md>) document Loom's
inherited release state across successful RMWs (`rt/atomic.rs:529-536`) and
its synchronization-vector joins (`rt/synchronize.rs:39-61`). The model
retains prior release synchronization across the reader Release RMWs and
the Relaxed marker RMW. No inherited-release limitation caused a failure in
these cases, but this Loom mechanism is not an independent language-level
proof. We do not claim every marker path was visited: production internals
were not additionally instrumented for path counters. Also out of scope are
compiler/hardware lowering, all weak-CAS spurious failures, count overflow,
and native untracked payload data-race detection (payloads here are tracked
Relaxed atomics, not UnsafeCell).

## Reproduce without global installs

From the project root:

```sh
# Uses the existing pinned lock; every build/test has --locked.
python3 verification/memory-lock-ordering/actual_runner.py \
  --max-permutations 10000 --max-duration 30 --test-timeout 60

# Smaller default budget (may stop at a bounded prefix).
python3 verification/memory-lock-ordering/actual_runner.py
```

[actual_runner.py](<actual_runner.py>) clears **all `LOOM_*` environment
variables**, sets and records explicit `WVL_VERIFICATION_*` model caps, and
uses only project-local `actual-harness/.cargo-home` and
`actual-harness/target` for downloads/builds. No global install is performed.
The initial lock was generated explicitly with `--prepare-lock`; normal
reproduction must not regenerate it. Each run writes a new timestamped
results directory and snapshots source, harness, and runner before building.
Every command's combined stdout/stderr is saved, including failures; timeout
kills the process group and records a non-success result. Dependency cache,
build products, and Python bytecode are ignored by the harness's
[.gitignore](<actual-harness/.gitignore>).

Remaining work if stronger coverage is desired: independently justify the
language-level release-sequence argument, expand schedule/preemption bounds
and lock epochs with measured budgets, and verify wait/notify separately.
None of those properties is claimed by these passing small-model results.
