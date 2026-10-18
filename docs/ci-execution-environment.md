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

The cgroup design removes that address-space confounder while retaining
a finite working-set/swap budget. Its hosted outcome is recorded below.
Simply increasing RAM or swap while leaving a restrictive `ulimit -v` would not
address this observed limitation.

Expired artifacts can coexist with retained job logs. If `gh run view --log`
returns an empty file, retrieve the job log directly with
`gh api repos/oligamiq/rubrc/actions/jobs/<job-id>/logs` and verify its byte length.
The directly retrieved log for job `117148904406` was 1,048,434 bytes.

## Cgroup verification outcome

Run [39068855482](https://github.com/oligamiq/rubrc/actions/runs/39068855482), source
`60310a0ddcd723a2b062a8c7e622d42b8c839734`, successfully provisioned dedicated swap,
validated the transient-service controls, and ran beyond the 30-minute checkpoint.
The optimizer then ended with **`oom-kill` after 36min 18.364s**. Systemd reported
**memory peak 12.0G**, **memory swap peak 28.0G**, and **CPU time 1min 46.650s**.
The `/usr/bin/time` file was empty after the cgroup kill; the systemd report in
`build.log` is the surviving termination evidence. Its reported main-process
signal was TERM; do not mistake that wrapper signal for successful optimization.

Both cgroup budgets were reached. This establishes failure within the configured
roughly 40 GiB accounted-memory-plus-swap envelope, rather than the previous
virtual-address cap or the 30-minute guideline. It does not establish an exact
unrestricted peak requirement. More swapping on the same standard runner is not
the next recommended experiment; consider a higher-RAM execution host before
another whole-core optimizer run.

Regression checks, fallback-core build, preview packaging, normal/constrained
desktop measurements, and dedicated-swap cleanup passed. The workflow remains
failed because its requested optimization did not apply. The preview is usable
for profiling, explicitly with actual optimization `none`:

- Archive SHA-256: `0859b89fe4031446a300646010dce19cb052fdcf86476681844fef1e0a72678b`.
- Core SHA-256: `b031c901476a2022ab4ce46ace2eea264c3d9c3e7aee6af335aa79c61e780d8d`.
- Cache SHA-256: `bd7deb6ce560fda1287c351aa74a5a0fd51a84ca4ec445038cd3cfca443a52d9`.

## Hosted profiling replay

Dispatch `stdlib-cache-ci.yml` with `mode=startup-profile` and `preview_run` set to
an available mobile-baseline run ID. The job downloads and verifies the existing
archive, installs the locked measurement dependencies, and runs the normal-network
cold/reload and editor checks twice: once with CPU sampling, once with OS-side
process-memory observation. No WASM rebuild is needed for this mode.

The observer rejects local/remote-browser invocation outside hosted CI. CPU profiles
are saved at each completed visit, capped at 64 MiB. Memory sampling records only
the launched browser process tree; it does not replace browser memory constructors
or attach an observer to utility-worker memory. A 12 GiB summed browser-tree RSS limit stops an over-budget browser;
shared pages can be counted more than once, so this is a conservative guard.
Instrumentation errors and missing coverage make the profiling command fail.

Each capture process has a 25-minute fallback deadline; the replay job allows
70 minutes for two sequential captures and setup. Artifacts use the mode name and
one-day retention. Profiled timings remain diagnostic, not baseline acceptance
speed comparisons.

### First hosted replay

Run [39087573235](https://github.com/oligamiq/rubrc/actions/runs/39087573235) reused
preview `39068855482` with harness `f468e227fa088557c5da7aac3b8c98df40735b86`.
Its CPU pass reached ready on cold/reload, passed editor checks, and saved 45
profiles including 34 WASI-worker profiles (11,071,856 bytes), with no recorded
instrumentation error. Profiled startup was 134.227/119.881 seconds and
post-sysroot time 98.123/100.156 seconds; these are instrumented observations.

The original memory pass wrapped `WebAssembly.Memory` to observe linear-memory
size. It stalled at `vfs-starting` until the 600-second startup deadline, with
the observed memory remaining at its initial 64.25 MiB. It did not crash, load
the Salsa cache, or reach ready. The cause was not established; the whole replay
is correctly failed despite successful CPU capture.

The next comparison removes constructor interception and uses OS-side RSS only.
That reduces observer interference and is sufficient for hosted process-memory
profiling, but does not provide per-guest allocation or linear-memory sizes.

### Verified hosted CPU and process-memory replay

Run [39089520461](https://github.com/oligamiq/rubrc/actions/runs/39089520461)
**passed**, using harness `f170bf601617256cb90d8c2e4321e05695a4046a` and the same
preview `39068855482` (source `60310a0ddcd723a2b062a8c7e622d42b8c839734`, actual
optimization `none`). No Rust/WASM build ran in this replay. Whole workflow
elapsed time was about 9 minutes 23 seconds.

Both modes reached ready on cold load and reload, confirmed cache load/merge,
and passed actual completion/type-error diagnostic checks. Instrumentation
reported no errors. Saved evidence:

| Mode | CPU profiles | WASI-worker profiles | Process-memory samples | Profile bytes |
| --- | ---: | ---: | ---: | ---: |
| CPU | 45 | 34 | 56 | 11,432,931 |
| OS memory | 0 | 0 | 48 | 0 |

Downloaded profile file counts and sizes matched their outcome records; WASI
worker samples were present for both cold and reload visits. Memory mode attached
no profiling sessions to worker targets and performed no constructor interception.

| Mode / visit | Total to ready | Post-sysroot | Semantic warming |
| --- | ---: | ---: | ---: |
| CPU / cold | 143.466 s | 98.149 s | 75.720 s |
| CPU / reload | 129.082 s | 104.484 s | 82.574 s |
| OS memory / cold | 117.094 s | 93.703 s | 77.321 s |
| OS memory / reload | 117.027 s | 96.505 s | 78.443 s |

Across each entire captured session (including reload and editor operations),
peak sampled renderer RSS was 5,312,528 KiB in CPU mode and 5,246,320 KiB in
OS-memory mode. Peak summed browser-tree RSS was 6,335,280 and 6,273,892 KiB,
respectively. Do not interpret these sums as unique physical memory, or their
differences as an application optimization. The OS-memory session's renderer
peak is approximately 5.00 GiB, within the hosted runner's capacity.

Completion/diagnostic observation took 7.544/0.492 seconds in CPU mode and
6.089/0.492 seconds in OS-memory mode. These remain instrumented observations;
the useful outcome here is a verified remote execution/measurement environment.
The earlier constructor-observed hang remains unexplained, not silently reclassified
as a confirmed application bug or fully attributed instrumentation defect.

## Capacity still needed for whole-core optimization

Hosted startup profiling is now verified. Whole-core `wasm-opt` is a separate,
unresolved resource requirement: the 12 GiB memory plus 28 GiB swap service was
killed at its limits. No further identical optimization run has been dispatched.
There are currently no self-hosted runners registered for this repository
(`actions/runners` returned `total_count: 0`). A higher-RAM machine (64 GiB or
more as a candidate, not a guaranteed sufficient size) is the recommended next
capacity experiment. Execution-host selection and any associated costs need a
user decision. No paid runner/VM has been provisioned.
