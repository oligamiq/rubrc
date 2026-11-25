# Stage 1: finite safety model of lock batching

Date:2026-11-26 JST. Objective: start sequential formal verification of bounded guest-memory relocation-lock coalescing and publish reproducible evidence. Target WVL revision: `77f45543eb976e4e7843e78fcd67bd837acac6bd` in `.worktrees/wvl-lock-batching`.

## Status and exact claim

This is a dependency-free explicit-state model checker written in Python, NOT a proof assistant, SMT proof, or a proof of the Rust/Wasm implementation. It exhaustively enumerates reachable states/interleavings for the finite scenarios listed below, checks safety predicates on every transition, and records shortest BFS counterexamples to deliberately broken models. The checker itself is trusted and needs review. A successful finite search is not an unbounded theorem.

The first run passed997 scenarios (52,810 per-scenario states in aggregate,87,420 transitions), with all four initial faulty variants detected. Independent review reproduced it. After review, v2 adds bound-off-by-one and premature-release controls plus a per-reader exit check: all six faulty variants detected; positive counts unchanged. Current raw results and checker hash are in `stage1-results-v2.json`; original `stage1-results.json` is retained. See `REVIEW-stage1.md` for findings and source mapping. Stage2 semantic preservation and stage3 implementation correspondence are NOT yet complete.

## Abstract machine

Input classes: A=scalar guest load/store, B=allowlisted safe local computation, X=barrier. Each program gets an explicit final X representing normal region exit. `lower` emits micro-events acquire/base/access/bridge/release/barrier. These are a hand-written model of the production batching schedule, not extracted production code.

A state consists of reader PCs, Boolean read ownership per reader, cached relocation epoch per reader, original-operator count since acquisition, relocation epoch, and a writer phase. The writer can acquire only with no readers; readers can acquire only without an exclusive writer. One writer changes epoch once and releases. Every enabled reader or writer transition is explored. Base fetch and access are separate events, allowing all writer interleavings between them. Safe bridges count only inside an active batch. Locking helper events do not count as original operators.

Barriers require that the inherited BATCHING read lock is released before execution. They are abstracted as a single event. This does NOT assert that an atomic/bulk instruction's existing lowering cannot independently acquire its own read lock; the model does not simulate its internals.

## Checked safety predicates

1. No simultaneous exclusive writer and reader ownership.
2. Base fetches and guest accesses hold the batch read lock.
3. Guest accesses use the current relocation epoch.
4. No inherited batching lock survives into a barrier.
5. Active original-op count never exceeds the configured bound.
6. No double acquisition/unmatched release; normal terminal states hold no read locks.

## Finite coverage

- One reader, one writer: every class sequence over A/B/X of length0–4, bounds1,2,3,64.
- Two readers, one writer: every pair of class sequences of length0–2, bounds1,2,64.
- One reader, one writer, bound64:63/64/65/129 accesses; access+63bridges+access; access+64bridges+barrier+access.
- Each scenario explores all reachable interleavings, not random samples. Aggregate state counts include distinct scenarios; they are not unique states across a single universal model.
- The writer has only one relocation. Multiple guests, multiword memory, actual shared writes by readers and all data values are abstracted away. No claim about all programs, arbitrary reader count, or repeated relocation follows automatically.

## Negative controls

- Omit read acquisition: detects base fetch without lock.
- Retain lock across barrier: detects boundary violation.
- Permit writer to ignore readers: detects read/write overlap.
- Cache base across regions: detects stale epoch after an intervening relocation.

These show the predicates/exploration can find these faults; they are not evidence the checker has no bugs.

## Assumptions and exclusions

- Atomic read/write lock operations are assumed correct. The actual CAS/wait/notify, waiter marker, reader counter overflow and memory-order semantics require a separate model/refinement argument.
- All guest accesses are in bounds and normally complete. Existing Wasm runtime-trap lock leakage is NOT fixed or proven absent.
- B operations are genuinely nontrapping, local and nonblocking for valid Wasm stacks. The correctness of the production allowlist is not yet mechanically established.
- Writer relocation preserves logical memory content; only address epoch changes here.
- No fairness assumption or liveness claim. Existence of terminal states is a sanity check, not proof that every fair/infinite execution progresses.64 operators is not a time guarantee or starvation bound.
- No operand-stack or numeric-result proof in stage1. No compiler/Binaryen/browser correctness proof.

## Implementation correspondence to review next

- `memory_lock_batching.rs`: MAX_BATCH_OPERATORS=64; guest scalar predicate; explicit bridge allowlist; unknown operations are barriers.
- `multi_memory_lowering.rs:869–892`: release before boundary dispatch, bound check before next original instruction.
- `multi_memory_lowering.rs:1167–1182`: initial count1 and per-access base load under protection (locations must be rechecked if source changes).

The finite model must not be advertised as a verified implementation until its relationship to actual generated code is checked separately.

## Reproduce

From repository root, Python3 standard library only:

```sh
python3 verification/memory-lock-batching/model_check.py
# Optional: preserve a NEW result; refuses overwriting an existing file.
python3 verification/memory-lock-batching/model_check.py --output /path/to/new-result.json
```

Expected overall `passed:true`; each `negativeControls` entry MUST have `passed:false` and a counterexample. Any missed negative control or failed correct-model scenario raises an assertion and exits nonzero. Do not run Python with `-O` (assertions disabled). Compare checkerSha256 and deterministic counts with the preserved result. Further stages will record their own scope/results rather than retroactively expanding this claim.
