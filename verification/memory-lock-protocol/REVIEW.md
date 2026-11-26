# Independent review: WVL lock protocol SC model v2

Date: 2026-11-26, independently reproduced at 05:14 UTC. Reviewer examined production source, native regression harness, v1 and v2 checker; did not modify production source or checker. Parent subsequently authorized these new evidence files.

## Outcome and reproduction

**PASS within the stated finite SC model. Not a Rust weak-memory proof, fairness proof, or composition theorem.** No concrete production SC protocol bug found in the reviewed source. The independent rerun matched the parent's v2 JSON exactly after removing only `elapsedSeconds`.

Run from `/home/oligami/projects/rubrc`:

```sh
python3 -B verification/memory-lock-protocol/protocol_check.py --output verification/memory-lock-protocol/review.json
```

Observed exit 0; Python 3.14.4; Linux-7.0.0-44-generic-x86_64-with-glibc2.43. Raw rerun: [review.json](<review.json>). Comparison reference: [protocol-results-v2.json](<protocol-results-v2.json>). Checker: [protocol_check.py](<protocol_check.py>), SHA-256 `ad0d11f55f5b1e63ad26ff45597e1780c242c8355b307661b6df1d4459d8c7ab`.

Comparison procedure: parse both JSON files with Python `json.loads`, remove `elapsedSeconds` from each, assert remaining dictionaries equal. Sum `states` and `transitions` across `cases`. Observed: 20 scenarios, 67,185 scenario-local states and 268,308 transitions, all passing; all reachable states in each case have some path to completion. These totals include repeated/common states across scenarios, not globally unique states. All six intentionally faulty mutants are rejected with counterexample traces.

Largest waiter-aware RRRRW scenario: 40,421 states, 170,708 transitions, 56 saturation retries, 2,268 notify-one-reader choices. Coverage counters count emitted transition opportunities across explored states, not distinct real executions or empirical probabilities. `releaseWhileMarkPending` need not mean the last reader released; `waitMismatchAfterRelease` is classified by current free word, not explicit historical provenance. There is no dedicated ABA-history coverage counter.

Production worktree verified clean at commit `77f45543eb976e4e7843e78fcd67bd837acac6bd` before and after review. Source SHA-256:

- [memory_lock.rs](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs>): `d9c08f4561376fbe356d67ca8451e99fcdb9c79c29d78bbf7bb82a651a896961`
- [shared_global.rs](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/shared_global.rs>): `d79c006d0ce5859f225fc8b8918f638eea2b8f9c582eba997ac79868527b24bb`
- [memory_lock_cases.rs](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/tests/support/memory_lock_cases.rs>): `6d67a702d7b910d6c8880b07ddc4a3febfc10375a16eb3ba175796e747b7cd6a`

## Source-to-model mapping

