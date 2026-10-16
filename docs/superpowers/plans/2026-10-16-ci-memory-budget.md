# CI Memory Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the approximately 16 GiB WASM optimizer on a hosted environment with adequate headroom, and capture resource evidence without using the faulty local PC for heavy execution.

**Architecture:** Keep the public repository's standard Ubuntu runner. Add a dedicated 16 GiB swap file for the optional optimization job, raise the optimizer's virtual-address-space limit from 12 to 24 GiB, and treat 30 minutes as a reporting checkpoint instead of termination. Preserve validation, fallback metadata, and explicit reporting of unsuccessful optimization.

**Tech Stack:** GitHub Actions, Ubuntu 24.04, bash, Binaryen 131, existing browser measurement harness.

## Global Constraints

- User reports the optimizer needs approximately 16 GiB; the old 12 GiB cap is insufficient to test that workload.
- Thirty minutes is a guideline and may be exceeded when needed.
- Use standard `ubuntu-24.04`; no paid larger runner is provisioned.
- Dedicated swap: 16 GiB, with at least 20 GiB free disk checked before creation. Existing runner swap stays active.
- Optimizer address-space cap: 24 GiB (`ulimit -v 25165824`); this is not an RSS cap or a guarantee of 24 GiB physical RAM.
- Optimizer emergency timeout: 90 minutes. WASM job emergency timeout: 150 minutes, including build and browser measurement.
- No heavy local builds or local browser profiling. Local checks are static configuration checks only; CI verifies execution.
- No deployment. Work remains on `ci/stdlib-cache-validation`; preserve existing local generated changes.
- Keep one optimizer worker, core dumps disabled, input/output validation, actual/requested optimization metadata, and explicit failure when optimization was not applied.

## Task 1: Configure and verify the hosted optimizer budget

**Files:**
- Modify: `.github/workflows/stdlib-cache-ci.yml` (job deadline, swap setup and cleanup).
- Modify: `scripts/ci/stdlib_cache.sh` (optimizer limits and telemetry).

**Interfaces:**
- Consumes: existing `core_opt=O1` dispatch and `RUNNER_TEMP`.
- Produces: the same preview/artifact identities and optimization outcome fields, plus `ci-logs/optimization-environment.log` and periodic memory/swap telemetry.

- [x] Add a conditional setup step before the WASM build. Check free bytes with `stat -f`; require 21,474,836,480 bytes. Create `$RUNNER_TEMP/rubrc-optimizer.swap` with mode 0600, allocate 16 GiB, then run `mkswap` and `swapon`. Log `free -m`, `swapon --show`, and `df -h`.
- [x] Add an `always()` cleanup step for `core_opt=O1`. Disable only that dedicated swap file if active, then remove it. Leave pre-existing swap untouched and keep artifact upload after cleanup.
- [x] Set the WASM job timeout to 150 minutes. Change the optimizer command to `ulimit -v 25165824` and `timeout --kill-after=30s 90m`.
- [x] Extend the 15-second monitor with `swapon --show --bytes` and process CPU utilization. Emit one explicit checkpoint after 1,800 seconds and continue; do not convert that checkpoint into a failure.
- [x] Run `bash -n scripts/ci/stdlib_cache.sh`, `/tmp/opencode/actionlint -shellcheck= -pyflakes= .github/workflows/stdlib-cache-ci.yml`, and `git diff --check`. Review the small diff; there is no application behavior change requiring new application tests.
- [ ] Commit only these configuration files and this plan with `[skip ci]` and AI disclosure. Push the validation branch.
- [ ] Dispatch one `mobile-baseline` run with `core_opt=O1`, using `gh workflow run stdlib-cache-ci.yml --repo oligamiq/rubrc --ref ci/stdlib-cache-validation -f mode=mobile-baseline -f core_opt=O1`.
- [ ] Observe the hosted resource log. If the run exceeds 30 minutes, evaluate logged CPU progress, RSS, swap and elapsed time rather than treating elapsed time alone as failure. Preserve any failed result accurately.
- [ ] Download the small diagnostic artifact; verify actual optimization outcome, peak memory and subsequent build/browser steps before reporting success. Update this plan with the run URL and evidence.

## Follow-on

Move CPU/linear-memory profiling into an artifact-replay CI mode after the execution environment is established. The existing preview from run `38821782668` is available until 2026-10-16 23:29:31 UTC; use it while available, or the new verified preview if optimization succeeds. Do not conflate an environment-capacity correction with an application performance fix.

## Review notes

A narrowly scoped second review found no critical blocker. The 150-minute job
budget was checked against the previous hosted run: setup/build/packaging took
about 16 minutes including its short failed optimizer attempt, and measurements
took about 16 minutes. The new 90-minute optimizer ceiling therefore leaves
meaningful margin in this workload, rather than assuming zero setup time.

Normal/error-path cleanup is explicit, but it is not guaranteed after runner
loss or a hard job cancellation; the hosted VM is ephemeral. The dedicated swap
path uses the same `RUNNER_TEMP` value in setup and cleanup. Do not suppress
`swapoff` failures and then remove an active swap file. GNU `stat` usage is
intentional for the pinned Ubuntu runner. The 24 GiB virtual cap remains a budget
to measure, not proof of the optimizer's actual peak requirement.
