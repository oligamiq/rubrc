# Stage4a: finite SC-atomic lock protocol model

Date:2026-11-26 JST. Target WVL77f45543eb976e4e7843e78fcd67bd837acac6bd. Follow-up to `../memory-lock-batching/README.md`: examine the internal lock previously assumed atomic/correct. This work does not change production source or enable batching by default.

## Exact claim and exclusions

Explicit-state BFS explores all reachable states and scheduler choices of the listed FINITE configurations of a hand-written sequentially-consistent (SC) atomic-word model. It checks mutual exclusion, correspondence of atomic word to owners, and absence of a reachable nonterminal state in which all remaining threads are parked. This is NOT a weak-memory proof of Rust Acquire/Release/Relaxed, an arbitrary-thread cutoff theorem, or fairness/starvation freedom. Unending reader arrivals may starve a writer, as production documentation already states.

Weak CAS failure is nondeterministic, including spurious failure at equal values. Hence the state graph contains retry cycles: exploring its reachable closure does NOT prove termination. A scheduler may indefinitely postpone an enabled notify or release; these are enabled operations, not deadlocks. All-parked deadlock is checked only when no enabled successor exists. No assertion that every thread eventually acquires follows.

The model trusts atomic compare-and-register parking and notification at one shared address. Park has no spontaneous wake/timeout/cancellation; production waits with infinite timeout. Wake-one explores every parked recipient, including readers, without fairness. Wake-all wakes every parked thread regardless of its saved expected value. Notifications are not persistent tokens. Woken threads re-enter acquisition loop and can lose races again.

## Machine and implementation mapping

Production `wasi_virt_layer/src/memory_lock.rs`:

-44–65 reader load/weak Acquire CAS or wait: model L/C/Q/P.
-69–72 reader Release fetch_sub then possible notify(1): distinct H->N->loop/done transitions. Decrement happens before notify, allowing intervening operations.
-77–87 feature-off writer strong CAS0->-1, failed comparison supplies actual word for wait.
-89–125 feature-on writer relaxed load, weak free-word CAS, relaxed sticky-marker CAS, atomic compare-and-park with retained expected word.
-130–132 writer Release store0 then broadcast: distinct H->N transitions, pending notification remains enabled until executed.

`shared_global.rs:36–49` delegates wait32(expected,-1 timeout) and notify(count) to imported Wasm atomics. CLI lowering/backend correctness is NOT modeled. Native tests use a different backend, documented separately.

Shared state is `(word, threads)`. Each thread stores its PC, observed word and remaining acquisition/release budget. Own flag is represented by H. PCs: L loop/load; C weak acquire CAS; M mark CAS; Q atomic compare-and-park; P parked; H critical section/owner; N pending notification; D completed. K exists only for deliberately broken split-park mutant. Successful acquisition is its ownership linearization point; release RMW/store relinquishes ownership before later notification.

The feature-on state uses WAITING=4, MAX_READERS=3 instead of production bit30/count2^30-1, so saturation is reachable with four reader threads. This is an explicitly SHRUNK state machine, not a theorem covering every30-bit count. Feature-off has no saturation guard in production; its finite model uses small mathematical integers and does NOT check overflow of the real i32 counter.

A waiting marker is sticky until successful writer acquisition replaces the whole word with-1. A last reader leaves WAITING, not0. Arriving readers are permitted despite the marker. Baseline last-reader releases always notify; aware last-reader releases notify only for old word WAITING|1. Base/data access and release-sequence visibility are outside this model.

## Finite configurations

Each mode (feature off/on) runs10 scenarios:

- One reader twice; one writer twice.
- RW, RRW, RWW, RRWW with one acquire/release per thread.
- RW with two operations each; RRW and RWW with first reader twice.
- RRRRW once each: reaches feature-on count saturation.

20 total scenarios; all enabled interleavings explored per scenario, not sampled. Aggregate state counts are summed per scenario, not globally distinct states. Models share no state between cases. No all-program or arbitrary-length claim.

## Invariants

1. At most one writer; writer and readers never simultaneously own.
2. Writer ownership iff word=-1; otherwise nonnegative count matches owning readers after masking aware marker.
3. Feature-on count never exceeds shrunk MAX_READERS.
4. Completed states have no owners and word0. A sticky marker is legitimate mid-execution but not after every balanced writer operation completes.
5. No nonterminal state lacks successors (all remaining threads parked).
6. V2 additionally computes reverse graph reachability: every reachable state has SOME finite path to completion. This excludes closed non-completing retry components, but still does NOT prove that every actual execution terminates or that scheduling/CAS is fair.

Native runtime traps, manual release misuse, process cancellation and invalid initialization are excluded. Each H thread may normally release. Critical-section payload is erased.

## Negative controls (not production bugs)

- `split_wait`: split compare from queue registration. Writer release+notify can occur between them, leaving a reader parked forever.
- `mark_store`: replace marker CAS with stale store. Last reader can leave before registration, then stale store fabricates a reader count.
- `omit_reader_notify`: parked writer remains asleep after last reader.
- `writer_notify_one`: replace broadcast with notify1. Wakes a reader while another writer remains parked; aware reader sees no marker and does not notify, producing stuck writer.

- V2 `ignore_acquire_comparison`: allow stale acquired value to succeed, exposing reader/writer overlap.
- V2 `omit_saturation`: disable count guard, exposing count/marker collision after fourth reader.

Controls show sensitivity to these faults, not completeness of checker validation. Counterexamples are BFS shortest under the model's chosen micro-events, not minimum real machine instruction traces.

## Reproduction

Python3 standard library only; no solver or installation:

```sh
python3 verification/memory-lock-protocol/protocol_check.py \
 --output verification/memory-lock-protocol/new-protocol-results.json
```

Use a NEW filename. Output includes individual counts, transition coverage, counterexamples, checker hash and Python version. Missed mutant or failed positive case exits nonzero. Initial raw results: `protocol-results-v1.json`. Independent review and further instrumentation may produce a new version; do not overwrite old evidence.

## Initial observation

Initial v1: all20 selected cases passed;4 faulty variants produced counterexamples. Source snapshot `protocol_check_v1.py` matches v1 result hash. Following independent review suggestions, v2 requires terminal word0, checks reverse reachability to completion, adds two controls and coverage counters. `protocol-results-v2.json` is current:20 scenarios pass,6 controls detected, all reachable states have a path to completion. Instrumentation demonstrates saturation retries, notification choosing a reader, reader release while writer registration is pending, and wait-value mismatch at a released word. Counts indicate transition opportunities, not probabilities/frequencies of real executions.

No spontaneous parked-wait return is modeled; this is an explicit restriction, not a general conservative abstraction for safety (spurious wake may introduce retries). A native regression covers one spurious wait return. Adding spurious wake as always enabled would hide no-successor deadlocks, so this model deliberately keeps its deadlock check separate. Threads have fixed roles; role-switching is outside scope.

A notify-one choosing a reader is not by itself a production bug: that reader parked while a writer held the lock, and the writer's broadcast obligation is still pending or an intervening writer will broadcast. Keeping store0 and notify_all separate is essential. The writer-notify-one mutation removes that obligation and does produce a counterexample.

Actual-source native regressions are recorded in NATIVE.md; they complement but do not replace formal reasoning about weaker memory orders. V2 independently reviewed and reproduced exactly except runtime duration; see REVIEW.md and review.json. No production SC bug identified within scope. Note coverage names are shorthand: releaseWhileMarkPending need not be the last reader; waitMismatchAfterRelease checks current free word, not history. No dedicated ABA-history witness is claimed.
