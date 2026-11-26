# Independent review: finite Loom release-sequence litmus

Date: 2026-11-26 (independent run began 05:47:12 UTC / 14:47:12 JST).
Reviewer: delegated independent design/source review; no production or harness source edits.

## Verdict and evidence

**PASS within the stated finite Loom model, with source-correspondence qualifications.** Both positive models completed without stale-payload assertions; all three negative controls independently exposed stale `0` instead of `42`. No masking synchronization or vacuous baseline pass was found. This is experimental model-checking evidence, **not a proof certificate, full C11/Rust verification, or execution of the actual lock methods**.

Independent reproduction, from `/home/oligami/projects/rubrc`:

```sh
python3 verification/memory-lock-ordering/run_litmus.py \
  --output-dir verification/memory-lock-ordering/litmus-review
```

The runner performs an offline locked Cargo build and invokes each scenario with a 180-second process timeout. Its exact commands, platform/compiler details, source hashes, and raw stdout/stderr hashes are saved in [independent results](<litmus-review/results.json>); the logs are siblings of that file. The runner and every subprocess exited zero, with no timeout. Mutant subprocesses intentionally catch the specifically expected `STALE_PAYLOAD` assertion and exit zero only when it is observed.

| Scenario | Model executions started | Successful acquisition observations | Independent outcome |
|---|---:|---:|---|
| direct | 63 | 42 | No stale payload found |
| direct_no_release | 1 | 1 | Expected stale 0 instead of 42 |
| direct_no_acquire | 1 | 1 | Expected stale 0 instead of 42 |
| marker_rmw | 24,511 | 5,057 | No stale payload found |
| marker_store | 19 | 1 | Expected stale 0 instead of 42 |

These equal the parent's [initial results](<litmus-results-v1/results.json>). Counts are model executions, not unique hardware schedules. Negative controls stop at their first counterexample.

Environment: Linux 7.0.0-44-generic x86_64, glibc 2.43, Python 3.14.4, rustc 1.98.1 (`48a229ceaefd4985c50990b14116b6d856af0985`), LLVM 22.1.8. Inspection of environment variables whose names start with `LOOM_` returned `{}`. Builder configuration is four threads including main, 1,000 branches per execution, no permutation or preemption cap; no branch-limit panic occurred.

## Exact reviewed identities

Root repository HEAD observed: `c67ba373aa856119dcb44c181738d2c953301962`.
Target WVL worktree HEAD observed: `77f45543eb976e4e7843e78fcd67bd837acac6bd`.
The following SHA-256 identities anchor this review independently of later edits:

| Input | SHA-256 |
|---|---|
| [Production lock](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs>) | `d9c08f4561376fbe356d67ca8451e99fcdb9c79c29d78bbf7bb82a651a896961` |
| [Litmus source](<litmus-harness/src/main.rs>) | `9b686ac9dded4e98981444b8fc316d1f4b974cdebcc19b5f858db7b0e3294769` |
| [Manifest](<litmus-harness/Cargo.toml>) | `c966d64a151666f7d40bb944e187312a81abfa3207e108b3ca36179a225bba0a` |
| [Dependency lock](<litmus-harness/Cargo.lock>) | `4dff8b5b907a160ba428e4166aa0c75146c0100bb273ffbf6ca5b22846eed563` |
| [Original runner preserved after review](<run_litmus_v1.py>) | `dd03b8993b92f8ca00e363983702e256c9f9ad6181a2894c7d94d27a7e4e3db4` |

Loom is pinned to exactly 0.7.2; its registry checksum is `419e0dc8046cb947daa77eb95ae174acfbddb7673b4151f56d1eed8e93fbfaca`. Locally inspected implementation files:

- [Loom atomic implementation](</home/oligami/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loom-0.7.2/src/rt/atomic.rs>): SHA-256 `bb0bb575cd531c5cce14feef1f155b4d0c80e69a1985c5d42d618cece0081dc6`.
- [Loom synchronization implementation](</home/oligami/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loom-0.7.2/src/rt/synchronize.rs>): SHA-256 `d3d1f858dd94a1f10704bb011caa79b5729e8720a437782f0528ad522d21129b`.

## Why the marker experiment distinguishes the ordering

The selected initial prefix has state `2` and two reader slots already held. Publisher writes atomic payload then releases `2 -> 1`. Writer registers `1 -> 5` using a Relaxed RMW. Last reader releases `5 -> 4` using a Release-only RMW. The same writer finally acquires `4 -> usize::MAX` and checks payload inside that thread.

The first-reader release heads a release sequence. Each succeeding RMW carries that sequence even when its own read part is Relaxed. Consequently the final Acquire observes publication through the chain. A later Release operation is **not** an Acquire and does not independently learn another actor's payload. With a plain marker store inserted, the sequence from the publisher is broken; the final reader's Release can publish its own prior effects but cannot recreate the lost publisher happens-before edge. This addresses the original concern that the last-reader Release might make the marker distinction tautological.

