# Independent review: actual-source Loom harness

2026-11-26 JST. Independent read-only code/evidence review; no production, harness, runner, or dependency edits by this reviewer. The implementation agent performed the expanded run and the parent independently reproduced it; this reviewer did not start duplicate builds.

## Verdict

**Accept as bounded actual-source ordering evidence.** The harness executes instrumented production lock methods, with a deliberately substituted backend and selected initial execution prefixes. No alternate happens-before path masking the payload assertions was found. Both final runs passed all four cases with nonzero, equal started/completed counts. This is not an arbitrary-execution theorem, full C11/Rust verification, or proof certificate.

Evidence inspected:

- [Implementation-agent expanded results](<results/actual-20261126T055136.995248Z/summary.json>).
- [Parent's independent reproduction](<results/actual-20261126T055232.991202Z/summary.json>).
- Both directories contain raw command logs and snapshots of the source, harness, build script, transform, dependency lock, and runner.

| Feature | Case | Started = completed, both runs | Payload assertions per completed execution |
|---|---|---:|---:|
| Legacy | writer release → reader | 5 | 1 |
| Legacy | two reader releases → writer | 840 | 2 |
| Waiter-aware | writer release → reader | 5 | 1 |
| Waiter-aware | two reader releases → writer | 1,715 | 2 |

All recorded commands—including rustc/Cargo version and Git metadata commands—exited zero, with no process timeout. No stale-payload or branch-limit assertion occurred. Individual test logs confirm exactly one selected test ran, rather than a zero-test Cargo success. Expanded runs use the equivalent reproduction procedure, from the root repository:

```sh
python3 verification/memory-lock-ordering/actual_runner.py \
  --max-permutations 10000 --max-duration 30 --test-timeout 60
```

The runner records exact build and test commands; it builds both feature configurations with `cargo test --locked --no-run`, then runs each exact test separately. Dependency/build caches are local to the harness. Toolchain is rustc 1.98.1 (`48a229cea`, 2026-09-01); detailed tool output is retained in the two result directories.

## Actual-source correspondence

Reviewed [transform](<actual-harness/source_transform.py>), [build script](<actual-harness/build.rs>), [test harness](<actual-harness/src/lib.rs>), [runner](<actual_runner.py>), and [manifest](<actual-harness/Cargo.toml>).

The transform checks the entire production input hash first and requires each of exactly three literal replacements to occur once:

1. Core atomics become Loom atomics.
2. The constructor loses `const`, required by Loom initialization.
3. The production test-module inclusion is removed, excluding unrelated native tests.

No lock operation, state constant, memory ordering, control flow, or feature-dependent method branch is rewritten. Cargo's build script reruns the transform when source/transform changes and includes the generated file as a module. Test-only hooks remain present with their default no-op implementations. This is stronger source correspondence than the handwritten litmus, but deliberately differs in atomic implementation, backend, and tested environment.

Target revision: `77f45543eb976e4e7843e78fcd67bd837acac6bd`.

| Reviewed artifact | SHA-256 |
|---|---|
| [Production lock](<.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs>) | `d9c08f4561376fbe356d67ca8451e99fcdb9c79c29d78bbf7bb82a651a896961` |
| [Generated instrumented source snapshot](<results/actual-20261126T055136.995248Z/source/memory_lock_instrumented.rs>) | `dd97b92d0feba42220492da94c3a3246f9a3337b4366db95b4f33cd9e60fc1c9` |
| [Harness](<actual-harness/src/lib.rs>) | `5fa0c31e78525e4b18376299813fea8b19e8df08e4981a6ffc22e5d5b9e348a0` |
| [Transform](<actual-harness/source_transform.py>) | `7a61ed3329505beaf5116b6eadc1969961499ca3bd412d4f5ea67b4b341fd567` |
| [Build script](<actual-harness/build.rs>) | `a0419326657fe86a1653879736ba2c36748226a3ae604251ef0e97c959014103` |
| [Runner](<actual_runner.py>) | `40a268d7896f09b542322e99fa7453f24c6a02f0e622ac87a36904e9ad168d62` |
| [Dependency lock](<actual-harness/Cargo.lock>) | `3b90c0fdd7e323c9797fbf022153a6f6d5e98d269fac9566cba3ab508fa1b937` |

## Happens-before / masking audit

### Writer to reader

The main thread acquires the writer lock before spawning the reader. This establishes a selected locked prefix and ensures the reader cannot consume an earlier unlocked epoch. Crucially, main stores the payload **after** spawning the reader. Spawn therefore cannot publish the tested payload store. The reader acquires using the actual method and performs its relaxed payload assertion before releasing and returning. Main joins only afterward, so join does not justify the reader's assertion. No auxiliary synchronization masks the tested Release/Acquire edge.

### Two readers to writer

Main acquires two logical read permits before spawning the workers. This is legitimate as a reduced lock-level usage model because the lock has no thread-local ownership, but is not a test that each worker executes its own `read_acquire`. The permits are transferred to two worker actors; each writes a distinct atomic payload and executes actual `read_release`. The separately spawned writer executes actual `write_acquire`, then checks both payloads before its release/return.

The initial Acquire operations in main precede the worker payload writes, so they cannot import and republish those later writes. Neither reader worker acquires after the other's payload publication. Main joins the writer first, and all workers were already spawned before any join. These joins do not create reader-to-writer publication. Distinct relaxed atomic payloads keep failure observations defined and avoid non-atomic races. Reader payload side effects are instrumentation, not permission to mutate relocation metadata under a shared lock.

Host counters are measurement only. The completion counter increments after the entire test closure, and each closure necessarily executes its payload assertions; equality of nonzero started/completed counts confirms assertions were reached rather than skipped conditionally. The printed assertion count is inferred from the case, not independently instrumented at each assertion, but that inference matches the inspected control flow.

## Bounds, coverage, and backend limitations

Final bounds: four threads including main; preemption bound two; 128 branches per execution; at most 10,000 permutations; at most 30 seconds Loom checking per case; checkpoint interval one; 60-second process timeout for each test. The runner strips inherited `LOOM_*` variables and sets its own verification limits.

Final observed counts are below the permutation cap and elapsed model times below 0.5 seconds, far below 30 seconds. With the inspected [Loom 0.7.2 model loop](https://raw.githubusercontent.com/tokio-rs/loom/v0.7.2/src/model.rs), these final passes completed the explored **preemption-bounded** state space rather than terminating at the duration/permutation cap. The earlier 1,000-permutation run's waiter-aware case stopped at 999 executions; it must not be described as complete exploration. The final expanded evidence supersedes that limitation, not the persistent preemption bound. Loom checks caps before some iterations, so a configured cap is not an exact promise of that many executions.

`YieldBackend.wait` yields regardless of expected state; `notify` does nothing. This is intentionally **not** atomic compare-and-park and does not implement the production backend contract. It provides an always-retrying environment for ordering checks. There is no actual waiter registration, wait-set management, wakeup edge, or OS/Wasm interaction. Thus the run cannot establish lost-wakeup freedom, compare-and-park correctness, notification sufficiency, blocking correctness, fairness, or starvation freedom. It also does not supply synchronization that could hide a missing lock ordering.

There is no marker-hit or successful marker-interleaving counter. Running the waiter-aware configuration establishes bounded checks of that implementation but does not by itself evidence that a specific marker-between-reader-releases schedule was visited. The separately reviewed handwritten marker litmus isolates that ordering property; do not transfer its mutant sensitivity to the actual-source harness as if an actual-source mutation was executed.

The harness retains production weak CAS, but does not establish that Loom covers arbitrary spurious-failure behavior. Saturation and overflow are outside these small models. Loom's [documented relaxed-ordering limitations](https://raw.githubusercontent.com/tokio-rs/loom/v0.7.2/src/lib.rs) still apply; its supported model is not the entire C11/Rust execution set. The [runtime](https://raw.githubusercontent.com/tokio-rs/loom/v0.7.2/src/rt/mod.rs) limits history to seven atomic stores and threads to five. These cases use at most four threads and at most seven state modifications including initialization before the writer payload assertions (a final writer release can add another afterward); payload cells have only initialization plus one write. No claim about arbitrary long-lived histories follows.

## Minor runner issue / recommendation

The runner records but does not include the return values of version/Git metadata commands in its `all_invocations_passed` boolean. Here all those records explicitly show exit zero, so this does not affect the evidence. Future hardening should fail the overall run if required provenance commands fail, or name the aggregate narrowly as build/test success. Also retain inspection of exact test counts and completion counters: Cargo returning zero alone does not generally guarantee a matching test ran or an internal duration cap was not reached.

No production changes are recommended by this review. The accepted claim is that these two actual-source usage scenarios exhibited correct atomic payload publication under the stated Loom model, bounded scheduling, and substituted backend.
