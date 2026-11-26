# Independent stage1 review and response

2026-11-26 JST. Reviewer: independent coding subagent e53b08d8-40ee-40b4-b4cf-1b3e1e5932f0, read-only during this review. WVL target77f45543eb976e4e7843e78fcd67bd837acac6bd. This is an AI-assisted review, not external certification.

## Reproduction and verdict

Reviewer executed `python3 verification/memory-lock-batching/model_check.py` on initial hash63c74d8f91e3adcef6fe6b5862172a5c69d0894fd2cba17e850233fed1d2e5a6 and reproduced997 cases,52810states,87420edges,4negative controls. Found no blocking bug in the positive exploration or schedule/count correspondence. Confirmed finite claim is accurately limited. This does not prove completeness of the abstraction or the Rust implementation.

## Findings addressed

1. Existing controls did not exercise bound detection. Added `late_bound` (`>` instead of `>=`) on A+63B+A; v2 detects region_bound at65original operators.
2. Acquisition-omission control fails at base load, not between base/access. Added early_release; v2 detects access_without_lock.
3. Terminal ownership should not depend on writer being done. Made check per reader, independent of writer progress.
4. Prevent assertions disabled accidentally: checker exits nonzero under Python -O.

Parent reran revised checker hash e1a01d10dc70c5acef25c6217a1a0fb4e8ebc2ee3e786f9fbd7db1f9ede9bf78; same positive counts, six controls detected. Preserve both results: stage1-results.json (original) and stage1-results-v2.json (current). Reviewer subsequently re-reviewed the v2 edits and reproduced exact equality with stage1-results-v2.json, including all six controls; no new blocking issue found within scope.

## Source correspondence independently inspected

Paths below are relative to `.worktrees/wvl-lock-batching/` at pinned revision.

- `wasi_virt_layer-cli/src/wasm_stream/passes/memory_lock_batching.rs`:15–17 bound64original operators,20–47 scalar guest predicate,50–179 safe bridges.
- `.../multi_memory_lowering.rs`:427–432 feature gates;869–892 release before dispatch/boundary,1160–1172 acquisition/count1,1175–1182 per-access base load,1194–1202 translated access,1204–1229 baseline result handling,1293 final End assertion.
- `.../shared_global.rs`:286–296 generated base global reads become get_no_wait helper calls. These generated calls are permitted under lock; ORIGINAL calls are boundaries. No claim 'all calls under lock forbidden'.
- `wasi_virt_layer/src/memory.rs`:44–55 getter uses ordinary static-mut base read, relying on the outer lock and synchronization.
- `.../multi_memory_lowering.rs`:1351–1355 writer acquire,1367–1373 failed-grow release,1400–1423 copy/fill/base changes,1444–1447 successful release. The epoch model abstracts this exclusive interval, does not verify the copy.
- `wasi_virt_layer/src/shared_global.rs`:31–48 common lock/backend,73–106 exports; `memory_lock.rs`:44–65read Acquire CAS,69–72Release decrement,76–127writer register/park,130–132writer Release+notify.

## Residual assumptions

Valid initialized lock/base/data, no out-of-bounds traps or cancellation, correctly typed stacks, trusted nonthrowing generated helpers, all relocation under one exclusive lock, no manual/reentrant lock misuse. Model does not validate memory ordering/CAS failures/counter overflow/park-notify implementation. All readers share one lock; physical content preservation is assumed. Multiple readers' racing stores/content consistency are not modeled. Terminal-state existence is not liveness. No finite cutoff theorem for arbitrary readers, long programs, or many relocations.

Stage2 must separate logical content equivalence from physical address relocation and model little-endian bytes, truncation, sign extension and live stack operands. Stage3 must check emitted code, not merely rely on this manual source mapping.
