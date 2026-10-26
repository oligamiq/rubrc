# Waiter-aware memory-lock notification design

Date: 2026-10-25

Status: specification approved by the user. The opt-in protocol and focused tests
are implemented on the experimental branch. The user approved treating the two
non-threaded reset failures, reproduced on unchanged 0.10.0, as non-blocking
diagnostics. Native protocol and threaded WASM checks remain required. See the
implementation plan's execution record.

## Goal and evidence

Reduce desktop analysis latency by avoiding the last-reader WebAssembly notify
when there is no registered writer. Preserve exclusion between guest memory
access and physical memory growth/relocation.

`docs/desktop-startup-bottleneck.md` records hosted run `40165755028`. In the
verified O1 core, two prominent worker profiles attribute about 28 seconds of
leaf-sample weight to read release and about 9 seconds to read acquire. Read
release decrements the shared count and notifies whenever the old count is one.
These are sampled wall-time weights, not promised savings or on-CPU totals.

The user approved investigating this WVL-side optimization. Mobile optimization
and device testing are on hold. Desktop ready, completion and diagnostics remain
the acceptance criteria.

## Chosen scope and alternatives

Use a sticky writer-waiting bit in the **same** atomic word as the reader count.
Keep the existing per-access protection and writer-release broadcast. Make this
an experimental Cargo feature, `waiter-aware-memory-lock`, default off.

An independent waiter boolean/counter would introduce a second atomic variable
and a cross-variable registration/notification race requiring more ordering.
Thread-count experiments remain possible but do not remove unconditional notify.
Lock batching, native multi-memory and runtime separation require broader changes
to memory-access boundaries and are outside this experiment.

## Integration boundaries

### WVL library

Base the work on the current 0.10.0 source in an isolated development worktree.
Keep the library's MSRV 1.89.0 and edition 2024.

- `wasi_virt_layer/Cargo.toml`: declare the opt-in feature without enabling extra
  dependencies or implicitly enabling threading.
- `wasi_virt_layer/src/memory_lock.rs`: a private, `core`-only state machine using
  `AtomicI32` and a generic wait/notify backend. It is the actual implementation
  used by both production exports and native tests, not a duplicated test model.
- `wasi_virt_layer/src/shared_global.rs`: retain the static lock's shared storage,
  exported functions, guards and existing `wvl_atomic` imports. Delegate to the
  state machine with a zero-sized Wasm backend. Inline private forwarding helpers
  so this extraction does not add hot-path function-call layers.
- Compile the production module only where `shared_global` is currently enabled:
  `wasm32`, feature `threads`, and not feature `multi_memory`.

Internal boundary: `MemoryAccessLock` owns one `AtomicI32` and provides
`new`, `read_acquire`, `read_release`, `write_acquire`, and `write_release`.
The backend provides `wait(&AtomicI32, expected: i32)` and
`notify(&AtomicI32, count: u32)`. Generic dispatch must monomorphize; no allocation,
trait object or JavaScript callback is introduced.

The four `__wasip1_vfs_memory_lock_*` export signatures remain unchanged. Both
feature variants are compiled coherently; mixed baseline/candidate operations on
one lock are invalid. All users go through the existing exports/guards.

### Rubrc and CLI

The CLI generator's lowering and ABI names are unchanged. Continue using the
pinned WVL CLI 0.10.0; the experiment changes its input VFS library implementation.
Compile both variants against the same pinned experimental WVL library revision,
using a CI-only dependency override. Keep the normal registry dependency intact
outside the experimental checkout.

Forward the opt-in feature through the VFS crate in the disposable CI checkout.
Cargo validates the dependency-feature reference even when disabled, so this
forwarder cannot be added to the normal registry-backed manifest. Both experimental builds must
record `wvlRevision` (the exact 40-character commit) and `memoryLockMode`
(`baseline` or `waiter-aware`), alongside the existing analyzer revision, core
optimization and initial-heap metadata. Check Cargo feature resolution for the
actual VFS build, including feature unification across workspace dependencies.
Reject a claimed candidate if dependency resolution or generated code does not
confirm the selected implementation.

## State representation: feature enabled

One `AtomicI32`, initially zero:

| State | Meaning |
| --- | --- |
| `0` | Unlocked, no registered writer |
| `1..=MAX_READERS` | That many readers, no registered writer |
| `WAITING \| n` | `n` readers and a sticky writer-waiting marker |
| `-1` | One writer owns the lock |

