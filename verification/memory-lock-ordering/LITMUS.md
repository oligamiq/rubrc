# Stage5a: Loom memory-ordering litmus exploration

2026-11-26 JST. Target conceptual source: WVL77f45543eb976e4e7843e78fcd67bd837acac6bd, `wasi_virt_layer/src/memory_lock.rs`. These are handwritten finite litmus slices, NOT calls to actual lock methods. Actual-source instrumentation is a separate experiment.

## Question

Do writer/reader Release operations publish payload to successful Acquire operations, including when a Relaxed marker RMW intervenes? Can a deliberately weaker ordering or plain marker store expose stale payload despite the same state values?

## Tool and limits

Pinned Loom0.7.2 via committed Cargo manifest/lockfile. Loom explores schedules and modeled atomic observations, unlike previous SC checker. It is a testing/model-exploration tool, NOT a full Rust/C11 proof assistant. Its [own limitations](https://github.com/tokio-rs/loom/blob/v0.7.2/README.md#unsupported-features) explicitly state missing C11 load-buffering executions and incomplete SeqCst modeling. No SeqCst operations used here; unsupported relaxed behavior still prevents a general no-bug theorem. Compiler, Wasm engine and actual wait/notify are not checked.

Builder sets max_threads4 (main included), max_branches1000 per execution, no preemption bound and no permutation cap. Finite one-shot operations, no spin loops, fit this branch ceiling without overflow panic. Positive runs finished their Loom exploration; mutants stop at first expected STALE_PAYLOAD assertion. A branch-limit panic, unrelated panic, timeout, absent successful-acquisition observations or unexpected outcome fails the experiment. Loom's internal history is bounded (review discusses exact limit). Counts are model closure executions, not unique real-world schedules.

Payload uses a separate Relaxed atomic, so stale reads are defined observations rather than invoking undefined non-atomic races. Host counters are instrumentation only: they never influence modeled branching and do not add Loom synchronization. No helper channel, mutex, acquire flag, or join-before-read supplies alternative publication. Assertions run inside observer thread before main joins.

## Cases

### Direct release/acquire

State initially1. Publisher writes payload42 Relaxed then stores state0 Release. Observer performs a one-shot CAS0->1 Acquire, and only on success checks relaxed payload==42. This is generic publication corresponding to source writer-release store and acquiring reader; initial1 is an abstract held token, not actual source writer sentinel-1.

Mutants independently downgrade publishing Release or observing Acquire to Relaxed. Both must permit stale0 after successful state acquisition. Conditional acquisition can skip observation, so the positive run additionally requires at least one observed acquisition.

### Marker RMW release sequence

State initially2, representing an already-reached prefix with two reader slots held before a payload write. Three actors:

1. First reader writes payload42 Relaxed then fetch_sub1 Release:2->1.
2. Writer CAS1->5 Relaxed (marker4 plus reader1), then one-shot CAS4->usize::MAX Acquire. On success reads payload.
3. Last reader conditional CAS5->4 Release, representing fetch_sub1 in that selected successful execution slice. It has NO acquire after first reader publication.

Writer registration and eventual acquisition remain in the same writer thread, as production. The first release heads a release sequence; intervening Relaxed registration and Release last-reader operation are RMWs. The final Acquire must inherit publisher visibility in Loom's model. The last-reader Release alone cannot republish first-reader payload without an acquire; this prevents a redundant synchronization path from masking the mutation.

`marker_store` replaces registration CAS with Relaxed load==1 then plain store5. In this restricted slice no actor can change1 until marking (last reader only accepts5), so the load/store gap does not cause stale-count overwrite. The mutation isolates release-sequence breakage, not the earlier SC counter-corruption bug. It must allow stale0 after final writer acquire. Plain store starts a new synchronization history in Loom, unlike RMW.

Atomic payload writes by modeled readers represent publication of prior atomic side effects/in-flight work, NOT permission for readers to mutate protected relocation base metadata. Marker value4 is symbolic; no counter arithmetic/domain theorem. One-shot conditional CASs are selected execution fragments, not full lock retry/parking loops. They use strong CAS, not weak spurious-failure enumeration. Initial held-slot prefix and reduced last-reader CAS are assumptions, not actual-source method execution or arbitrary reachability proof.

## Observed results

Raw logs, commands, per-file hashes and tool/platform info: `litmus-results-v1/results.json`.

| Case | Loom executions started | Successful acquisition observations | Outcome |
|---|---:|---:|---|
|direct|63|42|No stale payload found|
|direct_no_release|1|1|Expected stale0 vs42 detected|
|direct_no_acquire|1|1|Expected stale0 vs42 detected|
|marker_rmw|24,511|5,057|No stale payload found|
|marker_store|19|1|Expected stale0 vs42 detected|

All subprocesses exit0 because harness requires expected mutant failures and catches them; raw stderr records assertion panic and result JSON records it. This is not a production failure. Positive runs need both no panic and nonzero observed acquisitions. No runtime speed claim follows from exploration counts.

## Reproduce

Fresh dependency cache needs an initial locked online build; no global installs:

```sh
CARGO_TARGET_DIR="$PWD/target/verification-tools/ordering-litmus" \
 cargo build --locked --manifest-path verification/memory-lock-ordering/litmus-harness/Cargo.toml
python3 verification/memory-lock-ordering/run_litmus.py \
 --output-dir target/ordering-litmus-new
```

Runner uses offline locked build thereafter and180s per-command timeout, preserving raw output and failure evidence. Output directory must not exist. Tested rustc1.98.1, Python3.14.4, x86_64Linux. Review rerun may produce different environment/time strings; expected scenario outcomes/counts should match with same tool/settings. Standalone source and dependency checksums are recorded. Independent review reproduced all five original outcomes/counts. It identified inherited LOOM_MAX_DURATION/CHECKPOINT_FILE as a reproducibility risk (no such variables present in original run). The runner now clears and records all LOOM_* variables; a v2 run deliberately supplied a1s cap and invalid checkpoint path, removed both, and reproduced all original counts. Current evidence is litmus-results-v2/results.json. Original run_litmus_v1.py and v1 output remain. The Rust harness remains unchanged. REVIEW-LITMUS.md records the independent analysis.
