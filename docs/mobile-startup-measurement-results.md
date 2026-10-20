# Post-sysroot startup: desktop and physical Android results

## Scope and build identity

These are investigations, including failures, **not a successful mobile
acceptance result or an implemented speed improvement**. The public site was not
updated. The initial baseline device runs used the same CI-produced preview
listed below. The timeout-fix follow-up has its own build identity and results
at the end of this report.

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

## Initial baseline conclusions and next changes

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

## Timeout-fix follow-up — 2026-10-16

### Verified build and CI outcome

- [Run 38821782668](https://github.com/oligamiq/rubrc/actions/runs/38821782668).
- Source: `7c7845ea61be1a5ff0fd225264ea45701e33e1e1`.
- Analyzer: `07e8d30e340e504655ebace245a8df17f7f91fbf` (unchanged).
- Archive SHA-256: `0baf3ee4f204b9d881f0352122964f9b583afc03444eb83daab8afb3ed8ec9b2`.
- Decoded VFS: 469,321,933 bytes, SHA-256
  `7412bcd33ffcb11933c84176b7ace1e0c15001fea61285c96c9e73a6b09aeb8e`.
- Cache: 34,545,183 bytes, SHA-256
  `59ebe3d9afa9baae2cb9160414cf392c4687a0f3d0efa48367b0c793bbd21c72`.

The downloaded archive matched the CI checksum; streamed decompression of the
VFS and concatenation of the cache parts matched their manifests independently.
Both desktop and physical-device tests used this preview. Metadata explicitly
records `coreOptimizationRequested: "O1"` and `coreOptimization: "none"`.

Targeted regressions, build, preview packaging, and desktop normal/constrained
measurements passed. The overall workflow **failed** at the explicit optimization
failure-reporting step. The optional optimizer terminated with signal 6 after
2:14.49, with maximum RSS 12,337,208 KiB (about 11.77 GiB). Sampled virtual size
reached 12,568,288 KiB, close to the configured 12,582,912 KiB limit. This is
consistent with memory pressure at the imposed limit, but the retained logs do
not contain a specific allocation-failure diagnostic proving the abort cause.
The original validated core was retained; no optimized-core benefit is claimed.

### Desktop: slow-link startup now completes

Hosted Chrome 150, 2 main analysis workers, same normal and constrained profiles
as the baseline. Concurrent Worker calibration transferred 4 MiB in 29.6 ms
normally and 6.874 s under the shared 5 Mbps limit.

| Network / visit | Total to ready | After both sysroots ready | Project activation | Semantic warming |
| --- | ---: | ---: | ---: | ---: |
| Normal / cold | 134.324 s | 107.231 s | 16.045 s | 90.732 s |
| Normal / reload | 119.753 s | 106.225 s | 15.164 s | 90.644 s |
| Constrained / cold | 522.586 s | 106.145 s | 15.633 s | 90.088 s |
| Constrained / reload | 141.128 s | 108.566 s | 22.743 s | 85.386 s |

All four reached `ready` with cache load/merge confirmed. The constrained cold
case takes about 8 minutes 43 seconds overall; it is a reliability pass, not an
acceptable speed result. Post-sysroot time remains approximately 106–109 seconds,
dominated by semantic readiness. These individual trials and the earlier runner
results are not a controlled speed comparison.

After reload, actual editor input produced standard-library suggestions and the
expected `u32`/string type-error marker in both profiles:

| Network | Trigger to visible suggestions | Input to observed diagnostic |
| --- | ---: | ---: |
| Normal | 6.526 s | 0.348 s |
| Constrained | 4.983 s | 0.510 s |

The constrained completion and diagnostic screenshots were also inspected.
Screenshot encoding is excluded from the timings.

### Physical Pixel: memory failure remains

The attached Pixel 6a now runs Chrome **155.0.8059.79**, updated since the Chrome
154 baseline. Its reported CPU count remained 8; no worker-count override was
applied. Browser-version and device-state differences preclude a controlled
before/after performance comparison.

Concurrent 4 MiB Worker calibration took 133.8 ms normally and 6.938 s under the
shared 5 Mbps profile. Cold-load outcomes:

| Network | Time until crash | Last cache evidence | Android exit reason / renderer RSS |
| --- | ---: | --- | --- |
| Normal | 80.058 s | Loaded, merge prepared, merged | `LOW_MEMORY`, about 2.8 GB |
| Constrained | 367.176 s | Loaded, merge prepared | `LOW_MEMORY`, about 2.7 GB |

Normal cache validation/decode took 1.396/16.043 seconds; constrained
validation/decode took 1.379/25.741 seconds. The constrained attempt reached cache
restoration rather than the former fixed archive-timeout failure, but no completed
merge or ready state was observed. Neither case reached reload or editor
interaction acceptance. A renderer crash prevents a final page-state snapshot;
do not substitute time-to-crash for time-to-ready or post-sysroot duration.

Failure JSONL/network records were retained locally. Android exit history
corroborated both foreground renderer low-memory kills. Dedicated test tabs were
closed, storage for test origins 4187/4188 was cleared, forwarding rules were
removed, and no test-port listeners remained. The original stay-awake setting
remained 15 throughout this follow-up.

### Remaining work

The progress-aware transfer fix has a verified constrained-desktop pass. It does
not solve the large runtime's mobile memory requirement or the desktop semantic
warming delay. Next, attribute runtime memory and profile initial diagnostics /
inlay work before selecting a targeted optimization or an LSP/compiler split.
Repeating the same final-core `O1` experiment without new evidence is not justified.
No further hosted build was dispatched for these checks, and no deployment or
main/develop update was performed.

Subsequent profiling identified repeated physical thread-margin reservation and
substantial generated memory-lock overhead. See
[`startup-memory-root-cause.md`](startup-memory-root-cause.md) for the evidence,
unsuccessful probes, and the proposed bounded reservation fix. Mobile acceptance
remains incomplete.

## Coupled O1 build: retained desktop results — 2026-10-20

Run [39187476371](https://github.com/oligamiq/rubrc/actions/runs/39187476371)
succeeded on source `c421e9e2ae81c2a52d33ec28579425dcabb7b873`, with analyzer
`07e8d30e340e504655ebace245a8df17f7f91fbf`. Unlike the earlier standalone optimizer
replay, this build generated matching JS bindings, applied O1, executed that core
to create the cache, and ran browser acceptance on the packaged application.

- Actual optimization was `O1`, with no optimization failure flag.
- Core size: 469,321,933 → 442,865,430 bytes; optimizer elapsed 24min 34.93s.
- Generated cache: 34,545,184 bytes; packaged SHA-256
  `3e9a10a9c5bc5a686ad74627c163c8ab001635bda8bf358c8a8953f1d06b6174`.

| Desktop profile / visit | Total to ready | Post-sysroot | Project activation | Semantic warming |
| --- | ---: | ---: | ---: | ---: |
| Normal / cold | 173.182 s | 151.551 s | 21.841 s | 129.116 s |
| Normal / reload | 170.886 s | 152.571 s | 22.133 s | 129.872 s |
| 5 Mbps / cold | 519.600 s | 150.685 s | 21.397 s | 128.689 s |
| 5 Mbps / reload | 189.750 s | 153.013 s | 22.137 s | 130.284 s |

Both network profiles passed actual completion/type-error checks. Completion
observation took 7.193/7.996 seconds (normal/constrained); diagnostics took
1.046/1.041 seconds. All four startup records reported `ready`, cache load and
merge, empty missing-asset lists and no worker setup errors. The reported
`moved_source_root_files=0` describes source-root relocation, not zero cache adoption.

These measurements show that a substantial post-sysroot wait remains after O1.
They are not a same-runner paired comparison against the earlier unoptimized
results and do not prove an optimization speedup or regression.

The one-day preview and diagnostic artifacts expired before physical-device
testing. No Pixel result is claimed for this build. The retained job log for job
`117853817085` was retrieved through the API (1,149,236 bytes); its structured
records were parsed and checked for the outcomes above. Screenshots and the
expired preview were not recovered from the log.

To prevent another artifact-loss cycle, mobile preview and associated build logs
now have three-day retention, and the next run will use a background controller that
downloads the archive/logs and verifies the archive checksum upon completion.
The measurement job also records CPU model, RAM and swap state for interpreting
runner-to-runner variation. The next generated preview is the one to use for Pixel.

## Same-build optimized desktop and Pixel acceptance — 2026-10-20

Run [39382409899](https://github.com/oligamiq/rubrc/actions/runs/39382409899) passed
the coupled O1 build, cache generation and desktop acceptance. The background
controller downloaded the preview and logs successfully and checked the archive
hash. The same preview was then tested on the physical Pixel.

- Source: `d30db4876887d8adc52fb8b39fd58ef22208f5a6`.
- Analyzer: `07e8d30e340e504655ebace245a8df17f7f91fbf`.
- Actual optimization: `O1`.
- Archive SHA-256: `34b980ca5fd9cf98969c1cdc5567d2341b5df953665202719d1372fac814b3a6`.
- Core: 442,865,430 bytes, SHA-256
  `99014fe74dce6787d9037d02725e34f403c0467e3d9e10e93c083dd0ef121cc4`.
- Cache: 34,545,184 bytes, SHA-256
  `fa02bfb9944aa1d8d98e7e16a391838d77ca10c3c602f7e4b1257b9f9d99c71d`.

Streamed decompression/concatenation hashes matched the manifests and CI core/cache
checksums. Local preview: `/tmp/opencode/optimized-device-preview-39382409899`.

### Desktop

Runner: AMD EPYC 7763 model, four exposed CPUs, about 16 GiB RAM. Before measurement
it reported 14,753 MiB available RAM and 136 MiB used swap. Normal and shared
5 Mbps / 150 ms constrained networking both passed cold/reload readiness, cache
load/merge, asset coverage and editor checks.

| Profile / visit | Total to ready | Post-sysroot | Project activation | Semantic warming |
| --- | ---: | ---: | ---: | ---: |
| Normal / cold | 125.608 s | 89.915 s | 26.179 s | 63.215 s |
| Normal / reload | 114.019 s | 89.896 s | 14.299 s | 75.081 s |
| Constrained / cold | 484.559 s | 89.942 s | 19.447 s | 69.957 s |
| Constrained / reload | 131.214 s | 94.544 s | 19.358 s | 74.677 s |

Completion/diagnostic observations took 7.035/0.434 seconds normally and
5.318/0.419 seconds under the network limit. The earlier O1 run's 150–153-second
post-sysroot measurements and these 90–95-second measurements demonstrate why
different hosted runs must not be treated as a controlled optimization comparison.
There is still a substantial wait, principally in semantic readiness.

### Physical Pixel 6a

Chrome 155.0.8059.79, reported CPU count 8, no CPU-count override. Shared two-Worker
4 MiB calibration took 137.6 ms normally and 6.894 s with the 5 Mbps profile.

| Profile | Time to renderer crash | Last cache evidence | Android outcome |
| --- | ---: | --- | --- |
| Normal | 61.461 s | Loaded; validation 1.456 s, decode 17.150 s | `LOW_MEMORY`, RSS about 2.9 GB |
| Constrained | 347.017 s | Loaded; validation 1.327 s, decode 15.367 s | `LOW_MEMORY`, RSS about 2.8 GB |

Neither case reached cache-merge confirmation, ready, reload, completion or
diagnostic acceptance. These durations are time-to-crash, not startup completion.
Both Android exits were foreground renderer low-memory kills. Failure JSONL and
network records remain under `/tmp/opencode/pixel-optimized-39382409899`; raw
device exit history remains local. Dedicated origins were cleared, test tabs
closed, ports/forwarding removed, and the original stay-awake setting remained 15.

O1 alone therefore did not establish mobile acceptance. Before reducing host
reservation, measure its logical high-water and physical capacity explicitly:
own-memory logical growth cannot expand physical capacity automatically, and
filesystem storage shares the host heap with stacks. A test-only capacity observer
is the next diagnostic change; no reservation reduction has been applied yet.
