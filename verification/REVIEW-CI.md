# Scoped CI review and validator hardening

Date: 2026-11-26. Application HEAD at review: `11320336362f4cb0c4fc2909c958225df1c9e6f2` (working-tree additions under review). WVL target: `77f45543eb976e4e7843e78fcd67bd837acac6bd`.

## Scope and outcome

Reviewed the existing batching/protocol/ordering runners, current workflow conventions, and the new [standalone runner](run_checks.py) and [workflow](../.github/workflows/memory-lock-verification.yml). Initially read-only; parent subsequently authorized changes only to the runner, new unit tests, and this review evidence. No production code or workflow was modified by this reviewer. Wasm runner integration is the parent's separate follow-up and was not reviewed here.

The workflow is scoped to verification: Ubuntu 24.04, 30-minute job budget, manual plus path-filtered push/PR events, contents-read permission, concurrency cancellation, and always-upload evidence. No deployments or full application build are required. Pushes on all branches were explicitly confirmed intentional by the parent so the experimental branch can run CI. The proposed main-only filter was therefore not applied.

## Corrected fail-open edges

- Added pure, directly testable validation functions with fixed pinned inventories, not inventories derived from current output.
- Semantic checks require the two named controls, three named programs and exact coverage counts. Empty `all(...)` controls no longer pass.
- SMT requires 24 unique named queries with independently expected outcomes: 21 UNSAT lemmas and three SAT mutation controls. A report declaring both expected and actual `unknown` fails.
- Correspondence requires the 33 exact case identities in both batching modes, 66 outputs, 23 scalar kinds, and all three named event controls. Fresh prefix and fixed output location are retained; workflow already uploads their failure logs.
- Native requires eight exact variant identities, exact per-variant test names (8/10 core, 9/11 exports), two repetitions each with matching thread setting, 16 successful processes and 152 successful individual tests, and unchanged sources.
- Protocol and batch checks require their exact positive and mutation inventories and recorded coverage.
- Litmus requires all five named scenarios and their real or mutation-specific expected outcomes, rather than accepting any five successful result objects.
- Actual-source Loom requires the ten command identities and four exact feature/case pairs, matching source/instrumented hashes, one passed Rust test per case (one other test filtered out), and identity-bound execution counts: legacy writer 5, legacy readers 840, waiter-aware writer 5, waiter-aware readers 1715. Swapping feature logs, zero tests, duplicate cases, or an early successful duration/permutation cap fails.
- Actual-harness cold preparation now builds both feature sets with 600-second limits in the runner's exact private Cargo home/target paths before the short bounded runner executes. Correspondence/litmus already prepare online before their offline locked runs.
- Final tracked WVL status and revision are checked again before success.
- Validator unit tests run as a standalone runner step.

Bounded passes remain finite/model-bounded evidence, not arbitrary-execution, liveness, or whole-application proofs. Exact Loom counts intentionally fail closed when harness behavior changes; future expected-count updates must be reviewed with the changed model, not silently accepted.

## Verification performed

Local environment: Python 3.14.4, Rust 1.98.1 (`48a229cea`, 2026-09-01), Cargo 1.98.1, Node v24.22.2. CI proposes Python 3.12, which was not executed by this reviewer.

Exact unit command:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s verification -p test_run_checks.py -v
```

**PASS: 16 tests**, covering valid reports, empty controls, renamed/duplicate identities, truncated counts, wrong source hash, swapped feature evidence, zero Rust tests, and forged SMT expectations. Raw output: [unit test log](review-ci-unit-tests.log). Tests: [test_run_checks.py](test_run_checks.py).

All eight pure validators were also invoked against the parent's existing successful [initial local evidence](../target/verification-ci-local-initial/summary.json): batch model, semantic, SMT, protocol, native, correspondence, litmus, and actual-source Loom all passed. This was validation of existing evidence, not a fresh suite execution. `git diff --check` passed. Python AST and workflow YAML structural parsing passed before hardening; unit imports validate final Python syntax. Full final suite execution and hosted CI remain the parent's responsibility.

At handoff before parent Wasm integration:

- Runner SHA256: `04841d3836818ce1a680eb68054722a91f4202d2977fde0d0654511cea6327c9`
- Unit tests SHA256: `409af460be1dc26ac31e6164e206139fdd435915c24c2203cbc9728e75abd2cc`

## Tool availability checked

- [Rust 1.98.1 published manifest](https://static.rust-lang.org/dist/channel-rust-1.98.1.toml) fetched and parsed: manifest date 2026-09-03; `x86_64-unknown-linux-gnu.available = true`.
- [Node 24.22.2 checksums](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt) fetched HTTP 200 with Linux x64 binaries listed.
- [Z3 solver 4.15.4.0 metadata](https://pypi.org/pypi/z3-solver/4.15.4.0/json) fetched HTTP 200: unyanked release, `py3-none-manylinux_2_17_x86_64` wheel available (suitable wheel tag for Python 3.12/Ubuntu 24.04).

These checks establish published metadata availability, not a complete fresh installation on GitHub-hosted infrastructure.

## Remaining nonblocking recommendations

- If caching is added, cache Cargo registry/git and build target paths only, keyed on OS, toolchain and all harness lockfiles; do not cache evidence directories. Actual-harness private Cargo directories need separate inclusion. No cache is currently intentional and not a correctness defect.
- First checkout may use `persist-credentials: false`; no publishing requires credentials.
- Failure artifact glob for `actual-*` also includes historical tracked runs. It preserves useful failure evidence, but current run timestamps should remain explicit to prevent confusing older results with the failed run.
- CI should ultimately be tested cold and with Python 3.12. Solver install failure or unavailable toolchains must remain failing infrastructure outcomes, not skipped checks.
