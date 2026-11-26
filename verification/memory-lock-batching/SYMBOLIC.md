# Stage2b: full-width local SMT lemmas

2026-11-26 JST. Unlike stage2a's small exhaustive domain, these queries use actual32-bit addresses,8-bit memory bytes and32/64-bit integer values. They do NOT establish whole-program equivalence or a proof of generated Wasm. Independent read-only query review completed; results and limitations below incorporate it.

## Method and precise theorem scope

Each normal query asks whether a difference is satisfiable, given explicit preconditions. Z3 returning `unsat` means no counterexample exists to THAT formula under those preconditions, trusting Z3 and the encoding. This is not a proof artifact checked by a second proof kernel. All standalone SMT-LIB queries are preserved so another solver can inspect/replay them.

- Integer loads: unsigned and sign-extended1/2/4-byte loads for i32 and1/2/4/8-byte loads for i64 (signed only narrow). Given equality of the selected logical/physical bytes, reference arithmetic assembly and little-endian concatenation/extension give the same value.
- Stores: arbitrary logical query address q within size. Given pre-store equality at q, storing low bytes of an arbitrary value at logical a and translated physical base+a leaves post-store projections equal at q. Arbitrary q plus array semantics covers aliases and unchanged bytes. Different byte extraction formulations are compared (division+low-byte vs bit extraction).
- Address: original i32 x+y is modular; immediate memarg offset is added in a widened domain. Under no physical overflow, the lowered base addition before memarg yields the intended widened effective address.
- Stack: a small syntactic spill/restore algebra identity with an arbitrary live prefix word. This is a sanity lemma, NOT proof of the emitted local.set/local.get sequence or arbitrary stack typing.

The chosen logical-size bound is a32-bit value, so size=2^32 is not expressible. Memory64 is outside scope. Normal formulas require address+width <= logical_size and base+logical_size <=2^32 (widened to64bits; sums cannot overflow64bits). These exclude relocation-address wrap and OOB; they do not show those preconditions always hold in production. No trapping behavior is proved. References to memory contents are relations assumed at operation entry; the actual relocation-copy algorithm is not proved.

No floats/NaNs/SIMD, arbitrary bridges, execution scheduling, CAS/wait/notify, arbitrary racing guest writes, or induction over all programs are modeled. Stage1 checks a different scheduling abstraction; merely having both results is not a mechanical composition theorem. Actual generated-code correspondence is stage3.

## Initial results

Command completed with24queries:21expected `unsat` local lemmas and3expected `sat` mutation controls, all as expected. Negative controls change unsigned byte loads to sign-extension for each word width and reverse store operands in the stack sanity model. Saved counterexample models demonstrate the checks can expose these mismatches. `unknown` or timeout is a failure, not success.

Artifacts: `stage2b-smt/results.json` plus24 `.smt2` files, each query hashed. Checker hash recorded in results. Solver4.15.4.0, Python3.14.4.

Independent reviewer a36df73f-33f1-488c-b890-05fcd1838117 replayed all original queries and regenerated matching query hashes. Every query's assumptions alone were SAT: no inconsistent-precondition vacuity was found. For all19 load/store obligations, removing bounds still yields UNSAT, while removing the content relation yields SAT. Thus these are byte-algebra/content-projection lemmas conditional on an assumed mapping, NOT proofs of bounds checks or trap behavior. The unsigned1-byte load is directly the assumed byte equality. The spill/restore query simplifies to false because each restored element is syntactically itself: count it as an encoder sanity check, not a substantive lowering proof. The address lemma does check a no-wrap arithmetic identity. Arrays are total and no physical-memory length or trap semantics is modeled. Audit raw results: `stage2b-audit.json`; reproduction logs and regenerated queries remain under `target/stage2b-smt-readonly-audit-20261125T1634Z/`. This is AI-assisted independent review, not external certification.

## Reproduction (isolated dependencies)

The initial `python3 -m venv` attempt failed because host Python lacked ensurepip. No system packages were changed. A pinned solver was installed into the project target directory with uv:

```sh
uv pip install --target target/verification-tools/z3-packages z3-solver==4.15.4.0
PYTHONPATH="$PWD/target/verification-tools/z3-packages" \
 python3 verification/memory-lock-batching/smt_check.py \
 --output-dir target/verification-tools/new-smt-results
```

Use a NEW output directory; the checker refuses overwrites. An existing compatible environment can instead install the same pinned package. Standalone query replay, without the Python encoder:

```sh
target/verification-tools/z3-packages/bin/z3 \
 verification/memory-lock-batching/stage2b-smt/i64_8bytes_store_projection.smt2
```

Expected answer for that normal lemma: `unsat`. Mutant filenames contain `mutant` and must give `sat`. Results here are for the model expressions; source hashes from earlier stages are not evidence the implementation was translated into SMT.