The [Loom atomic source at v0.7.2](https://raw.githubusercontent.com/tokio-rs/loom/v0.7.2/src/rt/atomic.rs) implements precisely this distinction: ordinary store begins with `Synchronize::new()`, while successful RMW copies the predecessor's synchronization object before storing. The [synchronization source](https://raw.githubusercontent.com/tokio-rs/loom/v0.7.2/src/rt/synchronize.rs) makes `sync_load(Relaxed | Release)` a no-op; Release stores union the current actor's causality with existing synchronization metadata. It does not turn a Release-only reader into an acquiring reader. Failed CAS uses Relaxed failure ordering throughout this litmus.

This cross-thread plain-store breakage does not depend on historical C11/C++11 versus C++20 differences concerning same-thread ordinary stores in release sequences: the marker writer is not the publisher. Loom's copied-metadata implementation should not be extrapolated into full support for every historical release-sequence definition or fence interaction.

## Masking and vacuity audit

- Publisher, observer, and last reader are separate spawned actors. Spawning gives them initial main-thread state, not the publisher's later payload side effects. Main never learns publisher effects and then spawns the observer.
- Main joins actors only after all have been spawned. A main-thread join does not publish those effects backwards into an already-running observer. The payload assertion itself occurs before observer completion/join, not as a new main-thread load after joins.
- No channels, mutexes, helper Acquire flags, fences, or extra last-reader Acquire introduce an alternate publication edge.
- Host atomics count executions and successful acquisitions only. They are not read for modeled control flow or used to publish payload; they supply no modeled happens-before edge. The baseline requires nonzero acquisition observations, which were substantial in the independent run.
- Marker mutant first loads state `1` Relaxed and then stores `5`. In this restricted model no other actor can change `1` during that gap: the last reader only attempts `5 -> 4`. The mutation therefore does not fail merely because of stale-count overwrite. Its stale-payload observation is meaningful release-sequence discrimination.
- The publisher's assertion that its `fetch_sub` sees `2` is safe in this selected slice: neither other actor changes initial state `2`.
- Direct mutants independently remove Release and Acquire, demonstrating that the direct baseline is not enforced by incidental instrumentation.
- Unexpected panics fail the harness; only a panic containing the expected stale-payload marker satisfies a mutant. Atomic payload keeps the stale observation defined rather than introducing an unchecked non-atomic data race.

## Source correspondence and exclusions

Production references are [reader release](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L69-L73>), [writer acquire and marker CAS](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L89-L125>), and [writer release](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L129-L133>). The reviewed [experiment explanation](<LITMUS.md>) correctly labels these handwritten slices rather than lock method execution.

Necessary qualifiers:

1. Direct initial token `1` is generic message passing, not production writer-held sentinel `-1`. It supports the ordering principle, not exact direct source execution.
2. Marker `4` and unsigned sentinel are symbolic encodings; no saturation, signed domain, overflow, or arbitrary reader-count theorem is tested.
3. State `2` assumes a reachable held-readers prefix. Readers can have acquired before publisher payload write, avoiding an acquiring last reader that would mask the mutation. This prefix is not constructed through real lock methods here.
4. Last-reader conditional CAS selects the successful `fetch_sub` transition; it intentionally omits other releases and retry paths. Strong CAS omits weak-CAS spurious failures.
5. Reader atomic payload is instrumentation for prior side effects/in-flight work publication, not permission to mutate protected relocation metadata under a shared lock.
6. No actual parking, notification, lost-wakeup, fairness, starvation, reclamation, compiler transformation, native hardware, or Wasm-engine behavior is verified.

## Tool limits and resolved runner hardening finding

[Loom's own documentation](https://raw.githubusercontent.com/tokio-rs/loom/v0.7.2/src/lib.rs) explicitly says some relaxed and cross-atomic reorderings cannot be modeled. Completed exploration is exhaustive only within this finite program and Loom's supported model. It is not the entire C11/Rust execution set.

[Loom runtime limits](https://raw.githubusercontent.com/tokio-rs/loom/v0.7.2/src/rt/mod.rs) are five threads maximum including main and seven remembered atomic stores per cell. This harness uses at most four threads and five state stores including initialization, so history truncation is not needed for these cases. These small-case checks do not establish correctness under unbounded loops or arbitrary execution history.

An initial reproducibility finding: [Builder initialization](</home/oligami/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loom-0.7.2/src/model.rs#L74-L127>) inherits `LOOM_MAX_DURATION` and `LOOM_CHECKPOINT_FILE`, and the Rust harness does not explicitly clear them. A duration limit can return normally without finishing exploration. This does **not** invalidate this independent run: no `LOOM_*` variables were set, and it reproduced the complete baseline counts.

**Resolved for the supported runner invocation during review:** the parent preserved [the original runner](<run_litmus_v1.py>) with the exact original hash, then changed [the current runner](<run_litmus.py#L20-L26>) to remove and record every `LOOM_*` environment variable before executing build/scenario subprocesses. I independently inspected the diff and verified its new SHA-256 `a0f09cdee513c85883a746fce3fdf6357908286ae23fe17aa3fc09671b8f5417`. The Rust harness remains byte-identical. The parent's [v2 result](<litmus-results-v2/results.json>) explicitly records removal of injected `LOOM_MAX_DURATION=1` and `LOOM_CHECKPOINT_FILE=/nonexistent/ignored-loom-checkpoint`; all outcomes and counts equal the independently reproduced v1 run. This v2 run was performed by the parent and reviewed here, not claimed as a second independent execution. Direct invocation of the binary still inherits Loom environment defaults; use the sanitized runner for reproducible complete exploration. No harness or runner code edits were made by this reviewer.
