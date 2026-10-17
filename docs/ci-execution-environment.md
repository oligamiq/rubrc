# Hosted execution environment

Heavy builds, optimizer runs and browser profiling belong on GitHub-hosted
Ubuntu runners. The local PC has a confirmed RAM fault and is used for editing,
CI control and inspection; local performance measurements are diagnostic only.
The public site is not part of these validation workflows.

## Optimizer budget

The user expects approximately 16 GiB optimizer memory usage. Thirty minutes is a
progress guideline, not a mandatory timeout. Standard public-repository
`ubuntu-24.04` provides four CPUs and approximately 16 GiB RAM; additional swap
allows the workload to exceed available physical RAM without a paid larger runner.

Current configuration:

- A dedicated **32 GiB swap file**, alongside existing runner swap. Setup requires
  at least 48 GiB free disk, leaving 16 GiB for builds, and fails before the heavy
  build if unavailable.
- A transient systemd service running as the runner user, with **MemoryHigh=11G**,
  **MemoryMax=12G**, **MemorySwapMax=28G**, and **LimitAS=infinity**.
- These are cgroup resident/accounted-memory and swap controls; they leave room
  for the OS and runner. The budget is not a promise of 40 GiB physical RAM.
- One Binaryen worker, no core dumps, a 30-minute logged progress checkpoint,
  a 90-minute emergency service deadline and a 150-minute whole-job deadline.
- Every 15 seconds: RAM, swap, optimizer RSS/VSZ/CPU, and cgroup memory status.
- Optimizer outcome and `/usr/bin/time` report are printed into the job log as
  well as retained in the short-lived diagnostic artifact.
- Validation precedes core replacement. Failure retains the original valid core,
  records actual optimization `none`, and explicitly fails the optimization gate.
- Cleanup stops the exact optimizer service before disabling/removing the
  dedicated swap file, including when its CLI client was cancelled. Hard runner loss can
  prevent cleanup steps; the hosted VM itself is ephemeral.

## Why address-space limits were replaced

The original 12 GiB virtual-address-space cap was below the expected workload.
Run [38952582136](https://github.com/oligamiq/rubrc/actions/runs/38952582136), source
`8bca8d783a20ad3db8ece33b8ecfedba1dcde7f8`, tested 16 GiB additional swap and a
24 GiB virtual cap. Swap setup, build, preview generation, both desktop network
profiles, and swap cleanup passed. The optimization gate failed.

Surviving job-log evidence:

- Total swap increased from 3,071 to 19,455 MiB.
- Peak sampled optimizer RSS: 15,199,976 KiB (approximately 14.50 GiB).
- VSZ reached 25,151,200 KiB and stayed there from 1:30 through the last 6:15
  sample, within about 14 MiB of the imposed 25,165,824 KiB limit.
- Peak system swap usage was 11,380 MiB. At the last sample, 8,729 MiB swap and
  1,938 MiB available RAM remained.
- The job log did not expose the optimizer's exact error or termination signal.
  The one-day timing artifact had expired before retrieval. The evidence strongly
  implicates the address-space cap but does not independently prove the signal or
  exact allocation failure.

The current cgroup design removes that address-space confounder while retaining
a finite working-set/swap budget. Its outcome still needs hosted verification.
Simply increasing RAM or swap while leaving a restrictive `ulimit -v` would not
address this observed limitation.

Expired artifacts can coexist with retained job logs. If `gh run view --log`
returns an empty file, retrieve the job log directly with
`gh api repos/oligamiq/rubrc/actions/jobs/<job-id>/logs` and verify its byte length.
The directly retrieved log for job `117148904406` was 1,048,434 bytes.
