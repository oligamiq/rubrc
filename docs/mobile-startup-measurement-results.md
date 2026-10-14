# Post-sysroot startup: desktop and physical Android results

## Scope and build identity

These are baseline investigations, including failures, **not a successful mobile
acceptance result or an implemented speed improvement**. The public site was not
updated. All device runs used the same CI-produced preview:

- Preview source: `00efe87526f91f38f01abb741d39ef6ebea415c3`.
- Analyzer source: `07e8d30e340e504655ebace245a8df17f7f91fbf`.
- [Build/initial measurement run 38349646438](https://github.com/oligamiq/rubrc/actions/runs/38349646438).
- [Desktop replay 38419549510](https://github.com/oligamiq/rubrc/actions/runs/38419549510).
- Preview archive SHA-256: `426d728c60e0b3a89247aeea36e351cb54993aba29c508656f95249276c3b254`.
- Decoded VFS SHA-256: `9a9d689541a068adaf20e7d52d2983ee21ff18a699dc9ac35369f8eeef887488`.
- Cache SHA-256: `c5051deb1c0def0b927519508731b1dd42265d4f5e69cc401f4f169cb7e92e29`.

The archive was checked after downloading, and the extracted VFS parts were
stream-decompressed and hashed again; the cache parts were also concatenated and
hashed. Both matched the CI identities. The VFS build remains the diagnostic
`--dev --features debug-log` configuration, not the final production optimization.
Its VFS core is 469,322,255 bytes decoded and 102,919,530 bytes Brotli-compressed.

## Network conditions and calibration

- Normal: no imposed network limit.
- Constrained: 625,000 bytes/s download (5 Mbps), 125,000 bytes/s upload (1 Mbps),
  and 150 ms configured added latency.
- One shared page-level CDP rule, inherited by Workers; no separate bandwidth
  allowance assigned to each Worker.
- Two concurrent dedicated Workers fetched 2 MiB each from the test server.

| Device | Total probe bytes | Normal | Constrained |
| --- | ---: | ---: | ---: |
| Hosted desktop Chrome 150 | 4,194,304 | 26.5 ms | 6,872 ms |
| Physical Pixel 6a / Chrome 154 | 4,194,304 | about 125–138 ms | about 6,931–6,972 ms |

The concurrent transfer verifies the aggregate download limit and Worker coverage.
Upload rate was configured but not independently calibrated. Worker events in
these browsers omitted the optional applied-rule ID; that absence is recorded,
not treated as proof. The measured Worker transfers provide the additional evidence.
The network profile is controlled emulation, not a claim of reproducing every
aspect of a cellular radio network.

## Desktop results

The final replay used a fresh browser/test origin for cold loading, followed by
same-origin reload. Cache load/merge succeeded. Main analysis pool: 2 workers.

| Normal network | Total to ready | After both sysroots ready | Project activation | Semantic warming |
| --- | ---: | ---: | ---: | ---: |
| Cold | 122.879 s | 75.369 s | 13.218 s | 61.712 s |
| Reload | 91.282 s | 76.194 s | 12.285 s | 63.476 s |

An earlier run of the same preview measured 94.601/98.296 seconds after sysroot
readiness, with 68.169/76.102 seconds in semantic warming. Do not present the
variation between runners as an optimization gain. These are individual trials.

Sysroot times come from the VFS status poll's first observation of each archive
being ready (nominal 50 ms polling), not the coordinator's coarse task labels.
Semantic warming includes the readiness contract's diagnostic/inlay-hint wait;
these phase timings alone do not identify the CPU cost of individual Salsa queries.

Actual editor operations were also exercised on desktop:

- Inserted source through CDP's input interface, triggered Monaco suggestions,
  verified visible standard-library suggestions and inspected the screenshot.
  Trigger-to-visible suggestion time: approximately **3.574 s**.
- Inserted a string assigned to `u32`, observed the expected type-mismatch marker,
  and inspected the screenshot. Input-to-observed marker: approximately **0.335 s**.
- Screenshot encoding is excluded from these durations. These are end-to-end
  interaction timings, not isolated server execution times.

The first harness revision incorrectly called a nonexistent Puppeteer method and
expected completion messages from a filtered test event sink. It was corrected;
the replay reused the existing archive rather than rebuilding WASM.

### Constrained desktop run

The required rust-src fetch hit the application's fixed 60-second archive timeout.
Startup did not complete. The failed UI phase was recorded about 371 seconds into
navigation, after other initialization work. The harness then over-waited because
it threw inside a polling callback; this reporting bug is now corrected to resolve
on a failed state and throw outside the polling loop. The old 600-second harness
timeout is not an application startup duration or a successful sample.

## Physical Pixel 6a results

This was the USB-connected physical Pixel 6a (Android 17, Chrome 154.0.8037.126),
not the available Android emulator. Testing used dedicated localhost origins via
ADB reverse. Existing browser profiles and unrelated tabs were preserved.

- **Normal network, default configuration (4 main analysis workers):** cache
  validation 1,189 ms, decode 14,333 ms, merge completed; renderer terminated about
  83.5 seconds into startup. Android recorded `LOW_MEMORY` with approximately
  **3.0 GB renderer RSS**. Ready/completion/diagnostic acceptance was not reached.
- **Constrained network:** calibrated 4 MiB Worker transfer took 6.972 s. The target
  sysroot fetch hit the fixed 60-second timeout; startup failed before analysis.
  This case is a failure, not a mobile speed result.
- **Configuration experiment:** the page's reported CPU count was overridden from
  8 to 1 to select a one-worker analyzer configuration. Hardware was not emulated
  or reduced. This also failed (`LOW_MEMORY`, about 3.2 GB RSS, about 53.3 seconds).
  It does not support adopting a worker-count reduction as a sufficient fix.
- **Without a CDP debugging session:** opening the same preview directly in Chrome
  also produced the visible “Aw, Snap!” page. Android recorded another foreground
  renderer `LOW_MEMORY` exit around that attempt (about 3.2 GB RSS). The failure is
  therefore not confined to the network-instrumented test session.

No successful mobile edit/completion/diagnostic result is claimed. Temporary
forwarding rules and the test server were removed, and the device's original
stay-awake setting was restored. Raw device identifiers/history remain local.

## Conclusions and next changes

1. **Post-sysroot computation is substantial even on desktop:** 75–98 seconds,
   dominated by the 62–76-second semantic-readiness phase. More download tuning
   alone will not remove it. Profile the initial diagnostics/inlay work before
   selecting a query-cache or scheduling change.
2. **Mobile memory is a first-order blocker:** examine production WASM optimization
   and initialization/instance memory, then consider separating the LSP runtime
   from compiler/LLVM code if necessary. Worker-count reduction alone did not pass.
3. **Slow-link startup currently fails:** replace the archive's fixed transfer
   deadline with progress-aware stall detection plus an overall bound. Continuing
   data should not be mistaken for a stalled connection. Surface failures promptly
   while preserving safe cleanup. This improves reliability, not parsing speed.

One WASM build was used for these tests. The build run and replay consumed about
40.1 hosted runner-minutes in total, using standard public-repository Linux
runners. The preview archive is 119,273,655 bytes and its uploaded artifact was
retained for one day; no deployment was performed.