`WAITING = 1 << 30`; `MAX_READERS = WAITING - 1`. A nonnegative state's low
30 bits hold the reader count. Other negative values are invalid. Never increment
a saturated reader count into the marker or sign bit: retry with `spin_loop`
until a reader slot becomes available. Saturation is not a parking condition,
so it does not create reader waiters lacking a writer-release broadcast.

The marker is conservative, not a count of writers. It is cleared only by
successful writer acquisition (replacing the entire word with `-1`) and the
subsequent writer release to zero. The lock API has no cancellable writer wait.

## Operations

### Read acquire

1. Load the word with Relaxed ordering.
2. If nonnegative and not reader-saturated, CAS `old -> old + 1` with Acquire
   success / Relaxed failure. This preserves the waiting marker.
3. Retry on CAS failure; return on success.
4. If a writer is active (`-1`), wait32 on that exact value, then retry.

Reader preference is retained: the marker alone does not prevent new readers.
The design does not promise writer fairness under an unending reader workload.

### Read release

1. `old = fetch_sub(1, Release)`.
2. Notify one waiter **only if `old == (WAITING | 1)`**.

The no-writer path still performs just the existing atomic decrement, with a
different comparison constant. It does not load a separate waiter counter.
Balanced acquire/release is an existing API precondition.

### Write acquire

Repeat after a Relaxed load:

- For `0` or exactly `WAITING`: CAS that exact state to `-1` using Acquire
  success / Relaxed failure; return only on success, otherwise retry.
- For a positive reader count without the marker: CAS `old -> old | WAITING`
  with Relaxed ordering. On failure retry from a fresh load; on success use the
  marked value as the expected wait32 value.
- For a positive reader count already carrying the marker: use the observed
  marked value as the expected wait32 value.
- For `-1`: wait32 on `-1`.

After any wait return, retry the entire acquisition decision. Never park on zero
readers (`0` or `WAITING`): attempt acquisition instead. Every wait uses the
current state's address, and wait32 must atomically compare-and-park.

### Write release

Store zero with Release ordering, then notify all waiters, as in the existing
implementation. Readers and writers share the wait address; this broadcast is
retained even though read release becomes selective.

### Feature disabled

Retain the original count-only protocol and unconditional last-reader notify.
The waiting bit is never set or interpreted in this variant. Default feature
selection must preserve the existing no-writer notification behavior, enabling
an honest baseline built from the same source revision.

## Why notification cannot be lost in the key races

1. **Last reader leaves before writer registers.** Registration CAS against the
   old reader count fails. The writer reloads and acquires the zero-reader state
   instead of sleeping. No notification was needed.
2. **Writer registers before last reader leaves.** The final decrement observes
   the marker and notifies one. If the writer has not parked yet, wait32 sees a
   different value and does not sleep. If it is parked, notify wakes it.
3. **Reader count changes back to the expected value (ABA).** The marker remains
   set. A late waiter may park on the new reader population, whose final release
   must notify. If a writer acquired in between, its release broadcasts.
4. **Multiple waiting writers.** Last-reader notify wakes one; a successful writer
   release wakes all remaining waiters. Awakened writers retry and re-register
   if a new reader population won the race. A writer that has not parked rechecks
   the exact state through wait32 and the loop.
5. **Reader arrives during a write.** It waits only on `-1`. Writer release always
   broadcasts. A late wait either sees a changed state or belongs to a subsequent
   writer epoch that also ends with a broadcast.

Progress assumes eventual scheduling of runnable threads and eventual release by
holders. The optimization provides no cancellation, trap recovery or fairness
guarantees beyond those of the existing lock.

Acquire/Release orders continue to publish relocated data and updated offsets.
Registration is an RMW on the same word and preserves its release sequence; it
does not itself grant access. A notification is never the operation that grants
ownership or establishes the memory-access critical section.

## Verification requirements

### Native protocol tests: actual production state machine

Create a dependency-free native harness at
`wasi_virt_layer/tests/memory_lock_protocol.rs`, importing the core-only module
by path. It must be runnable directly with `rustc --test --edition=2024`, both
with and without `--cfg 'feature="waiter-aware-memory-lock"'`, avoiding a full
WVL/CLI build on the faulty local host.

