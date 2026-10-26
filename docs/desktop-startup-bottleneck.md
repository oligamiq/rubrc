# Desktop startup bottleneck investigation — 2026-10-25

## Scope and identity

Mobile memory optimization and device acceptance are on hold at the user's
request. The active goal is desktop post-sysroot startup latency, including
usable completion and diagnostics.

Hosted profiling run
[40165755028](https://github.com/oligamiq/rubrc/actions/runs/40165755028)
passed using harness `86a2524cba3440ef09c173af62a78057d263869d`. It reused the
unchanged preview from run `39922942192`, application source
`1a26d22604ca850970af893657c647e9c286314a`, analyzer
`07e8d30e340e504655ebace245a8df17f7f91fbf`, actual core optimization `O1`, and the
512 MiB initial-heap option. No Rust/WASM build ran in this replay.

The archive was verified by the replay workflow. Local streaming reconstruction
also checked the decoded core against both its manifest and the original CI
checksum: 442,865,444 bytes, SHA-256
`c45fced3ae036c8a933a6a6d3c35d9313df6021dbf7ef37f5fff5e461887faa8`.

## Desktop acceptance

Both passes used normal networking, headless Chrome 150.0.7871.24, four reported
CPUs and two analyzer main-pool threads. CPU sampling and OS-memory observation
ran sequentially in fresh browser processes. The profiling mode does not record
the runner CPU model, so no specific model is inferred here.

| Pass / visit | Total to ready | Post-sysroot | Semantic warming |
| --- | ---: | ---: | ---: |
| CPU / cold | 121.849 s | 75.424 s | 57.565 s |
| CPU / reload | 90.364 s | 75.657 s | 58.178 s |
| OS memory / cold | 117.342 s | 73.572 s | 60.332 s |
| OS memory / reload | 89.313 s | 75.017 s | 62.904 s |

All four visits reached ready, adopted the cache, retained valid initial-heap
capacity snapshots, and had no missing assets or worker setup errors. Editor
completion/type-error checks passed in both sessions: completion/diagnostic
observation was 3.489/0.392 seconds in CPU mode and 4.358/0.411 seconds in memory
mode. Peak sampled renderer RSS was 4,724,772 / 4,918,904 KiB respectively.

The CPU pass saved 45 profiles, including 34 WASI-worker profiles, totalling
9,240,695 bytes; there were 43 process-memory samples. The separate memory pass
saved 42 process-memory samples. Both instrumentation outcomes reported no errors.
Downloaded profile counts and byte sizes were checked against those outcomes.

These approximately 58–63-second semantic-warming observations do **not** establish
an improvement over the approximately 133 seconds from the original acceptance
run. The application is identical, but these are separate hosted allocations and
instrumentation sessions. Paired comparisons on the same runner are needed for
subsequent optimization claims.

## What the readiness phase actually waits for

`RustAnalyzerReadiness.waitForSemanticReadiness` waits for versioned diagnostics
for the current document, then sends a full-document `textDocument/inlayHint`
request. It retries if the document generation changes or the response reports
ContentModified. Its ordinary polling delay is 250 ms, not a fixed minute-scale
sleep. `activateRustProject` enters this phase after crate-graph readiness and the
existing didClose/didOpen sequence.

The saved CPU visit events show diagnostic publications near the beginning and
end of semantic warming. They do not identify which publication satisfied the
version check. The current message recorder filters out inlay-hint requests and
responses; the diagnostic-publication counter also omits the diagnostic version.
Consequently, the saved events cannot divide the phase precisely into diagnostic
waiting versus inlay-hint request time. This is a telemetry limitation, not a
reason to bypass the readiness gate.

## O1 still spends substantial sampled time in read-lock helpers

Function indices were resolved from the **same verified optimized core**, rather
than reusing the indices from earlier unoptimized builds:

| Function index | Identity |
| ---: | --- |
| 1457 | `__wasip1_vfs_memory_lock_read_acquire` |
| 1460 | `__wasip1_vfs_memory_lock_read_release` |
| 1455 / 1464 | Write acquire / release |
| 261 | LSP guest base-offset getter without waiting |
| 279142 | `memory.atomic.wait32` wrapper, verified from its function body |
| 279143 | `memory.atomic.notify` wrapper, verified from its function body |

Two prominent analysis-worker captures have the following leaf-sample weights:

| Capture | Whole captured interval | Read acquire | Read release | Wait32 wrapper |
| --- | ---: | ---: | ---: | ---: |
| `cpu-cold-8.cpuprofile` | 117.059 s | 8.785 s | 28.110 s | 15.518 s |
| `cpu-reload-30.cpuprofile` | 86.011 s | 9.273 s | 28.823 s | 14.741 s |

These are sampled wall-time weights across each worker's **whole startup visit**,
not phase-isolated on-CPU times. Blocking and scheduling remain visible. They
must not be summed across workers as elapsed startup time, or interpreted as the
amount of time an optimization will save.

The optimized read-release body is only 30 bytes: it atomically decrements the
reader count and, if the previous count was one, calls function 279143. This
matches WVL 0.10.0 `shared_global.rs`: the last reader notifies even when no writer
is waiting. `multi_memory_lowering.rs` emits read acquire/release around each
lowered guest memory access. O1 has not eliminated that protection or notification
path.

## Next optimization decision

The evidence prioritizes the per-access lock path over the sysroot-only Cargo
bypass for desktop latency. Three possible approaches are:

1. **Waiter-aware notification (recommended design candidate).** Retain relocation
   exclusion and read/write synchronization, but avoid the last-reader notify
   when nobody needs waking. Waiter registration and the state recheck must form
   a protocol that cannot lose a wakeup. A naive independent boolean is not a
   sufficient design. This targets the hottest observed helper while preserving
   the memory-access boundaries.
2. **Paired analyzer thread-count experiment.** Use the existing CPU-count override
   to compare one versus two analyzer workers on one hosted runner and unchanged
   preview. This is relatively cheap diagnostic work, but lower contention may be
   offset by reduced parallel work and more last-reader notifications.
3. **Batch locks or separate memories/runtimes.** Potentially remove much more
   per-access overhead, but require wider correctness work around growth,
   relocation, blocking instructions, traps and host calls.

No lock algorithm has been changed. Before implementing option 1, approve its
scope and specify/test the wakeup protocol: reader-release versus writer-parking
races, multiple readers/writers, writer release waking readers, and concurrent
guest growth with address/data integrity. Preserve existing readiness, fresh
toolchain checks and cache validation. Measure baseline/candidate sequentially on
the same hosted runner with the same editor acceptance checks. Add request/version
timing if precise diagnostic-versus-inlay attribution is needed.

## Saved evidence

Downloaded profiles, startup records, screenshots and the locally checked summary:
`/tmp/opencode/hosted-optimized-profile-40165755028/`.

Diagnostic scripts:

- `/tmp/opencode/verify-desktop-profile-20261025.mjs`
- `/tmp/opencode/summarize-hosted-cpu-20261025.mjs`
- `/tmp/opencode/inspect-profile-core-20261025.mjs`
- `/tmp/opencode/read-profile-functions-20261025.mjs`

Decoded core: `/tmp/opencode/profile-core-39922942192.wasm`. These local paths are
working evidence, not durable artifact storage; the CI profiling artifact has
one-day retention. The behavioral conclusions above are recorded in this document.

## Waiter-aware lock: paired desktop result — 2026-10-26

The user approved implementing the waiter-aware notification experiment and then
approved treating the two reproduced **non-threaded** reset failures as
non-blocking diagnostics. The threaded gate passed in
[40281888849](https://github.com/oligamiq/wasi_virt_layer/actions/runs/40281888849):
9 baseline / 11 candidate native tests, both generated modes surviving 32
physical relocations with sentinel data intact, generated release-guard checks,
the threaded own-memory pool and atomic-wait-reset checks. The excluded reset
cases still failed on both the experimental tree and untouched 0.10.0; their
outcomes are recorded explicitly, not counted as passing tests.

### Build and comparison identity

[Run 40282800079](https://github.com/oligamiq/rubrc/actions/runs/40282800079)
passed both coherent builds and the sequential A–B–B–A desktop acceptance job.
Both variants used:

- Rubrc source `35989beea2cee0ef724da1f1a8a396a256fb0c54`.
- Analyzer `07e8d30e340e504655ebace245a8df17f7f91fbf`.
- WVL library `5d47aaf436163ca6886fcc5b4ff3af1a52cb7298`; CLI 0.10.0.
- Actual O1 and 536,870,912-byte initial VFS heap.
- The same analyzer WASM SHA-256:
  `375388644c5f4395a3e1e9917b7f10a3f04a6e5031b37619222f4e599f310d5d`.

The only selected build-mode difference was the opt-in
`waiter-aware-memory-lock` feature. Both previews contained freshly generated
core/bindings/cache/page sets. Replay checked the archives, decoded core and
cache against manifests and independent build checksums, confirmed identical
analyzer binaries and required distinct core binaries.

| Artifact | Baseline | Candidate |
| --- | --- | --- |
| Optimized core bytes | 442,865,739 | 442,865,584 |
| Core SHA-256 | `ffbf9972c599a0e3a7f17c5be5f9ddf571f0e7c2e5fa6b9c07747779fe51dd57` | `eb3e8276c371e24faf9f29647c99dd0302403527fd0ff5edf23e53f23492c1b6` |
| Cache SHA-256 | `80a05c57ae5e9ae097d8f760dd32a89975281bc4873292978c81d6e34da061c5` | `67831e17246eca3d3f77f86413699c2e08689a9e04d7cee804c051946a295c51` |
| Preview archive SHA-256 | `a2f1daab12f196b06344455227834a66b9dfa09d6c8a5a821f13dd2e8d53ea93` | `facb1d800280bababea40de6e3d9e239330907eb6477526d135fc42024da3090` |

### Same-runner measurements

One hosted Ubuntu runner, AMD EPYC 7763, four exposed CPUs, Chrome
150.0.7871.24, two analyzer main-pool workers. Each session used a fresh browser,
normal networking, cold load then reload, and real editor acceptance. Primary
timings had no CPU sampling; identical OS-memory observation ran in all sessions.

| Order / mode / visit | Total to ready | Post-sysroot | Semantic warming |
| --- | ---: | ---: | ---: |
| 1 / baseline / cold | 140.284 s | 92.124 s | 72.264 s |
| 1 / baseline / reload | 116.115 s | 96.391 s | 75.099 s |
| 2 / candidate / cold | 95.620 s | 48.623 s | 33.538 s |
| 2 / candidate / reload | 68.010 s | 48.287 s | 37.569 s |
| 3 / candidate / cold | 72.254 s | 49.383 s | 38.529 s |
| 3 / candidate / reload | 86.162 s | 48.083 s | 37.566 s |
| 4 / baseline / cold | 111.304 s | 92.284 s | 72.642 s |
| 4 / baseline / reload | 123.255 s | 99.312 s | 79.081 s |

Each mode has four startup visits. Their arithmetic means are:

| Metric | Baseline mean | Candidate mean | Reduction |
| --- | ---: | ---: | ---: |
| Total to ready | 122.740 s | 80.511 s | 34.4% |
| Post-sysroot | 95.028 s | 48.594 s | 48.9% |
| Semantic warming | 74.772 s | 36.801 s | 50.8% |

The predeclared decision used each session's cold/reload semantic-warming median.
Baseline session medians were 73.682 and 75.861 seconds; candidate medians were
35.554 and 38.048 seconds. Both candidate sessions beat both baseline sessions,
satisfying the experiment's performance criterion. Total startup includes more
variable asset/initialization work, so post-sysroot timing remains the main result.

### Editor, cache and memory acceptance

All eight startup visits reached ready, adopted the stdlib cache and retained
valid capacity telemetry. No missing assets or worker setup errors were recorded.
All four sessions passed completion and type-error diagnostic checks; every
memory observer outcome reported no errors.

| Session | Completion observation | Diagnostic observation | Peak sampled renderer RSS |
| --- | ---: | ---: | ---: |
| 1 / baseline | 4.921 s | 0.511 s | 4.588 GiB |
| 2 / candidate | 1.622 s | 0.820 s | 4.831 GiB |
| 3 / candidate | 1.232 s | 0.560 s | 4.640 GiB |
| 4 / baseline | 4.811 s | 1.160 s | 4.502 GiB |

Completion observations improved in these runs. Diagnostic timings overlap, and
candidate peak RSS observations were higher; no diagnostic-speed or memory-saving
claim is made. The experiment establishes a substantial desktop startup benefit
under this controlled configuration, not a cross-device guarantee. No additional
candidate CPU profile was needed for the predeclared paired acceptance decision;
the result does not assert a measured change in individual on-CPU function times.

### Decision and retained evidence

**Experiment accepted.** Preserve the feature as default off pending a separate
rollout decision. Mobile work remains on hold.

The paired report was independently recomputed from all four sessions' raw JSONL
files, checking identities, eight ready/cache/capacity outcomes, editor results,
memory observations and the non-overlapping session-median criterion. Both
preview archives were downloaded and their checksums verified locally. Initial
120-second download attempts timed out; longer downloads succeeded.

Saved local evidence:

- `/tmp/opencode/wvl-lock-gate-40281888849/`
- `/tmp/opencode/lock-build-baseline-40282800079/`
- `/tmp/opencode/lock-build-waiter-aware-40282800079/`
- `/tmp/opencode/lock-paired-desktop-40282800079/paired/`
- `/tmp/opencode/lock-preview-baseline-40282800079/`
- `/tmp/opencode/lock-preview-waiter-aware-40282800079/`
- `/tmp/opencode/verify-lock-comparison-40282800079.mjs`

CI artifacts have three-day retention; the hashes and result tables above are
the persistent record in this repository.
