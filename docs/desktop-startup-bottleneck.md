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
