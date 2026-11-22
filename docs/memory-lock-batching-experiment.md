# Memory-lock batching experiment

## Objective and current state

Implement idea 1: reduce per-access relocation read-lock overhead, then benchmark
against the same runtime with batching disabled. The user requested implementation
and measurement; public deployment and default enablement are not included.

- WVL experimental checkout: `.worktrees/wvl-lock-batching`, branch
  `perf/memory-lock-batching`, based on `f5825e94cea867cef8305bf7aea4e8d9c9f49d66`.
- Initial implementation: `02c3b23b914e203530cd14cd453ef3632069fe90`.
- Initial required gate: <https://github.com/oligamiq/wasi_virt_layer/actions/runs/42640993597>.
- Initial gate failed in benchmark-log parsing, not during guest execution:
  the WASI host prefixes samples with `[WASI stdout]`, but the test expected
  the measurement marker at column zero. In both batching modes the first
  library variant completed 32 relocations and nine samples; the assertion
  then prevented the waiter-aware variant from running. The 12 new structural/
  executable-equivalence tests and existing threaded pool/reset checks passed.
  The full gate did NOT pass, and these incomplete numbers are not accepted.
- Corrected WVL revision: `456a69aa9223e2e1b90cf260c573f31782987238`.
  This adds a strict prefix parser with two native regression tests and preserves
  actual lowering proof from successful CLI builds (previously discarded by the
  test helper). No lowering/runtime code changed in this correction.
- Corrected gate: <https://github.com/oligamiq/wasi_virt_layer/actions/runs/43724563178>
  **passed**, including both library modes with batching off/on. The pinned
  revision remains default-off; no deployment/default change is included.
- Application attempt: <https://github.com/oligamiq/rubrc/actions/runs/43725323860>
  at Rubrc `02a624061898597a5c7e9c172076f2e3e37ce3cc` failed during builds;
  browser replay never ran. The implementation's application-level effect
  remains unmeasured. The isolated branch is `perf/memory-lock-batching`.
- Checkpointed retry: <https://github.com/oligamiq/rubrc/actions/runs/44555795559>
  at Rubrc `0673d0a0b2a2fa0499fc661ec5ce1f6029c035d6`. Both seed/lower jobs
  passed and verified eight cache hits per lower job. A component runner lost
  communication; attempt 2 completed both component jobs. Its off finish job
  then stopped BEFORE building at the unchanged 80 GiB disk-headroom check.
  No browser comparison ran.
- Finish-only recovery now preserves the standalone native CLI while discarding
  its disposable native compilation intermediates, keeping the full 64 GiB
  swap and 80 GiB preflight requirement. Cross-run resume selects the producer's
  exact application source (still `0673d0a0…`), not the newer workflow harness;
  both unexpired component checkpoints and every content/provenance check are
  required. Optimizer flags, runtime policy and correctness checks are unchanged.
- Finish recovery 45031103834 showed native intermediates alone did not free
  enough space. Recovery 45031840261 stopped at an anonymous GitHub API HTTP403
  before building. The current recovery is
  <https://github.com/oligamiq/rubrc/actions/runs/45032121283>, harness
  `3f6b8557` with original application `0673d0a0…`. It passed the authenticated
  exact-revision gate, restored the off component checkpoint, removed unused
  .NET/Android SDKs only on the disposable hosted runner, and passed the original
  disk/swap preflight. Final compilation/optimization is now running. No
  application measurement has yet completed.

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
- After the parser correction: two native prefix tests and four new microbenchmark
  summarizer tests passed; that local JS harness suite had 24 passes.
  `scripts/ci/summarize_lock_batching_micro.mjs` validates both actual lowering
  proof and all nine samples for each library/batching combination before
  reporting exploratory medians/ranges.
- Checkpoint integration: all 61 local JS tests passed, including byte/proof
  integrity, budget/error cases, command identity checks, and an installed
  wrapper invoked with a systemd-like clean environment. Both reusable workflows
  passed duplicate-key, phase-dependency, common-environment and shell checks.
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
microbenchmark samples, each requesting 64 guest calls. The `scalarAccesses`
sample field is **nominal source work** (64 × 8192 iterations × four accesses =
2,097,152), not a verified dynamic load/store count after optimization. The
source writes loaded values back to invariant locations, so pre-lowering
optimizers could remove/hoist accesses; do not compute actual ns/access from
that nominal count without inspecting the generated code. Generation-time
lowering counters are static sites, also not dynamic instruction counts.
These are exploratory runtime measurements, not a replacement for application
A–B–B–A. Synthetic no-op-lock tests are correctness-only and never performance
evidence.

## Measured exploratory result

Gate run 43724563178, AMD EPYC 9V74 hosted runner, Deno 2.9.7 / V8
15.0.245.2-rusty. Each measurement is a batch of 64 guest invocations after
64 warmup invocations. Nine samples per variant, one process per variant:

| Runtime library | Batching off median (range), ms | Batching on median (range), ms | Median ratio off/on |
| --- | ---: | ---: | ---: |
| waiter-aware (primary) | 11.075 (10.962–11.255) | 5.745 (5.699–5.896) | 1.928× |
| original (secondary) | 22.720 (22.665–22.974) | 12.599 (12.431–12.735) | 1.803× |

[All 36 samples, source identity and core hashes](memory-lock-batching-micro-43724563178.json)
are retained separately. In all four generated final cores, inspection of
function 358 confirms the 8192-trip loop still contains two guest loads and
two guest stores, with four acquisitions/releases when off versus two when on.
Thus the inspected Wasm did not collapse this workload. This does not establish
native JIT instruction counts, statistical significance, writer latency, or an
application speedup. These samples are sequential within one process, not nine
independent process replicates; their fixed off/on order is not A–B–B–A.

Application lowering evidence from both successful seed/lower pairs has
11,272,568 identical scalar-access sites. Batching changes acquisition sites
from 11,272,568 to 4,478,591, eliding 6,793,977 (about 60.3%). These are static
whole-program counts, NOT dynamic execution counts or a measured application
speedup.

## Application build failure and exact-output checkpoints

In run 43725323860, the off build hit its **330-minute job limit**. Its completed
optimizer trace includes about 192 minutes for the post-lowering O3 pass and
58 minutes for the next core O3 pass. It was cancelled during a further core
optimization, before cache generation. The on runner lost communication with
GitHub; its log/artifact was unavailable (log API returned 404). Resource
exhaustion is plausible but not established by that runner-loss annotation.
Neither event is a runtime regression measurement or a correctness failure.

The retry splits each arm into seed (eight optimizer misses), lower (one),
component (one), and finish (remaining work) jobs. Each stage reconstructs the
same build. Reuse is allowed only for identical SHA256 input bytes, optimizer
binary, ordered flags, source SHA, experiment mode, optimization profile,
Binaryen core count and stage. Outputs are streamed, rehashed and atomically
restored; a corrupted cache is a failure, not a fallback. Cache hits keep the
original successful execution provenance and are distinguished from fresh
optimizer executions. Final packaging revalidates all cached outputs and the
unchanged strong-profile/lowering evidence.

A nonfinal job is accepted only at its deliberate miss-budget boundary: one
last status-75 checkpoint trace bound to the marker key, with every preceding
observed command successful. Ordinary errors, signals, damaged evidence or
unexpected successful completion cannot masquerade as a checkpoint. The final
job must complete the real cache/page build without any checkpoint marker.
This preserves all O3/O4 passes rather than skipping expensive optimization.
Exact cross-run build determinism is verified by hits, not assumed; changed
inputs miss the cache and cannot reuse an unrelated result.

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
