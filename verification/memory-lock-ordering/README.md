# Weak-memory ordering verification

Started2026-11-26 JST. Follow-up to [SC lock protocol checks](../memory-lock-protocol/README.md). Goal: test payload visibility through Acquire/Release and a Relaxed writer-registration RMW. Production source remains unchanged at WVL77f45543eb976e4e7843e78fcd67bd837acac6bd.

## Evidence map

- [Finite handwritten litmus specification](LITMUS.md): Loom0.7.2 direct publication and reader-release -> Relaxed marker -> last-reader-release -> writer-acquire chain. Positive direct63/marker24,511 model executions, nonzero successful observations. Three deliberately weakened variants expose stale0 instead of42.
- [Current litmus raw evidence](litmus-results-v2/results.json): exact commands, tool versions, hashes and raw stdout/stderr. Runner removes/records LOOM_* environment to prevent hidden caps/checkpoint replay; hostile-env reproduction matches original counts.
- [Original results](litmus-results-v1/results.json) and [independent rerun](litmus-review/results.json) retained. Original runner snapshot run_litmus_v1.py preserves old checksum. [Independent review](REVIEW-LITMUS.md) verifies nonvacuity, absence of masking synchronization, tool internals and environment-hardening response.
- Actual-source Loom instrumented tests (three exact hash-checked substitutions, unchanged lock method bodies) passed two publication cases in both modes:5/840/5/1,715 completed model executions. Parent rerun reproduced counts. Preemption bound2 remains; no permutation/duration cap hit in expanded run. Actual wait uses yield/noop notification, so this tests ordering, not compare-and-park. Details in [actual-source report](ACTUAL.md) and [independent review](REVIEW-ACTUAL.md).

## Claim boundary

Loom explores weak-memory atomic observations, but [does not implement the complete C11 model](https://github.com/tokio-rs/loom/blob/v0.7.2/README.md#unsupported-features); particularly some load-buffering outcomes are absent. Success is evidence for stated tests in Loom, NOT all Rust/Wasm executions or a kernel-checked theorem. No fairness/liveness proof, no actual Wasm compare-and-park, no arbitrary-program/compiler composition proof. Relaxed atomic payloads avoid invoking undefined behavior but do not establish non-atomic data-race freedom.

The marker litmus demonstrates why an RMW matters in the modeled release sequence. It does not assert reader permission to mutate relocation metadata. Generic direct litmus token differs from actual writer sentinel; source-method tests cover real sentinel independently. Neither positive assertion coverage nor mutation detection proves complete exploration outside the declared domain.

## Reproduce

See LITMUS.md for locked dependency preparation and run_litmus.py command with a new output directory. Dependency caches and binaries are local artifacts, not deliverables. Do not overwrite previous result directories. Source and all evidence are stored inside this project, with hashes to detect drift.
