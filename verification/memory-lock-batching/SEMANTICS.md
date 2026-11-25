# Stage 2a: exhaustive reduced-domain semantic validation

Date: 2026-11-26 JST. Target WVL revision: `77f45543eb976e4e7843e78fcd67bd837acac6bd`. This is a deliberately small, dependency-free semantic validation experiment, **not** a proof over WebAssembly i32/i64 or a proof of the Rust transformation. Follow-up Stage3a selected actual-pass event correspondence is recorded in CORRESPONDENCE.md; full implementation refinement remains open. Separate Stage2b full-width local symbolic identities are recorded in SYMBOLIC.md and do not expand this reduced-domain claim.

## Exact finite domain

- Two logical guest memories, each with two **2-bit cells**. All `4^4 = 256` initial memory states are enumerated.
- **4-bit words**, all 16 initial store/local values, and both addresses 0 and 1 are enumerated. Wide operations explicitly address zero; both address inputs are still enumerated, even when a template ignores that input.
- A live initial stack word is `15 - value`, so it ranges over all 16 words but is **correlated**, not independently varied. Initial locals are `(address, value, 0)`.
- Three fixed, well-typed straight-line templates: mixed-guest narrow signed/unsigned access; two-cell little-endian stores/loads with multiple live results; modular arithmetic followed by narrow store truncation. Bridges include local get/set/tee, constants, add and xor. An explicit barrier and final exit exercise region boundaries.
- Candidate bounds 1, 3, and 64; baseline per-access ownership. These templates do not exercise the 64-op cutoff itself (stage 1 includes dedicated 63/64/65/129 cases).
- One content-preserving relocation request at **every original-op boundary**, including before the first op and before final exit. It is serviced at the first point without inherited reader ownership. This is an enumeration of this reduced schedule family, **not every micro-event interleaving**. Stage 1 separately explores base/access micro-event interleavings for its stated abstract domain.

## Oracles and modeled semantics

`reference` interprets the original template over logical arrays, independently of locking/bases. It implements little-endian assembly using integer powers/division/remainder, signed extension by subtracting the source modulus, and word wrapping by modulo16.

`lowered` separately interprets modeled generated plumbing over physical cells. Stores spill value then address before lock acquisition; loads fetch each guest's base under ownership; memory values use shifts/masks and signed extension using a word mask. Stack/local operations have separately written implementations. The physical base plus address is modulo16, but **the enumerated valid configurations never wrap**. This is not evidence for address-overflow or memarg-offset correctness. Memarg offsets are not modeled.

Relocation moves both guests from bases `(0,2)` to `(8,10)`, preserving a snapshot of their logical cells and poisoning old storage with an impossible cell value. Any later physical access to retired storage fails. Final comparisons project physical memory back to logical guest cells, so a harmless change of physical placement is not a semantic difference. The relocation-copy helper is trusted: its correctness is not under test.

`baseline` uses the same physical interpreter with inserted release barriers after every access. Thus baseline/candidate share physical execution helpers; comparing the two alone would miss common-mode errors. **Both are separately compared against the independently written logical reference** on every enumerated input/schedule. Templates and standard-library Python arithmetic remain trusted; there is no claim of independent proof-assistant verification.

The output compares the entire final operand stack, all modeled locals, and both complete logical memories. It also counts candidate runs with strictly fewer acquisitions; a nonzero observed count demonstrates that the candidate did not always fall back to baseline in this run. Intermediate observations, arbitrary concurrent guest writes, asynchronous traps, growth failure, and multi-writer scheduling are outside this experiment.

## Negative controls

- `stale_base`: retain each guest's cached base across lock regions. An intervening relocation must expose access to retired storage or different results.
- `reverse_store_operands`: incorrectly spill address and value in reversed order. A wrong result or a newly introduced out-of-bounds access is a counterexample; original template executions are always in bounds.

Controls run selected input search with initial cells `(0,1,2,3)`, all 16 values, both addresses and all request points until a witness is found. They are not included in positive comparison totals. Counterexamples are reproducible input records, not assertions of minimality.

## Production mapping and limits

The hand-written model is motivated by WVL's `multi_memory_lowering.rs:1139–1158` (reverse-order operand spills), `1160–1172` (one reader slot), `1175–1182` (fresh base/address addition), `1184–1202` (restore values/emit access), and `1204–1229` (live results and baseline releases). `memory_lock_batching.rs:15–17` supplies the production bound; its allowlist is substantially larger than these templates. Stage 1 documents count/lock boundaries more fully.

The result records the exact checkout HEAD and SHA256 of three relevant production source files, and SHA256 of this checker. These identify what was reviewed, but do **not** establish that actual emitted Wasm implements this reduced machine. No production code is imported or executed. This evidence cannot be relabeled as full32/64-bit semantic proof, all-Wasm-program equivalence, arbitrary-reader correctness, trap safety, fairness, or writer latency proof.

## Reproduction and artifacts

Python3 standard library, no packages/build/install/network required:

```sh
python3 verification/memory-lock-batching/semantic_check.py
# Save to a fresh path only; existing evidence cannot be overwritten:
python3 verification/memory-lock-batching/semantic_check.py --output verification/memory-lock-batching/stage2-results.json
```

Running with Python `-O` is explicitly rejected. Positive mismatches or missed mutation controls fail nonzero. The result includes interpreter/platform information, measured duration, exact counts, witnesses, source hashes, and checker hash. Duration and platform fields naturally vary. No benchmark speedup inference should be drawn from checker duration.

## Observed result

Command above with `--output verification/memory-lock-batching/stage2-results.json` completed successfully (exit0). All **1,409,024** reference comparisons passed across **24,576** initial template/input combinations; schedule/mode variants account for the larger comparison count. **704,512** candidate runs used fewer acquisitions than baseline. Both negative controls were detected: stale base accessed retired storage, and reversed store operands produced a semantic mismatch (not merely an introduced trap).

Raw output is `stage2-results.json`, including Python3.14.4/Linux environment, production source hashes, 13.04s elapsed, and checker SHA256 `50f62239c847ef082b733d8d5fe485b9585cfb54ef2bd63f45c41ae2fd407305`. This is a successful reduced-domain experiment only; all exclusions above remain unchanged.