| Production operation | Checker transition | Review |
| --- | --- | --- |
| [reader relaxed load, saturation, weak acquire CAS:44–65](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L44-L65>) | [L/C:65–84](<protocol_check.py#L65-L84>) | Load and CAS separated; old word retained; nondeterministic weak failure permitted even on matching comparison. Shrunk marker 4/cap 3 rather than production bit 30. |
| [baseline writer strong CAS:77–87](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L77-L87>) | [L:72–74](<protocol_check.py#L72-L74>) | One atomic strong CAS action, no artificial separate load or spurious failure. Failed CAS retains observed nonzero word for wait. |
| [candidate load/acquire/register:89–125](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L89-L125>) | [L/C/M/Q:75–100](<protocol_check.py#L75-L100>) | Free 0 or MARK acquired to -1; registration CAS only succeeds on exact loaded count; marker retained in wait expectation. |
| [compare-and-park contract:19–22](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L19-L22>) and [Wasm import adapter:36–49](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/shared_global.rs#L36-L49>) | [Q→P:93–100](<protocol_check.py#L93-L100>) | Single atomic compare/register event; mismatched value retries. Backend correctness assumed, not proven. |
| [last-reader RMW release:69–73](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L69-L73>) | [H→N/finish:103–108](<protocol_check.py#L103-L108>) | Decision based on pre-decrement word. Notify separately interleavable. |
| [writer release store then broadcast:130–133](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L130-L133>) | [H→N and N:109–119](<protocol_check.py#L109-L119>) | Separate release and notify; broadcast selects every parked waiter irrespective of role or remembered expected word. |

Model owners are exactly H threads; leaving H linearizes release, even if N notification remains pending. Completion budgets decrement only after the required notify. This faithfully avoids treating a paused notifier as a terminated thread. Wake-one enumerates every parked recipient, including readers. Woken waiters restart their loop; they do not acquire implicitly.

Reverse reachability [127–136](<protocol_check.py#L127-L136>) is correctly implemented: all emitted edges, including revisits/self-loops, are recorded backward; the search is seeded with all all-D states and traverses predecessor sets. Equality of backward-reachable count and reachable-state count establishes **every reachable state has at least one finite path to all-D**. The terminal word check now requires 0, correctly stronger than allowing an orphan MARK once all writer operations have completed.

## Critical races and interpretation

1. **Registration after last-reader exit:** the mark CAS must fail if its observed count changed to zero. An unconditional store can resurrect a nonexistent reader. The mark-store mutant is rejected by reader-count consistency.
2. **Reader-count ABA:** marker remains after last-reader release. A new reader may restore the exact marked count before a writer parks; the future last-reader departure still notifies. Clearing the marker on last-reader release would invalidate that argument. The actual-source [ABA regression:172–191](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/tests/support/memory_lock_cases.rs#L172-L191>) deliberately forces the cycle; repeated-operation model cases permit it but lack a history-specific coverage witness.
3. **Notify-one can select a reader:** not itself a production bug. Readers only park after seeing -1. A parked reader coexisting with new readers must have an active writer/recent writer history with a pending broadcast (or another writer acquisition/release cycle). Production writer release broadcasts to all, providing the outstanding wake obligation. Never assume a last-reader notify necessarily chooses a writer. The model explores reader recipients. The writer-notify-one mutant demonstrates why broadcast matters: wake reader, leave writer parked, reader exits unmarked, no future notifier.
4. **Notify before actual park:** Q atomically checks expected word, avoiding check/register gap. The split-wait mutant reaches a real all-parked terminal deadlock.
5. **Delayed old notifications:** notification is not tied to a remembered value; it can wake a later generation of waiters at the same address. The model correctly uses current P membership rather than expected-value matching.

## Assumptions and outstanding risks

- The explored universe is a manually transcribed, finite **sequentially consistent atomic-word model**, not executable Rust semantics. Relaxed observations are current SC word values, not weak-memory stale reads. It does **not** prove Rust Relaxed/Acquire/Release ordering, release-sequence correctness, compiler lowering, publication of protected memory, or Wasm backend synchronization. The source's relaxed marker CAS release-sequence rationale needs its own language/target argument.
- Candidate cap is reduced from 2^30−1 to 3; no parameterized proof relates all real counter sizes to this small domain. Baseline uses Python integers and only four concurrent readers, not signed-i32 overflow. Actual-source saturation regression separately covers production boundary values with a synthetic decrement hook.
- Fixed thread roles, at most five participants, and precisely listed one/two-operation budgets; no theorem for arbitrary participants, more operations, same-thread read/write role switching, recursive acquisition, invalid/unbalanced releases, cancellation, traps while holding the lock, reset, address aliasing, or external interference.
- Weak-CAS failure cycles are explored but not assumed eventually to stop. Finite operation budgets bound successful requested operations, **not schedule length**. Every state having some completion path is existential non-stranding, not universal termination, fairness, bounded waiting, or starvation freedom. Infinite reader arrival is explicitly outside scope and production is reader-preferring.
- No spurious wait return in this model. Actual-source tests cover one early return; optional extra safety exploration could add such returns. Adding always-enabled spurious wakes to the sole deadlock search would incorrectly hide lost notifications; preserve the no-spurious gate if expanding it.
- Terminal deadlock means no modeled successor with unfinished threads. The separate reverse reachability property catches closed retry regions with no path to completion; it does not ban infinite retry cycles that have exits.
- Owner-count/exclusion checks do not model payload values, generated instruction placement, memory relocation, batching boundaries, or runtime exports. There is **no composition theorem** connecting this protocol graph to compiler transformations and relocated application behavior. Separate actual-source native tests and end-to-end Wasm relocation tests remain required.
- No concrete production defect identified. The review corrected v1's overly permissive terminal MARK and absence of a stronger no-stranding check; v2 addresses both.

## Preserve actual-source regression evidence

The existing standalone [memory_lock_protocol.rs:11–12](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/tests/memory_lock_protocol.rs#L11-L12>) imports production shared-global source, which imports production lock source, which imports the [native cases:136–138](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs#L136-L138>). Thus running the harness tests the actual implementation, not the copied Python transition system. Existing [CI commands:52–59](<../../.worktrees/wvl-lock-batching/.github/workflows/memory-lock.yml#L52-L59>) are lightweight:

```sh
rustc --test --edition=2024 wasi_virt_layer/tests/memory_lock_protocol.rs -o /chosen/evidence/native-baseline
/chosen/evidence/native-baseline --nocapture
rustc --test --edition=2024 --cfg 'feature="waiter-aware-memory-lock"' wasi_virt_layer/tests/memory_lock_protocol.rs -o /chosen/evidence/native-candidate
/chosen/evidence/native-candidate --nocapture
```

Run these from the production worktree; choose an existing persistent evidence directory, record `rustc -Vv`, commit/worktree state, exact commands, source hashes, stdout/stderr and exit codes for each mode. Expected test counts by source inspection: baseline 9 (8 core + export notification test); waiter-aware 11 (10 core + export). Native tests were **not run by this reviewer**; they must not be inferred from the Python PASS.

The Condvar backend [23–53](<../../.worktrees/wvl-lock-batching/wasi_virt_layer/tests/support/memory_lock_cases.rs#L23-L53>) locks its gate around compare/registration and notification, with a five-second watchdog. This provides practical native compare-and-park testing but is not a model of arbitrary memory-order behavior or a proof of runtime wait/notify imports. Preserve its existing race-specific and atomic-payload stress evidence separately; do not replace it with model-only tests.

## Recommended follow-ups, not blockers for this scoped model result

- Retain the six mutants and exact traces; additionally consider marker-clearing-on-last-reader-release and expected-value-filtered broadcast mutants to target sticky-ABA/broadcast assumptions directly.
- Add a deterministic ABA history witness/coverage assertion rather than implying current aggregate counters demonstrate that particular history.
- Add mixed operation sequences within a participant and optional spurious-wait safety exploration; separately maintain no-spurious deadlock tests.
- Maintain actual-source native and Wasm relocation/regression gates in both feature modes. Treat formal Rust weak-memory and compiler/runtime composition arguments as outstanding work, not established by this checker.
