# Read-only actual-source Wasm backend review

Date: 2026-11-26. Reviewer made no changes to the Wasm harness or runners. Target production commit: `77f45543eb976e4e7843e78fcd67bd837acac6bd`.

Reviewed [Rust harness](memory-lock-wasm/harness/src/main.rs), [source inclusion build script](memory-lock-wasm/harness/build.rs), [worker tests](memory-lock-wasm/worker-tests.mjs), [runner](memory-lock-wasm/run.py), and production `post_combine.rs` wait/notify emission at lines 1337–1359. No fresh runtime experiment was performed by this reviewer; parent/implementing agent owns final execution.

## Positive findings and precise claim

- The Rust harness compiles the actual production pass source rather than a copied emission implementation. The structural oracle requires exactly the shared imported memory, no remaining ABI function imports, correct i32/i32/i64 wait and i32/i32 notify signatures, argument forwarding in order, actual `memory.atomic.wait32` / `memory.atomic.notify`, memory index 0, offset 0, alignment exponent 2, and call rebinding to generated functions.
- Both `threads=true` and `threads=false` are inspected structurally. Runtime worker tests execute the `threads=true` artifact only. Do not claim both runtime modes were exercised.
- The wrong-timeout-type mutation is rejected by Wasm validation/structural inspection. This proves the oracle rejects malformed output, not that the production pass itself explicitly rejects the bad ABI import.
- Workers call the emitted Wasm waits and notifications. JavaScript `Atomics` is used only for load/store bookkeeping, never as a substitute wait/notify implementation.
- A ready message means only that the worker will next wait. The implementation correctly does not treat this as a parking witness. A positive actual Wasm notify result equal to cohort size is the real witness that all required waiters were parked at that notify.
- The single-worker notify-one test demonstrates a count-one notify wakes one parked worker. It does **not** demonstrate selecting exactly one among multiple parked workers.
- The three-worker `-1` notify test exercises unsigned u32 maximum semantics by requiring one actual notify call to return 3. Partial wakes before the all-three witness are recorded. The finish flag plus bounded real-notify drain handles a worker re-parking before observing the flag.
- Mismatch, zero-timeout, count-zero notify, wrong-address notify, and no-waiter notify outcomes are checked. No claim is established about traps, fairness, starvation freedom, lock protocol integration, arbitrary scheduling, browsers other than tested Node/V8, or full application correctness.

## Findings communicated to parent

1. **Pin the source at the orchestration boundary.** The standalone runner accepts `WVL_SOURCE_ROOT` and `--source-root`, records the commit, but the reviewed version does not require the pinned commit or initially clean tree. The parent should pass an explicit validated source root and require exact root/commit plus clean statuses in output. Recording provenance alone is not a gate.
2. **Do not allow Python optimization to erase validation.** Reviewed runner result/provenance checks use `assert`; `python -O` or inherited `PYTHONOPTIMIZE` disables those checks. Reject `not __debug__` or use explicit exceptions. Parent pure validators should independently validate outcomes.
3. **Validate exact fresh result inventory.** Require nine successful command identities including `source-status-after`; eight source-file hash keys, before/after equality; two structural mode cases and named mutation control; two named runtime cases with exact worker count and notify request; unique ready/done IDs `0..n-1`, each done wake count positive, and positive notify-attempt count. Validate artifact hash correspondence when consuming the bundle.
4. **Use final corrected evidence.** The reviewed [initial result](memory-lock-wasm/results/initial-20261126/result.json) was produced before later corrections: eight commands, no final status/hash comparison, and [runtime evidence](memory-lock-wasm/results/initial-20261126/runtime.json) records max attempts 100000 while the reviewed worker uses 1000000. The initial run is useful historical evidence but does not validate the final revised runner. Parent was notified before final execution.

No false-green was found in the worker parking-witness/drain mechanism. Resource deadlines and attempt limits can produce conservative failures under a heavily loaded runner, but cannot legitimately turn an unobserved park into a passing witness.

## Checks performed

```sh
node --check verification/memory-lock-wasm/worker-tests.mjs
python3 - <<'PY'
import ast
from pathlib import Path
p = Path('verification/memory-lock-wasm/run.py')
ast.parse(p.read_text(), filename=str(p))
print('Wasm Python AST syntax: PASS')
PY
```

Both syntax checks passed on local Node v24.22.2 and Python 3.14.4. This review does not claim Python 3.12 hosted execution or a fresh end-to-end backend run. Parent is responsible for applying or explicitly resolving the integration findings and running final fresh evidence.
