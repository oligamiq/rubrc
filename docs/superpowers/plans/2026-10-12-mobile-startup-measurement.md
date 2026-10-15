# Post-sysroot startup measurement

**Goal:** Reproduce the reported minutes-long delay with one identifiable CI build
on hosted desktop Chrome and the attached physical Pixel 6a, with normal and
verified constrained networking. Keep the public site unchanged.

## Scope

- Add test-only timestamps for phases and individual sysroot task completions;
  do not change readiness, scheduling or document lifecycle behavior yet.
- Use a dedicated test origin/tab; preserve existing browser profiles and data.
- Constrained profile: 5 Mbps down, 1 Mbps up, 150 ms added latency. Verify a
  known-size fetch from a dedicated Worker and record applied CDP network rules.
- Measure cold load and same-origin reload, cache adoption, first diagnostics,
  inlay responses, and explicit editing/completion/diagnostic interactions.
- Build WASM once in CI. Save a checksummed preview archive for one day, only on
  explicit measurement dispatch. Standard public Linux runner; no deployment.
- Capture timeouts, crashes and missing throttle coverage as failures, not fast runs.

## Steps

1. Test and add the timestamp recorder; connect it to the existing test API.
2. Add a bounded measurement driver and Worker throughput calibration. Use the
   same driver with a launched desktop browser or an attached Android browser.
3. Add explicit CI measurement/preview mode, run it once, download and verify the
   archive, then operate the physical device against that exact build.
4. Report post-sysroot timings separately from transfer/startup totals. Select a
   performance change only after the baseline identifies the dominant interval.

## Calibration checkpoint

On the physical Pixel 6a / Chrome 154, two concurrent dedicated Workers each
fetched 2 MiB from the test server. Total 4 MiB transfer took 125 ms unthrottled
and 6931 ms with the shared 5 Mbps / 150 ms page profile. This also checks that
bandwidth is shared rather than granting each Worker a separate 5 Mbps budget.
The optional CDP applied-rule ID was absent from Worker events in this browser;
the driver records that absence and uses acknowledged page configuration plus
the measured concurrent transfer as its calibration evidence.

## Outcome

Baseline measurements and physical-device trials were performed; see
`docs/mobile-startup-measurement-results.md`. Desktop normal-network startup and
editor interactions passed. Constrained networking failed on the application's
60-second archive deadline, and the physical Pixel renderer was killed for low
memory. The one-worker experiment and a non-CDP manual launch did not establish
a working mobile configuration. These failures are retained, not omitted from the
report. No application speed fix or successful mobile acceptance is claimed.

## Measured follow-up

The byte-download path now has a 60-second inactivity limit and a separate
10-minute total budget. Existing explicit `timeoutMs` values remain total caps;
parse-only and legacy archive paths retain their existing deadlines. Tests cover
progress beyond 60 seconds, idle cancellation and progress not bypassing the cap.

For mobile memory, run one optional `core_opt=O1` experiment on the final VFS core
using the standard runner, one Binaryen worker and a hard 30-minute optimization
limit. Validate before replacing the staged core and generate the Salsa cache
using that exact optimized runtime. Keep the default CI configuration unchanged.
This is a measured experiment; do not assume that optimization will make the
Pixel pass or claim a performance improvement before device verification.

The first optimization run (`38692166468`) ended when the hosted runner received
a shutdown signal (exit 143); no resource report survived, so the cause is not
classified as proven OOM. One guarded follow-up caps optimizer virtual memory at
12 GiB and logs usage every 15 seconds. A failed optimization retains the original
validated core for functional download testing, records the actual mode in the
preview metadata, and explicitly fails the optimization result rather than
silently reporting success.

The guarded follow-up (`38726643538`) stopped before building VFS because the
previously locked `am-fs-squashfs` release disappeared from the registry index.
Recovered the exact 0.1.3 archive from cache, verified its original locked SHA-256,
and vendored its unmodified source/license with provenance. All 28 extracted
upstream files matched the archive byte-for-byte; only this dependency's registry
source changed to a local path. This is build reproducibility recovery, not a
filesystem behavior upgrade. See `vendor/am-fs-squashfs/VENDORED.md`.
