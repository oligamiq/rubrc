# Reproducible memory-lock verification gate

2026-11-26 JST. Purpose: run the previously recorded finite/symbolic/actual-source checks together and preserve raw artifacts in CI. This does NOT upgrade any scoped check into an end-to-end proof.

## Entry point

```sh
# Requires pinned WVL checkout at .worktrees/wvl-lock-batching (see prior READMEs),
# Rust1.98.1, Node24.22.2, Python3.12+ and z3-solver4.15.4.0.
python verification/run_checks.py --output-dir target/verification-ci-new
```

Output directory must be new. Each subprocess has a deadline, failure stops the suite, and summary plus raw stdout/stderr survive exceptions. Model result counts and mutation detection are explicitly checked rather than trusting a process exit0 alone. `--skip-wasm` is a development-only partial run, recorded as partial; CI does not pass that flag.

## Jobs included

- Batching finite-state model, reduced-domain semantic checks, full-width local SMT lemmas.
- Actual WVL emitted-event correspondence (lightweight Rust source-import harness).
- SC lock protocol model with reverse reachability and six faulty variants.
- Actual native lock regressions (two repetitions per eight build variants).
- Loom release-sequence litmus checks and actual-source visibility checks at preemption bound2.
- Real Wasm wait/notify mapping/runtime checks (new backend stage; exact coverage documented separately).

## Hosted workflow

`.github/workflows/memory-lock-verification.yml` runs on relevant pushes/PRs and manual dispatch; Ubuntu24.04,30min job timeout, contents-read only. It fetches exact WVL77f45543eb976e4e7843e78fcd67bd837acac6bd, installs pinned tools, runs the suite, and uploads logs/results even on failure (30day retention). No application build, Pages deployment, default feature change, or production-source modification.

This is a regression gate for the PINNED WVL revision, not automatically the newest WVL branch. A production-revision update requires reviewing source correspondence, updating pins/hash expectations and recorded inventories, and rerunning the checks. No branch-protection/required-status setting has been changed, and the workflow is currently published on the experimental branch rather than merged into main.

Dependencies are locked in each small Cargo harness. First network build populates caches before older offline runners execute. Actual-source Loom runner deliberately uses its own local Cargo home. CI has no cache initially to test clean reproducibility; it may be optimized later. CI result artifacts include exact source/run revisions. Rust release/tool availability and Python solver wheel were checked before adding workflow, but a real hosted run is still required to validate setup.

## Status

Local complete run PASS: `ci-results/local-final/summary.json` and sibling command logs.20 fail-closed validator unit tests also pass. Initial partial run and first full integration failure are preserved separately; the latter was parent/backend command-inventory schema drift (8vs9 after adding source-status-after), not a production failure. Final validator requires nine backend command labels, unique worker identities, actual positive wake witnesses, unchanged source hashes and exact native/model inventories. All20 tests are run by the gate itself.

Published source commit5348a26dedb6d4c285a62d8b436c6ad985a38c63 triggered [hosted run45767942384](https://github.com/oligamiq/rubrc/actions/runs/45767942384). That hosted attempt failed before testing: actions/checkout auth cleanup traversed the pre-existing test_repo gitlink lacking a .gitmodules URL, even with submodules:false. Preserved logs/run metadata: ci-results/45767942384/. The workflow now uses the same public exact-SHA manual fetch/checkout approach as other experimental jobs, without credentials/submodule traversal. The corrected [hosted run45768075263](https://github.com/oligamiq/rubrc/actions/runs/45768075263) succeeded at source5588750fc686863a62cd4e9e8db2c22c806f8070; verify job completed in1m54s including fresh tool/dependency setup and artifact upload. Run metadata/logs are in ci-results/45768075263/. Downloaded artifact verification discovered an evidence-plumbing defect: underlying correspondence logs overwrote the two wrapper command logs after their hashes were recorded. Model/test outcomes passed, but the bundle failed those two digest checks. The issue is preserved as artifact-validation-issue.json. The runner now keeps underlying logs under correspondence-raw.* and rechecks every command log digest before declaring success. The corrected [run45768556714](https://github.com/oligamiq/rubrc/actions/runs/45768556714) succeeded in1m55s at source205db7b2a2db3b91b22a234991856651f7fd16df. Its downloaded bundle passed independent contract replay (all9 gate validators) and184 digest checks. Audit result: ci-results/45768556714/artifact-validation.json. Durable evidence and per-file hash manifest are saved under that run directory; eight rebuildable native binaries are excluded from Git, while their commands/hashes and all logs remain. The full local download is target/verification-hosted-45768556714/. This is the final accepted hosted run, not merely a green badge. The run emitted a nonfatal action-runtime warning: setup-python@v5/setup-node@v4/upload-artifact@v4 declare Node20 but GitHub forces Node24; application test Node remains pinned24.22.2. No warning was treated as a test failure or silently suppressed. Existing historical evidence is never overwritten by CI: correspondence uses a unique prefix, Loom uses fresh timestamped directories, other results go under the requested output root. Previous committed results are preserved separately.
