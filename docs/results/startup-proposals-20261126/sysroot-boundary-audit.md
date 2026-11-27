# Sysroot boundary audit — bounded coalescing, not a startup-time claim

Date: 2026-11-27 (Asia/Tokyo). Scope: read-only production-source audit; only this report was written. No production edits, build, benchmark, checkout, worktree, git repair, or commit was performed. Local git pack corruption was reported by the requester; existing files and loose HEAD/ref metadata were sufficient. Tests below are required/suggested, **not executed or claimed passing**.

## Decision

1. **Yes: move `start_time.elapsed()` and the associated speed calculation inside the existing progress branch.** This is the smallest, independently reviewable change.
2. **Suggest a fixed 64 KiB coalescing buffer first; compare 256 KiB only after correctness and memory/latency checks.** Keep the existing 512 KiB request ceiling. These sizes are proposals, not measured improvements.
3. **Do not simply put `BufReader` outside the cancellation-aware reader.** Cached data bypasses its cancellation check, potentially allowing the final buffered tail to complete successfully after cancellation.
4. **Keep the rust-src mount append side effect on every fetched byte, exactly once and in order.** Reading into a sink is not redundant work.
5. Do not combine this with transport replacement, archive format changes, new parallelism, cache redesign, clock-import replacement, or filesystem/mount redesign.

## Observed diagnostic evidence and its limits

