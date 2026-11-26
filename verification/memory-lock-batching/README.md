# Lock-batching verification record

Target implementation: WVL `77f45543eb976e4e7843e78fcd67bd837acac6bd`. Started2026-11-26 JST. User requested staged verification with evidence others can inspect. Production behavior is not changed by this work.

## Evidence map

| Stage | Question | Evidence | Status |
|---|---|---|---|
|1|Finite abstract reader/writer scheduling respects batching invariants?|[Specification](SPEC.md), [review](REVIEW-stage1.md), [v2 result](stage1-results-v2.json)|997 finite scenarios,6 faulty variants detected; independently reproduced|
|2a|Selected reduced-domain programs preserve stack/locals/logical memory under relocation?|[Scope](SEMANTICS.md), [result](stage2-results.json), [independent rerun](stage2-results-reproduced.json)|1,409,024 reference comparisons,2 faulty variants detected|
|2b|Full-width integer byte algebra and conditional address arithmetic agree?|[Scope/review](SYMBOLIC.md), [standalone SMT queries/results](stage2b-smt/results.json), [audit](stage2b-audit.json)|21 UNSAT/3 SAT as expected; includes tautological stack sanity, not emitted-stack proof|
|3a|Actual production transformation emits expected batching schedules on selected fixtures?|[Scope](CORRESPONDENCE.md)|66 validated outputs (33 fixtures×off/on),23 scalar kinds,3 event mutations detected; parent independently reproduced|

## How to interpret this

This package combines finite model checking, exhaustive reduced-domain validation, solver-checked local algebra, and selected actual-emitter checks. **It is not an end-to-end formal proof of WVL, Binaryen or Rubrc.** No mechanical refinement/composition theorem joins these stages. A source hash identifies code but does not prove correspondence.

In particular, the atomic lock protocol is ASSUMED by stage1. Its CAS/wait/notify, memory ordering, fairness, overflow, cancellation and runtime-trap behavior are not verified. Actual guest OOB traps can leak the existing read lock.64 original operators is not a latency/fairness guarantee. Arbitrary concurrent guest writes and external optimizer correctness remain outside the claim.

Follow-up: [internal lock protocol verification](../memory-lock-protocol/README.md) now checks a finite SC-atomic CAS/wait/notify model and actual-source native regressions. It does not remove stage1's abstraction assumption or prove weak-memory/composition/fairness properties.

Every stage documents its exact domain, oracle, negative controls, commands, environment and source hashes. Original results are never overwritten when a checker changes. Reproduction may produce different timings/platform information, but semantic counts/outcomes and query hashes should agree when source/tool versions agree. Use a new output path for each run.

## Prepare the pinned source checkout

Stages2a/3a expect WVL at `.worktrees/wvl-lock-batching`. On a fresh Rubrc checkout, if that path does NOT already exist:

```sh
git clone https://github.com/oligamiq/wasi_virt_layer .worktrees/wvl-lock-batching
git -C .worktrees/wvl-lock-batching checkout --detach 77f45543eb976e4e7843e78fcd67bd837acac6bd
```

Do not overwrite or switch an existing developer worktree; use a separate fresh Rubrc checkout for reproduction. Compare production file hashes with recorded evidence. For a fresh Cargo cache, first run the documented stage3 Cargo command without `--offline` (keep `--locked`) to fetch pinned dependencies, then use the offline strict runner. The formal checks are not yet wired into CI.

No global dependency installation is needed: stages1/2a use Python standard library, stage2b uses pinned Z3 in a project-local directory, and stage3a uses a small locked Cargo harness importing the real production files. See individual specifications for commands.