Use deterministic barriers/hooks to pause immediately before registration,
immediately before compare-and-park, and after wakeup. The pre-registration hook
belongs in the actual state machine behind `cfg(test)`; wait/notify hooks belong
in the test backend. These scheduling hooks must not exist in production builds.
A native wait adapter must serialize its expected-value check and park registration with
notification; a bare check followed by an unrelated Condvar wait is incorrect.
Use watchdog failures rather than periodic timeout wakeups that would conceal a
lost notification. Keep native correctness tests small; run stress tests in CI.

Required observable cases:

- Sequential and overlapping readers with no writer: candidate notifies zero
  times; baseline notifies once per transition to zero readers.
- All three registration/release/ABA races above complete without a watchdog.
- Multiple readers exclude a writer; a writer excludes every reader/writer.
- At least two waiting writers and a reader complete across writer-release
  broadcasts and a new reader population.
- Spurious wait returns and CAS retries preserve exclusion/progress.
- Saturated count does not modify the marker/sign bit or return ownership.
- Protected paired payload values remain consistent across repeated handoffs.
  Use atomic test payloads to avoid undefined behavior if the lock is broken.

The first notification-count regression must fail against the existing
unconditional last-reader behavior before implementing the candidate. Verify the
feature-off generated hot path still has the original count-only algorithm and
no added state-machine forwarding calls before using it as the performance
baseline.

### Generated WASM integration: hosted only

Add a focused CLI fixture using existing `utils::run_wasi_virt_layer`,
`OutDir::Random`, `--own-memory` and `--validate`. Exercise concurrent guest
access while **physical reservation relocates a guest region**; logical
`memory.grow` within reserved capacity is not sufficient coverage. Verify
sentinel data, completed reader/writer operations and clean termination, with an
outer timeout treated as failure.

Use the existing thread-pool/runtime machinery. Add no JS Atomics,
SharedArrayBuffer operations, WIT lists or Rust-to-JS-to-Rust reentrant calls.
The CI preflight must require its WASI targets; existing test helpers sometimes
skip missing targets, and that must not count as acceptance.

Inspect the final core to verify unchanged lock exports, a last-reader notify
guarded by the marker, and no unexpected extra hot-path calls. The existing
threaded own-memory pool and atomic-wait-reset tests must also pass. The two
non-threaded own-memory reset cases remain visible diagnostic runs, alongside
the untouched 0.10.0 control, under the explicit user-approved scope exception.
They are not reported as passing and do not waive any threaded check.

## Coupled build and paired desktop acceptance

Heavy builds, optimization and browser profiling run only on GitHub-hosted CI.
Use Bun, pinned `nightly-2026-09-13`, WVL CLI 0.10.0 and the existing standard
runner/swap setup. Do not run `bun run vfs:truebuild`.

Produce baseline/candidate core, generated bindings, cache and page as coherent
sets from one rubrc/analyzer/WVL revision tuple, differing only in the lock
feature. Generate each stdlib cache with its distributed WASM analyzer. Keep O1,
512 MiB initial heap, main-pool threads and readiness behavior identical.
Retain manifests/checksums for both sets; if the old preview artifacts expire,
build a fresh feature-off baseline rather than silently changing comparison data.

For the performance decision, replay both verified sets sequentially on one
runner in fresh browser processes. Record CPU model, browser/tool versions,
actual worker counts and build identities. Run normal-network startup and editor
checks in A–B–B–A order: each session contains cold load, reload, completion and
type-error diagnostic checks. Keep CPU sampling off for the primary timing
comparison; OS process-memory observation may be identical in all sessions.
Capture a separate candidate CPU profile only if correctness passes and the
timings justify attributing the change.

Report every run, median and range of post-sysroot/semantic-warming durations,
completion/diagnostic latency and peak sampled RSS. Accept the experiment only
when every correctness/acceptance check passes and both candidate session
medians are below both baseline session medians for semantic warming. Overlapping
results are inconclusive, not an optimization success; investigate before
spending on additional full builds. A positive experiment supports a follow-up
rollout decision, not automatic default enablement.

Do not weaken the versioned-diagnostics/inlay readiness gate, remove the existing
didClose/didOpen sequence, alter cache fingerprints or source-root/dependency
ordering, or add startup/DB/sysroot parallelization. Public deployment and
main/develop updates are outside this experiment.

## Review and implementation handoff

Review this specification before writing the detailed implementation plan. The
implementation plan must cover the core protocol, native race tests, generated
WASM relocation test, experimental dependency/feature wiring, and paired replay
as independently verifiable tasks. Commit messages disclose AI assistance;
stage only intended files and preserve existing local generated-file changes.
