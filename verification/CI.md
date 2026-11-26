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

Dependencies are locked in each small Cargo harness. First network build populates caches before older offline runners execute. Actual-source Loom runner deliberately uses its own local Cargo home. CI has no cache initially to test clean reproducibility; it may be optimized later. CI result artifacts include exact source/run revisions. Rust release/tool availability and Python solver wheel were checked before adding workflow, but a real hosted run is still required to validate setup.

## Status

Implementation and local/hosted validation in progress. This document will record successful runs or concrete failures once observed. Existing historical evidence is never overwritten by CI: correspondence uses a unique prefix, Loom uses fresh timestamped directories, other results go under the requested output root. Previous committed results are preserved separately.
