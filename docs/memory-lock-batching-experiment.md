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
  disk/swap preflight. Final O3 optimization succeeded (36m44s, peak RSS
  15,581,040 KiB), but bundled `generate-std-cache` again timed out after
  1,800,000 ms on command 1/2. No application measurement completed.
- During that cache-generation plateau, Deno RSS stayed near 1.93 GB while
  lifetime CPU utilization declined to 0.9%; host available RAM was about 13 GB.
  Waiting/blocking is more plausible than sustained compute, but the exact wait
  site remains unproven. The last reserve result `45` is the prior logical page
  count returned after a successful reserve, not an allocation-failure code.
- A definite observability defect was found: spawned-worker `terminalWrite`
  callbacks go directly to the farm, where cache generation discarded them.
  A bounded per-session UTF-8 tail now records those messages in a final JSON
  diagnostic without changing guest acknowledgements. Three focused tests pass.
  Exact-final-core diagnostic replay is now running independently of expensive
  builds; these runs are not timing acceptance runs. Final off and component on optimizer archives were preserved
  locally before expiry (ZIP SHA256 respectively
  `a1a5ba966c2c4f5f21217345cb9cdd8b84e84c243238d542fafb96738d17a091`
  and `8db2b8f2448b8efb9832be8376155d5226d28b8f334e9296bf2f4eaf466ad4ea`).

### Exact-core startup diagnostics (2026-11-23)

- Restore validates the final-core optimizer identity/proof and SHA256
  `375a07601afac782b81ffd7d49a0891bf7980cca395e5deabd918e569ea06502`.
  The original adapters and locked dependencies are preserved. WVL templates
  are reconstructed at the exact revision, and the core import minimum (9203
  pages) supplies initial memory, not the stale tracked generated value.
- Run [45087383256](https://github.com/oligamiq/rubrc/actions/runs/45087383256)
  reproduced the cache-startup stall within five minutes. Captured farm output
  contained only session 0 shell/sysroot messages, not analyzer output.
- Run [45098532999](https://github.com/oligamiq/rubrc/actions/runs/45098532999)
  also timed out on `rust-analyzer --version` after five minutes. Thus the
  failure is not specific to generating the standard-library snapshot.
- Run [45099671233](https://github.com/oligamiq/rubrc/actions/runs/45099671233)
  exercised the existing editor dispatch on that same core to use its already
  compiled lifecycle markers. It recorded `lsp:thread:start`, successful reserve,
  and `lsp:_reset:enter`, but no `_reset:return` in a 30-second observation window.
  CI success means bounded diagnostic collection completed, NOT LSP readiness.
  The analogous shell path lacks lifecycle markers, so its exact internal wait
  site is not proven merely by this editor-path observation.
- Run [45115906635](https://github.com/oligamiq/rubrc/actions/runs/45115906635)
  sampled exact-core shared-memory locations without acquiring guest locks.
  Before dispatch: base595656704, logical pages45, relocation lock0, flesh-start
  guard2. All six subsequent observations (roughly1–26s) had the same base and
  pages, lock0, guard1, with no reset-return marker. This narrows the observed
  plateau to incomplete initialization rather than a persistently held relocation
  lock; it does not prove which instruction/thread owns the unfinished state.
  Samples are not atomic snapshots, and equal base reads cannot exclude ABA.
- Baseline batching is OFF in all these diagnostics. No browser application
  benchmark is available. Root cause inside reset is still under investigation;
  a lock-upgrade deadlock is not established.
- Selective disassembly then found a deterministic reset trap: final-core LSP
  flesh-start function188441 tests mutable global13 before a zero-fill and traps
  if set; its tail sets13=1 even when shared initialization was skipped. The
  module start runs this function on each instance, but reset242310 does not
  clear13. Reinitialization can therefore strand the shared once guard at1
  after releasing the read lock, matching the observed lock0/guard1.
  This is Binaryen MemoryPacking's synthetic passive-segment drop-state pattern:
  [version131 source](https://raw.githubusercontent.com/WebAssembly/binaryen/version_131/src/passes/MemoryPacking.cpp).
  WVL strips literal `data.drop` only after its target optimization, too late
  for drops already encoded as synthetic global checks/sets. The exact cached
  pre-WVL analyzer (SHA256
  `32e175b2b5ded343a87c6300345a7c04148637c4f950cf2f92f3e55d765a5e0e`)
  was verified against its producer manifest and has only the two original
  mutable globals (stack and TLS), confirming this extra state was introduced
  inside WVL. A tiny executable shared-memory/passive-zero-segment fixture
  reproduced this with Binaryen120 O3 and Node: stripping drops before optimization
  allows repeated initialization (guard2); optimizing first and then stripping
  literal drops traps at `unreachable` and leaves guard1. This is a reproducible
  transformation-order bug, not a reason to patch arbitrary optimized globals.
  The correction will retain target reset data before internal optimization,
  retain the late defensive stripping, and keep strong optimization enabled.
  Both benchmark arms must be rebuilt at the corrected common revision; existing
  checkpoint proofs must NOT be relabeled as outputs of the new generator.
- Fix revision `77f45543eb976e4e7843e78fcd67bd837acac6bd` introduces a first
  target pre-pass retaining passive data. Four focused tests passed locally
  against the real pass (including actual Binaryen120 O3/O4 negative controls),
  and a new required hosted regression runs with pinned Binaryen131 before the
  existing batching/relocation gate. The application pin now selects this fix;
  required gate [45130504077](https://github.com/oligamiq/wasi_virt_layer/actions/runs/45130504077)
  passed, including the Binaryen131 O3/O4 regression and batching/relocation tests.
  Fresh paired application build [45131532216](https://github.com/oligamiq/rubrc/actions/runs/45131532216)
  uses source `ff3e160d74cf2be990d0b0b39d764b306833e6bd` and no old checkpoint
  producer. Both seed jobs passed; baseline lowering is now running. Application
  startup and browser measurements remain pending. The local comparison,
  checkpoint/provenance and diagnostic harness suite was rerun: 71 passed,
  zero failed/skipped. Downloaded seed evidence independently validates eight
  successful exact-identity optimizer proofs per arm and a final intentional
  status75 checkpoint (not a failed optimizer). Corrected generation still
  reports11,272,568 scalar sites in each arm, with acquisition sites reduced
  from11,272,568 to4,478,591 (6,793,977 elided) when batching is enabled.
  These static counts are not dynamic runtime measurements.
- Corrected-revision exploratory microbenchmark (same gate): waiter-aware off
  median34.286573ms (34.248286–34.423792), on17.633947ms
  (17.203486–20.549690), ratio1.944350462; legacy off59.231064ms,
  on30.142953ms, ratio1.965005353. Each median is nine timed batches of64 calls,
  not independent process replicates. These are NOT application speedups.
  Absolute times differ from the earlier hosted run and must not be compared
  across runs as evidence of a regression or improvement.

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
