# Stage 3a: selected emitted-event correspondence

Date: 2026-11-26 JST. Target production checkout HEAD is `77f45543eb976e4e7843e78fcd67bd837acac6bd`.

## Objective and implementation boundary

Run the **actual** `MultiMemoryLoweringStreamPass` on valid fixtures, then compare observed output events against an independently written schedule predictor. This closes a narrow gap between the hand-written safety model and production emission; it is not full Rust/Wasm implementation verification or whole-pipeline equivalence.

The standalone Cargo binary imports six files directly from the production checkout using generated Rust `#[path]` declarations: `pipeline.rs`, `translator.rs`, `mem_info.rs`, `own_memory_abi.rs`, `passes/memory_lock_batching.rs`, and `passes/multi_memory_lowering.rs`. No transformation code is copied, replaced, stubbed, or reimplemented. In particular it uses the real parallel function-processing helper and instruction translator. Building a binary instead of module unit tests avoids unrelated `cfg(test)` imports. No application, runtime library, browser build or deployment is performed.

## Fixture coverage and independent predictor

All fixtures contain the own-memory ABI imports/exports expected by production and two guest memories plus host memory. The hook/lock exports have valid signatures but no-op bodies: only generated code is inspected, **no runtime lock behavior is tested**.

The predictor parses the original function and uses its own small opcode classifier, **not** `is_batchable_access` or `is_safe_bridge`. Its scalar table includes all 23 production scalar load/store kinds. Its bridge subset is Nop/Drop and scalar constants. It applies the stated 64-original-op rule and predicts acquire/base/access/release events, preserving original constants, drops, nops and barriers as visible events. Both batching off and on are checked.

Selected fixtures:

- Safe Nop gaps of 0,59,60,61,62,63,64,65,126,127,128 between accesses, including exact original-operator cutoff edges.
- Repeated three-original-op load sequences of lengths1,2,21,22,23,63,64,65,129.
- User call, global get/set, block/loop/if/br_if, trapping integer division/conversion, host memory access, return and unreachable boundaries.
- One mixed-memory fixture containing all23 scalar op kinds, nonzero memarg offset8, alternating guest memory indices and store operand types.

The extractor identifies actual lock function indices from exports, validates balanced ownership and boundary release, requires a fresh protected base for every guest access, requires translated memory index0, and preserves scalar instruction kind/memarg offset/alignment for equality. Original host loads use distinguishing offset4096. Base globals1/2 map to guests1/2 because each fixture has exactly one original global.

Generated local spills/restores and address I32Add are erased from the extracted event stream; templates do not contain original local operations or I32Add. Thus this stage does **not** prove operand-spill correctness, stack-result values or address arithmetic. Input and output Wasm validation supplies structural/type checks but not semantic correctness. Stages2a/2b separately address their explicitly stated semantics domains.

## Controls and limitations

Three mutations of the observed event stream (omit base, omit release, replace guest base) must fail exact equality. These are controls of the event comparator, not source-code mutants and not exhaustive checker validation.

Control-flow fixtures are checked statically, including unreachable suffixes; no dynamic path exploration is performed here. This is selected-fixture testing, not exhaustive all-Wasm-program checking. The fixture vocabulary omits atomic/bulk standalone lock behavior, most safe bridge opcodes, exception proposals, and several control forms. Existing integration tests cover some of those independently; this experiment does not claim them as executed.

The pass is inspected **before** SharedGlobal rewriting and later optimizers. Generated GlobalGet becomes a trusted no-wait getter in later own-memory processing, but this harness does not run or validate that stage. No proof of linking, Rust/CAS memory ordering, runtime traps, engine semantics, fairness, arbitrary reader count, or final optimized code follows.

## Reproduction

From repository root, using cached dependencies when available:

```sh
CARGO_TARGET_DIR="$PWD/target/verification-tools/stage3-cargo" \
  cargo run --offline --locked \
  --manifest-path verification/memory-lock-batching/stage3-harness/Cargo.toml
```

The initial lockfile-generation run omits `--locked`. Cargo dependency versions are pinned in the manifest and transitive versions preserved in its lockfile. Production source files remain outside this harness and must be present at the recorded revision/hash. No global package installation is necessary.

For strict parsed evidence with source/tool hashes and raw stdout/stderr preservation, run:

```sh
python3 verification/memory-lock-batching/run_correspondence.py stage3-new-reproduction
```

The output prefix must be fresh; the runner refuses to overwrite prior evidence. It accepts only the exact known production import-diagnostic lines preceding the JSON report and then parses the entire remaining JSON document.

## Observed results and raw evidence

- Initial offline build failed (exit101) because pinned `log0.4.29` was not cached: `stage3-build.log`. Its `stage3-results.json` is empty, **not successful JSON evidence**.
- The network-enabled `cargo run --locked` retry downloaded two missing pinned crates, compiled the small harness in12.73s and passed (exit0): `stage3-build-attempt2.log`, `stage3-results-attempt2.json`. Despite the latter filename, it is **raw stdout with import diagnostics followed by JSON**, not a standalone JSON document.
- The strict runner then reproduced successfully offline: `stage3-verified.json` is the authoritative parsed report; `stage3-verified.stdout.log` and `stage3-verified.stderr.log` preserve its raw output.
- **33 fixtures ×2 modes =66 validated outputs**, all exact event-stream comparisons passed; all23 scalar kinds covered; three event-mutation controls detected.
- The report includes Rust/Cargo/Python/platform versions and SHA256 of all six imported production sources, manifest/lockfile/build glue/harness and runner.

Parent independently read the fixture/predictor/extractor code and build glue, then reran the strict runner successfully offline: `stage3-parent-reproduced.json` and associated stdout/stderr logs. No blocking issue was found for the stated selected-fixture claim. The event mutations are deliberately weak comparator checks, not production-code fault injections. Source HEAD is checked and source hashes recorded; local source cleanliness is not enforced by the runner, so compare the recorded hashes when reproducing.

Compiler warnings from the unchanged production pass are preserved (unreachable match arms and unused variables); they were not suppressed by rewriting production code. These runs establish only the selected pre-SharedGlobal emitted-event correspondence described above.
