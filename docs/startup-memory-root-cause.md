# Startup memory and memory-access profiling — 2026-10-16

## Identity and limits

These probes use the verified preview from CI run `38821782668`, source
`7c7845ea61be1a5ff0fd225264ea45701e33e1e1`, with actual core optimization `none`.
The decoded core was reconstructed and SHA-256 checked again:
`7412bcd33ffcb11933c84176b7ace1e0c15001fea61285c96c9e73a6b09aeb8e`.
See `mobile-startup-measurement-results.md` for the acceptance measurements.

Desktop profiling ran locally in headless Chrome 150. It is diagnostic evidence,
not a comparable performance trial: profiling affects execution, and this host
has a previously confirmed memory fault. Physical-device memory observations used
the attached Pixel 6a / Chrome 155. No new hosted build or deployment was started.

## Concrete application bug: repeated physical reservation

`crates/vfs/src/memory_manager.rs:67–75` implements `reserve_for_thread` as:

1. Read `memory_size_self()`.
2. If below `THREAD_SELF_CONFIG.min_pages` (1,024 pages), call
   `memory_reserve_self(1,024)`.

`crates/vfs/src/lib.rs:636–659` calls this once before starting each of the eight
initial pool workers. The memory manager does not remember successful thread
reservations, unlike its `ensure_once` path for individual guest modules.

WVL 0.10.0's `memory.rs` explicitly defines `memory_reserve` as adding **physical
capacity without changing logical own-memory size**. Its `memory_reserve_self`
wrapper has the same semantics. A successful reserve therefore does not make
the subsequent logical-size check true. While logical usage remains below the
threshold, every call adds another 64 MiB of physical capacity.

Eight such calls reserve 512 MiB rather than one 64 MiB margin: **seven redundant
reservations, or 448 MiB**, in that execution path. This is a source-level capacity
calculation, not a measured reduction in renderer RSS. Allocator activity can
also change logical size; the condition must not be modeled as increasing merely
because physical reservation succeeded.

The recommended bounded fix is to remember a successful thread-margin reservation
under synchronization, preserving retry after allocation failure and normal guest
memory growth. Tests should keep logical size unchanged after successful physical
reservation and exercise repeated calls, concurrent callers, failure/retry, and
already-sufficient logical size. This fix has **not yet been implemented**.

## Physical Pixel: linear memory is a substantial part of the footprint

A temporary CDP probe attached to the utility worker before its memory constructor
ran. It forwarded construction through the original `WebAssembly.Memory`
constructor and retained the resulting reference for byte-length observations.
No allocator settings, startup sequencing or worker count were changed. The
captured descriptor was `initial: 1028, maximum: 32775, shared: true`.

| Approximate elapsed time | Phase | Combined linear-memory byte length |
| --- | --- | ---: |
| 9.8 s | VFS starting | 671,350,784 (640.25 MiB) |
| 26.0 s | Sysroots loading | 671,350,784 |
| 28.1 s | Project activation | 1,208,221,696 (1,152.25 MiB) |
| 46.2 s | Project activation, after cache-load report | 1,476,657,152 |
| 50.3–54.3 s | Project activation | 1,610,940,416 (1,536.31 MiB) |

The last utility-worker JS heap sample was about 10 MB used, with about 0.33 MB
reported backing storage. That CDP backing-storage metric did **not** include the
captured shared WASM memory and must not be treated as total runtime memory.
The page crashed at about 56.4 seconds; Android recorded another `LOW_MEMORY`
renderer exit at about 2.8 GB RSS. The probe subsequently reported a pending page
evaluation timeout. It did not reach ready or produce an acceptance timing.

This establishes that startup footprint is not just compiled code or a large JS
heap. It does not attribute every byte to a particular guest or prove that removing
448 MiB of redundant capacity will be enough for mobile acceptance.

## CPU samples: generated memory protection is expensive

The current core export table resolves these sampled function indices:

- `1591`: `__wasip1_vfs_memory_lock_read_acquire`.
- `1594`: `__wasip1_vfs_memory_lock_read_release`.
- `271`: LSP memory-offset getter, `...global_alt_get_no_wait`.
- Disassembly of `280432` is a wrapper around `memory.atomic.wait32`.

Disassembly of an active LSP function (`255101`) repeatedly shows acquire, offset
lookup, an individual load/store, and release. WVL 0.10.0's `shared_global.rs`
documents why: guest memory growth relocates other regions of the combined memory,
so address computation and the memory instruction need protection against growth.
Its last-reader release also calls notify even when no writer is waiting.

For two active analysis workers, six sampled intervals during semantic warming
contained the following leaf-sample durations:

| Worker probe ID | Total sampled duration | Wait32 wrapper | Read acquire | Read release |
| --- | ---: | ---: | ---: | ---: |
| 8 | 122.641 s | 70.151 s | 10.711 s | 32.471 s |
| 15 | 122.739 s | 52.609 s | 13.284 s | 42.052 s |

These are sampled durations, **not summed on-CPU execution time**. Blocked threads
remain visible to the profiler. After excluding the wait32-wrapper leaf, acquire
and release account for about 82% and 79% of the remaining sampled duration in
these workers. This justifies examining the generated memory-access path before
assuming an individual Salsa query is the principal optimization target.

The locks cannot simply be removed: they protect against relocation during
concurrent guest growth. Lock batching, relocation-free layouts or conditional
wakeups need a separate correctness design and concurrency tests.

## Additional measurements and unsuccessful probes

- WASM section inspection: code 411,350,022 bytes; data 56,960,487 bytes. The final
  core has no function-name section, so individual Rust query names were not
  recovered from these profiles.
- The CPU-profiled desktop run reached ready with semantic warming about 140 s;
  peak sampled renderer RSS was 5,103,352 KiB. These are instrumented local values,
  not a regression comparison against hosted CI.
- A separate run without the CPU profiler reached about 4,091,088 KiB renderer
  RSS before crashing during project activation. Its cause was not established.
  Linux mapping samples were dominated by writable V8-sandbox and PartitionAlloc
  regions; these broad labels do not identify individual allocations.
- Three detailed CDP memory-infra dump requests returned `success: false`.
  No allocator-level breakdown is claimed from that trace.

Raw evidence remains under `/tmp/opencode/startup-profile-7c7845ea`,
`startup-memory-7c7845ea`, `startup-memory-trace-7c7845ea`, and
`linear-memory-pixel-7c7845ea`. The physical probe cleared its dedicated origin and
closed its test tab; forwarding and local test-port listeners were removed.

## Proposed order

First fix the repeated thread-margin reservation and measure the same resulting
CI preview on desktop and Pixel. Then investigate WVL's per-access locking if
semantic warming remains dominant. A separate LSP runtime is a larger alternative
that may address both footprint and relocation overhead, but is not necessary to
fix the demonstrated reservation bug.
