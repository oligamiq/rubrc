# Internal lock protocol verification

Date2026-11-26 JST. Target WVL77f45543eb976e4e7843e78fcd67bd837acac6bd. Follow-up to [batching verification](../memory-lock-batching/README.md). No production changes or default enablement.

## Results so far

- [SC protocol specification](SPEC.md) and [checker](protocol_check.py):20 finite scenarios in both feature modes,67,185 aggregate reachable states/268,308 transitions. Exclusion/count invariants hold, no all-parked deadlock found, and every reachable state has some path to completion. This is NOT eventual completion for every schedule.
- [Current raw model results](protocol-results-v2.json):six intentionally broken protocols are rejected with concrete counterexamples. [Original results](protocol-results-v1.json) and [original checker](protocol_check_v1.py) retained.
- [Actual-source native regressions](NATIVE.md):8build variants,160/160 test processes passed,1,520 individual passing executions (repetitions included). [Raw report](native-results.json) indexes360stdout/stderr logs with hashes. Independent parent rerun:16processes/152executions pass.
- [Model provenance](protocol-environment.json) records target source hashes and command. [Independent review](REVIEW.md) and [raw rerun](review.json) reproduce v2 exactly except duration; no blocking model defect found for the stated claim.

## Essential limitations

The protocol model assumes sequentially-consistent atomic interleavings and correct indivisible wait compare/registration. The real Rust uses Relaxed/Acquire/Release; this work does not prove weak-memory visibility/release sequences or compiler/Wasm lowering. Counter capacity is shrunk to3 to exercise saturation; no theorem lifts this to all production counts. At most5fixed-role participants, selected finite operation budgets. No arbitrary arrivals, cancellation, traps, runtime-wait implementation, or fairness theorem. Both modes permit writer starvation with unending readers. Native Condvar synchronization can add ordering that masks weak-memory problems. Do not combine these results into an end-to-end proof without a separate refinement argument.

## Reproduce

Use the pinned WVL checkout preparation from the previous verification README. Python3 stdlib and rustc are sufficient; no added dependencies. Use fresh output paths:

```sh
python3 verification/memory-lock-protocol/protocol_check.py --output target/protocol-new.json
python3 verification/memory-lock-protocol/native_regression.py --output-dir target/protocol-native-new
```

The full recorded commands/tool versions are in the individual reports. Native binaries are local untracked artifacts, rebuilt by the runner; source wrapper/logs/hashes are committed. Original results are create-only to preserve history. CI integration is not yet part of this stage.

Next deeper step after review: weak-memory-aware checks of release/acquire payload visibility and release-sequence preservation. This is deliberately not claimed by the SC model.