The actual hosted diagnostic [summary](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/hosted-45958190399/summary.json#L7-L27>) reports:

| Import | Calls | Timed calls | Sum of sampled synchronous inclusive durations |
|---|---:|---:|---:|
| `wasip1.clock-time-get-import` | 11,029 | 9 | 0.145 ms |
| `downloader.sysroot-read-archive-chunk` | 9,595 | 9 | 6.245 ms |

Both have zero recorded throws/clock errors. **Neither sum is total time across all calls. No extrapolated total, fraction of startup, saved milliseconds, or projected speedup follows from these samples.** Calls include startup plus snapshot interval, not a sysroot-only phase; periodic timing may be biased and inclusive durations can include waits/nesting. The [summary limitations](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/hosted-45958190399/summary.json#L559-L565>) explicitly exclude acceptance benchmarking and terminated-worker completeness. The [raw diagnostic](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/hosted-45958190399/instrumented/result.json#L1-L10>) also records four snapshot pause timeouts.

The [hosted provenance](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/hosted-45958190399/provenance.json>) identifies build source SHA `ff3e160d74cf2be990d0b0b39d764b306833e6bd`, archive SHA `73f6e129a06a25c3e818ac51a84100816c4fcec39b46a59e087a678927e17e64`, O3 core, memory-lock batching on, and 512 MiB initial VFS heap. The diagnostic used Chrome 157.0.8103.78, started `2026-11-27T07:25:56.237Z`, and replayed the hosted artifact on a runner-local preview URL. This is not a measurement of a newly built local candidate.

Local loose HEAD/ref metadata names branch `perf/memory-lock-batching`, SHA `2635f7fee35a6139ca4d4188d00a7222bb926c9f`. This is not proof that working files are clean or identical to hosted source. The local file audit below must not be silently presented as a source-to-artifact equivalence proof.

## Exact source path and contract map

- [Shell reader construction and progress closure](</home/oligami/projects/rubrc/crates/vfs-shell/src/main.rs#L575-L638>): the complete load is serialized; fetch/meta precede reads; the closure issues one host call per supplied slice, then advances `archive_bytes_read`. It computes elapsed/speed on **every successful chunk**, but emits progress only for archives greater than 1 MiB and when at least 1 MiB has passed or the exact final byte has arrived.
- [SysrootArchiveReader](</home/oligami/projects/rubrc/crates/vfs-shell/src/sysroot_extraction.rs#L8-L47>): `read` takes `min(remaining, caller_buffer_len, 512 KiB)`. Empty reads/EOF return zero without a callback or cancellation probe. Otherwise it checks cancellation before the callback; callback errors propagate before `remaining` is decremented. The reader has no internal coalescing buffer. **512 KiB is a maximum, not the current effective request size.** Raising it alone cannot enlarge an 8 KiB caller request.
- [Tar extraction](</home/oligami/projects/rubrc/crates/vfs-shell/src/sysroot_extraction.rs#L124-L180>): tar entry/header reads and per-file `std::io::copy` dictate the slices passed downstream. The reader is retained via `archive.into_inner()` and drained after tar termination; do not drop buffered padding/trailing bytes. File/path/type handling and file/byte totals must remain unchanged.
- [rust-src stream and finish](</home/oligami/projects/rubrc/crates/vfs-shell/src/main.rs#L640-L691>): `std::io::copy(reader, sink)` drives the bridge; errors/length mismatch abort the mount accumulator; exact completion calls mount-finish. Final elapsed measurements are separately used for speed and command result.
- **Critical additional hop:** [VFS bridge wrapper](</home/oligami/projects/rubrc/crates/vfs/src/lib.rs#L3699-L3708>) allocates a per-request local buffer, invokes the JS import, appends those bytes to the active rust-src accumulator, and copies bytes into shell guest memory. Bypassing this wrapper would omit the mount input.
- [Mount accumulator](</home/oligami/projects/rubrc/crates/vfs/src/lib.rs#L3552-L3627>) already retains the whole rust-src SquashFS archive, with a 64 MiB accepted-length ceiling and exact-length/overflow checks. [Mount finish](</home/oligami/projects/rubrc/crates/vfs/src/lib.rs#L3727-L3761>) takes that accumulator and mounts it. Incremental shell reads do not imply that the entire existing pipeline uses constant memory.
- The source [utility worker](</home/oligami/projects/rubrc/page/src/worker_process/util_cmd.ts#L489-L511>) does **not** contain a named `sysrootReadArchiveChunk` handler in this checkout: it delegates nonterminal messages to `animal.call_unknown_fn`. The bundled `util_cmd` name must not obscure the actual implementation locations.
- [JS import implementation](</home/oligami/projects/rubrc/page/src/worker_process/vfs_bindings/inst.ts#L166-L177>) performs a synchronous unknown-function request, converts the reply to a byte array, validates exact requested length, then writes it into current Wasm memory. Its [conversion helper](</home/oligami/projects/rubrc/page/src/worker_process/vfs_bindings/inst.ts#L16-L32>) supports serialized arrays/objects.
- [Production callback registration](</home/oligami/projects/rubrc/page/src/production_runtime.ts#L258-L266>) uses [createSysrootArchiveCallbackAdapter](</home/oligami/projects/rubrc/page/src/sysroot_archive_store.ts#L238-L271>). Each read uses `readChunk(chunk_len)` and returns `Array.from(chunk)`. [Store reads](</home/oligami/projects/rubrc/page/src/sysroot_archive_store.ts#L102-L129>) advance the active archive and emit reading/complete events; [exact slicing](</home/oligami/projects/rubrc/page/src/sysroot_protocol.ts#L15-L53>) uses subarray views and rejects overreads. Increasing chunk size reduces callback/event count but increases temporary serialization size. Do not change exact-length validation or silently truncate.

## Proposal A — clock work only when progress is emitted

In the shell closure, keep the host read and byte increment in the same order. Move only these existing calculations into the existing `if archive_len > 1024 * 1024 && (...)` body, before progress formatting:

```rust
let elapsed = start_time.elapsed().as_secs_f64();
let speed = if elapsed > 0.0 {
    archive_bytes_read as f64 / elapsed
} else {
    0.0
};
```

This is valid because neither value is consumed outside that branch, and the branch condition uses bytes rather than time. Preserve `Instant::now()`, final elapsed/speed, return duration, progress thresholds, final-progress behavior, zero-time protection, flush, and cancellation ordering. The displayed rate is sampled a few instructions later, not mathematically bit-identical; no user-visible scheduling/threshold change is intended. For an archive at most 1 MiB this eliminates all per-chunk progress clock reads; for larger archives it leaves only readings at actual progress emissions. It does not justify claiming all 11,029 diagnostic clock calls originate here or predicting a wall-time saving.

## Proposal B — cancellation-aware bounded coalescing

Preferred implementation boundary: enhance the shell archive reader (or add one narrowly scoped reader beside it), keeping the JS/WIT interfaces and VFS wrapper unchanged. A concrete design to test:

1. Allocate one reusable heap-backed buffer of fixed `B = 64 * 1024` bytes; do not allocate `archive_len` bytes, a queue of chunks, a growing `read_to_end` buffer, or a large stack array. Evaluate `B = 256 * 1024` separately. Reject/configure only positive sizes not exceeding the existing 512 KiB ceiling.
2. Track **bytes remaining to fetch**, **bytes remaining to deliver**, and cache indices separately; never confuse already-fetched buffered bytes with consumer EOF. Maintain `delivered + cached + unfetched == archive_len` on successful paths.
3. For an empty caller slice, return zero without refill. For true delivery EOF, return zero as today. On every other `Read::read`, check cancellation **before serving cached data**, not just before refilling. Keep the existing cancellation message and error kind. A cancellation raised during an in-flight synchronous callback can only be observed at the next check, as today; do not promise preemption of that callback.
4. If cache is empty, fetch exactly `min(B, unfetched)` once through the existing closure; expose it only after successful return. No speculative background prefetch, no multi-refill loop in one read, no overread. Copy at most the caller's available space/cache amount, allowing a legal short read. This explicit design yields predictable callback counts regardless of small tar header reads.
5. On cancellation, return an error without delivering any additional cached bytes or fetching another chunk. On callback failure, propagate immediately; the extraction must stop. Do not increment successful byte counters or cache indices for a failed callback. Do not invent an automatic retry/rollback: the remote store may already have advanced before validation or an exception.
6. Keep the same buffered reader alive through tar's final drain. Do not extract its unbuffered inner reader and abandon unread cache bytes. Release its buffer on success/error/drop; keep the full-transaction lock unchanged.

An alternative is an outer cancellation-aware `Read` wrapper around `BufReader<SysrootArchiveReader>`, with cancellation also checked for buffered reads. That needs explicit EOF semantics and control over optimized/bypassing methods; a plain outer `BufReader` is **not** sufficient. The explicit reader above is easier to bound and test. Do not add a `BufRead` surface unless required, because `fill_buf`/`consume` introduce additional cancellation bypass points.

### Cancellation, side effects, and error caveats

Coalescing inevitably advances the host archive cursor and mount accumulator ahead of consumer delivery, by up to one buffer. It also advances existing byte-based progress/read-complete events earlier relative to extraction. Keep these events as **transfer** progress; never reinterpret them as extraction/mount readiness. A byte-bounded window is not a wall-clock latency guarantee.

For rust-src, every refill must still append all returned bytes once through the VFS wrapper. Do not append again when serving cached bytes, skip the sink loop, mount on host read-complete, or finish merely because all bytes were fetched. Finish only after the consumer drains exactly the declared length. Cancellation with cached tail remaining must still take the error/abort path even if the host store already emitted complete. Existing EOF behavior permits success if cancellation arrives only after all bytes have been delivered; making final mount commit cancellable would be a separate semantics change, not an unnoticed batching edit.

The shell closure cannot currently turn every JS throw/trap into `io::Error`: its imported read returns `void`, and `Ok(())` follows a normal return. Exact reply validation is a JS exception path. Preserve the existing throw/failure behavior, and require an integration test proving no false readiness/success and usable cleanup/retry lifecycle. Do not claim the Rust abort branch catches all JS traps. Similarly, no rollback of partially extracted tar files exists in this function; adding transactional filesystem rollback is outside this proposal.

### Sizes and callback-count expectations

The hosted summary contains no requested-byte histogram. The familiar **8 KiB** starting point is a suggested baseline/common generic-copy buffer size, not a measured request-size conclusion from 9,595 calls; tar header reads may be smaller and Rust implementation paths vary. Record actual request lengths before calling it the production effective size.

For the explicit one-refill design, a successful complete drain of `N > 0` bytes must make exactly `ceil(N/B)` host read callbacks (zero for `N = 0`), each positive and at most `B`, with sum exactly `N`. This is a deterministic correctness expectation, not a timing extrapolation. Example synthetic 1 MiB stream:

| Fixed refill size | Expected callbacks for complete synthetic drain | Extra persistent shell buffer |
|---|---:|---:|
| 8 KiB | 128 | 8 KiB |
| 64 KiB | 16 | 64 KiB |
| 256 KiB | 4 | 256 KiB |

No claim is made that hosted calls will divide by 8/32. Multiple archives, smaller reads, errors/cancellation, and different copy paths require separate accounting. The existing VFS wrapper has another live buffer of up to `B`; JS also creates a numeric array, a converted byte array, and transport temporaries. Those costs are bounded by chunk size but not equal to exactly `B` bytes; number-array/serialization representation must be measured. Existing JS archive caching and the up-to-64-MiB mount accumulator remain; this is **bounded incremental memory**, not an end-to-end O(B) memory claim.

## Required tests before adopting either change

Existing [reader tests](</home/oligami/projects/rubrc/crates/vfs-shell/src/sysroot_extraction.rs#L218-L266>) cover reported-length streaming and cancellation after one callback, but not cached delivery or exact counts. Existing [tar tests](</home/oligami/projects/rubrc/crates/vfs-shell/src/sysroot_extraction.rs#L352-L400>), [mount accumulator tests](</home/oligami/projects/rubrc/crates/vfs/src/lib.rs#L3629-L3675>), and [JS protocol tests](</home/oligami/projects/rubrc/page/src/sysroot_protocol_test.ts#L69-L157>) are useful baselines, not sufficient batching proof.

| Area | Required assertion |
|---|---|
| Byte correctness/counts | Deterministic patterned sources of lengths 0, 1, B−1, B, B+1, 2B, 2B+17; caller reads of 1, 512, 8192, B, and >512 KiB, plus mixed lengths. Exact output equality, sum of callback lengths N, count `ceil(N/B)`, max B, no zero-length callbacks, no callback at EOF. Count callback attempts and successful bytes separately for failing cases. |
| Empty reads | Empty destination before data and between reads neither fetches nor consumes nor probes cancellation; ordinary nonempty read continues correctly. |
| Cached cancellation | Read one byte (leaving cache), toggle cancellation, next nonempty read must return the existing cancellation error with zero new host callbacks and no delivered bytes. Repeat when the entire remaining archive is already cached; this catches the dangerous final-tail success bug. |
| Cancellation boundaries | Cancel before first fetch; cancel from a refill callback; cancel before last refill; check current semantics at true EOF. No further host call after an observed cancellation. Larger synchronous chunk latency is recorded separately. |
| Errors | Inject first/later callback failures; preserve error identity/message, no fabricated EOF/success, no successful-byte advancement, no retry by the extraction path. Exercise JS short/long replies, missing active archive, unavailable meta, and thrown callback through the real bridge. |
| Tar equivalence | Fixture with directories, empty and small files, large file crossing refill boundaries, normal tar terminators and extra reported trailing bytes. Same contents, file/byte totals, unsupported-type/path rejection, write-failure propagation, and complete declared-byte drain; callback count uses whole archive length including drained tail. |
| Mount side effect | Spy at wrapper append: concatenated appended bytes exactly equal SquashFS input, in order, once; none duplicated on cached delivery. Finish only after full delivery; cancellation/error aborts, partial/final-cached-tail cancellation never mounts; next load starts clean. Keep existing short/overrun/bounds tests and read a known source file from the resulting mount. |
| Progress/clocks | Inject/count a clock only in the progress computation: 0 per-chunk calls for <=1 MiB; one per actual progress emission for >1 MiB; identical byte threshold/final event counts for unchanged read schedule, zero-time safety, unchanged final duration reporting. Test batching separately because chunk boundaries may alter progress sampling. |
| Bounded memory/lifecycle | Cache capacity never grows with N; requests <=B<=512 KiB; at most one refill in flight; buffer freed on every exit. Record JS temporary allocation/GC and peak memory for both sizes; existing accumulator cap remains 64 MiB. Two loads remain serialized and do not share buffered bytes. |

The existing JS test source also includes old `parseEntries` dependency properties not present in the current store dependency type; do not claim this suite typechecks without running it, and do not silently fix unrelated drift in the batching patch.

## Narrow validation/rollout plan

1. Review and test the clock-only change independently, then measure it independently; leave batching out of that diff.
2. Add callback count/length instrumentation in a **diagnostic/test-only** path, partitioned by archive/triple and phase; record bytes, success/error/cancel counts, refill distribution, delivered-vs-fetched totals, mount result, and peak cache size. Avoid adding per-read timing/logging to the acceptance build.
3. Run deterministic correctness/cancellation tests with 8/64/256 KiB refill configurations, then the real target tar and rust-src SquashFS integration paths. Assert expected callback counts from actual declared lengths; do not derive input lengths from the old sampled counts.
4. Compare uninstrumented matched builds under the same browser/cache/network/memory-lock configuration, with repeated cold/warm runs, extraction/mount readiness and startup outcome, peak memory/GC, and cancellation responsiveness. Keep raw logs, artifact hashes, exact commands and configuration. The existing hosted diagnostic is prioritization evidence, not an acceptance baseline timing.
5. Adopt 64 KiB only if correctness is identical and measured memory/latency acceptable; increase to 256 KiB only on evidence. No claimed improvement or acceptance threshold is supplied by this audit.

## Audit procedure and source fingerprints

Procedure: verified working directory using `pwd`; used read/glob/grep tools to inspect the linked evidence and source; inspected loose HEAD/ref files rather than traversing git packs; ran only the following fingerprint command (exit code 0). No performance experiment or test runner was invoked. A broad optional toolchain-file glob encountered a concurrently disappearing temporary documentation directory; it was not needed for the source conclusions and was not retried as a repository operation.

```sh
sha256sum crates/vfs-shell/src/main.rs crates/vfs-shell/src/sysroot_extraction.rs crates/vfs/src/lib.rs page/src/worker_process/util_cmd.ts page/src/worker_process/vfs_bindings/inst.ts page/src/sysroot_archive_store.ts page/src/sysroot_protocol.ts
```

Raw output:

```text
2ddc27a749027054167d9027adc1fde54c0f3256c15e91885272ccb800a8806b  crates/vfs-shell/src/main.rs
2d8b41691e07b4f2236ac9a9111f627f11fc95102212a4ec07c8e2f22a0e2fec  crates/vfs-shell/src/sysroot_extraction.rs
3b2b0165f73d5a8de10bd9a021a2122bc9bc1c9d5f58688cd9d3666595cd58cb  crates/vfs/src/lib.rs
8d75d873959df8c71ab1cc33a2f948d9057a7c8512dab1cbdc369e3e279f5d42  page/src/worker_process/util_cmd.ts
92532e01bc370974bf5513160bb59bd43346fbb3591eb1d903d0feb1a68b59a4  page/src/worker_process/vfs_bindings/inst.ts
44115578fb0dacb6e5abca62c367e8370fa7132522da2b08240df02daf3ebbb6  page/src/sysroot_archive_store.ts
107ebe8a8ad688db3c2b3a9c211f142e711f9c661166d4a3ee58a5320f949af1  page/src/sysroot_protocol.ts
[exit code: 0]
```

Outcome: source audit complete; clock-branch relocation is valid by local data flow; coalescing remains a proposal gated on tests and measurements above. Unresolved: actual hosted chunk-size distribution, direct phase attribution, JS-throw cleanup behavior under integration, and candidate memory/latency/performance effects.
