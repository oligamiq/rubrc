# Memory-lock batching experiment

## Objective and current state

Implement idea 1: reduce per-access relocation read-lock overhead, then benchmark
against the same runtime with batching disabled. The user requested implementation
and measurement; public deployment and default enablement are not included.

- WVL experimental checkout: `.worktrees/wvl-lock-batching`, branch
  `perf/memory-lock-batching`, based on `f5825e94cea867cef8305bf7aea4e8d9c9f49d66`.
- Initial implementation: `02c3b23b914e203530cd14cd453ef3632069fe90`.
- Initial required gate: <https://github.com/oligamiq/wasi_virt_layer/actions/runs/42640993597>.
- Gate is not yet accepted; application comparison has not yet run. No speedup
  claim follows from the implementation or static lock counts alone.

## Implementation

The CLI switch `WVL_MEMORY_LOCK_BATCHING=off|on` is strict and default-off.
Only threaded own-memory single-memory lowering with both read-lock exports
can enable the candidate. Scalar non-atomic guest loads/stores share one read
lock across a bounded allowlisted straight-line interval (64 original opcodes).
Calls, control flow, globals, host memory, atomic/wait/notify, bulk memory,
grow/size, potentially trapping arithmetic and unknown instructions end the
interval before execution. Each guest's base is still loaded under protection.
No memory ABI, runtime lock algorithm, filesystem or application readiness
condition changes.

Existing limitations remain explicit: guest access traps already skip release
in the original lowering (Wasm runtime traps are not Wasm exceptions); atomic
wait's own original lock can remain held during parking. This experiment must
not be described as trap recovery or a relocation-safe waiter redesign. It
adds no held lock to previously unprotected possibly trapping instructions.

## Correctness and evidence

WVL gate includes new transformed-code validation, boundary/stack checks,
required Deno execution equivalence, and production-lock concurrent physical
relocation with adjacent guest loads AND stores. Existing threaded pool/reset,
atomic wait/reset, and native lock protocol checks remain required. Historical
non-threaded reset failures remain explicitly visible diagnostics.

Generation-time evidence records actual effective mode, scalar access sites,
remaining and elided acquisitions, and the bound. Rubrc packaging requires one
valid observed record, off=zero elisions and on=nonzero elisions, and binds it to
the preview by checksum. Replay verifies that both arms had the same scalar
lowering input and the same runtime library feature selection.

Lightweight local checks completed before the initial gate:

- Native optimization policy: 3 passed.
- Native original lock protocol: 9 passed.
- Native waiter-aware lock protocol: 11 passed.
- Rubrc comparison, metadata and optimization policy tests: 20 passed.
- Scoped Rust syntax/format checks, shell syntax and diff whitespace checks.

These do not substitute for the hosted Wasm tests.

## Benchmark protocol

Both application variants use the SAME waiter-aware library and WVL revision,
with `WVL_MEMORY_LOCK_BATCHING` as the only selected runtime difference. Keep
`strong-compatible-v1`: Rust O3/fat LTO/one CGU, analyzer/final-core O3,
TryTable-aware WVL O3/O4, 512 MiB initial VFS heap and fixed worker policy.
Build fresh coherent core/bindings/cache/page sets. Verify source and input
hashes, distinct core hashes and actual optimization/lowering evidence.

Replay off/on/on/off sequentially on one hosted runner, fresh browser per
session, cold+reload, completion/type-error checks and identical RSS observation.
Primary timing runs exclude CPU sampling. Accept improvement only if all
correctness gates pass and both candidate session semantic-warming medians beat
both baseline session medians; otherwise report regressed/inconclusive honestly.
Record total startup, post-sysroot, semantic warming, editor latency and RSS.

The WVL relocation fixture additionally emits nine warmed production-lock
microbenchmark samples, each exercising 2,097,152 scalar accesses. These are
exploratory runtime measurements, not a replacement for application A–B–B–A.
Synthetic no-op-lock tests are correctness-only and never performance evidence.

## Previous strong-profile failure

Run <https://github.com/oligamiq/rubrc/actions/runs/41362469354> failed after the
final O3 optimizer succeeded: `generate-std-cache` hit its 900,000 ms timeout.
The other build was cancelled and paired replay skipped. This was not evidence
of a runtime speedup, an O4 TryTable failure, or proof of deadlock. Both new arms
receive the same bounded 1,800,000 ms cache-generation budget, with Deno included
in resource monitoring. Extra time is diagnostic headroom, not a claimed fix.

## Workspace preservation

Pre-existing changes in analyzer WASM and generated bindings, and existing
untracked cache documents/debug scripts, are unrelated and remain unstaged.
Heavy compilation and browser benchmarks run on hosted CI, not this local host.
