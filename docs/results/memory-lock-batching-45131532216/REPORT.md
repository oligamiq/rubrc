# Bounded memory-lock batching: browser result

Recorded 2026-11-26 JST from completed [CI run45131532216](https://github.com/oligamiq/rubrc/actions/runs/45131532216). Objective: implement idea1 (bounded guest-memory read-lock coalescing) and measure actual application performance without weakening optimization.

## Result

The predeclared A–B–B–A acceptance criterion passed: BOTH candidate session semantic-warming medians are below BOTH baseline medians. This is a small exploratory same-runner experiment, not a statistical significance claim.

| Metric | Off | On | Interpretation |
| --- | ---: | ---: | --- |
| Semantic warming, median of two session medians |31.6968s|14.9004s|2.127×;53.0% less time |
| Total startup, median of four visits |64.3561s|36.5559s|43.2% less time; includes more than semantic warming |
| Completion, median of two interactions |1.7581s|0.8051s|Exploratory; two observations per arm |
| Type diagnostic, median of two interactions |0.7673s|0.7175s|Small difference, overlapping observations; no robust improvement claim |
| Peak renderer RSS, median of two session peaks |5,528,914KiB|4,260,906KiB|About22.9% lower; sampled renderer RSS, not total machine memory |

Raw session order:

| Session | Setting | Cold semantic ms | Reload semantic ms | Session median ms |
| --- | --- | ---: | ---: | ---: |
|1|off|30522.735|33446.755|31984.745|
|2|on|15359.885|13948.420|14654.1525|
|3|on|14811.310|15481.900|15146.605|
|4|off|32331.170|30486.665|31408.9175|

All eight visits reached ready, reported cache loaded AND merged, and had no missing assets or worker setup errors. Each of four editor checks returned12 completion items and the expected `expected u32, found &'static str` diagnostic. Session3 also reported an extra `Syntax Error: expected SEMICOLON`; the acceptance harness requires the target error but does not assert an exact diagnostic-set match. Do not claim full semantic equivalence from these checks.

## Inputs and procedure

- Application source: `ff3e160d74cf2be990d0b0b39d764b306833e6bd`.
- WVL: `77f45543eb976e4e7843e78fcd67bd837acac6bd`, same waiter-aware runtime in BOTH arms. Only batching setting differs in the experiment configuration.
- Analyzer source: `07e8d30e340e504655ebace245a8df17f7f91fbf`.
- Rust O3, fat LTO,1CGU; analyzer and final core O3; WVL O4 with existing O3 TryTable ceiling. No size rollback or unsafe optimizer assumptions.
-512MiB initial VFS heap, RA pool2, initial VTP8(auto-grow), browser hardwareConcurrency4.
- Same hosted Ubuntu24.04 runner, AMD EPYC9V45 virtualized4CPUs, Chrome150.0.7871.24,1280×900,dpr1. Local preview, unthrottled network. Fresh browser sessions in off/on/on/off order; cold+reload per session. No primary-timing CPU sampling.
- All eight pre-lowering optimizer inputs, tools, args and output hashes matched across arms. Build provenance and individual core/cache hashes were validated by the CI harness.
- Each arm generated its OWN cache using the bundled WASM analyzer: off34,545,178bytes; on34,545,182bytes. Cache SHA differs. The harness verified each artifact and successful adoption, but did NOT compare decoded caches for semantic equality. Thus this is a comparison of the two complete generated previews, not an identical-cache micro-isolation of just lock overhead.

Launch command used (without any old checkpoint producer):

```sh
gh workflow run 378086753 --repo oligamiq/rubrc \
  --ref perf/memory-lock-batching \
  -f mode=memory-lock-comparison -f memory_lock_gate_run=45130504077
```

CI runs `node scripts/ci/paired_startup.mjs run ...` after verifying both preview archives. Parent independently re-ran `validatePair`, `summarizeSession` for every raw session, and `compareSessions` on downloaded logs; acceptance and recorded timing values matched.

## Evidence

- [Comparison](comparison.json), [session summaries](sessions.json), [CPU information](runner-cpu.txt), [raw-file hashes](raw-sha256.json).
- Raw JSONL: [session1](1-batching-off/normal.jsonl), [session2](2-batching-on/normal.jsonl), [session3](3-batching-on/normal.jsonl), [session4](4-batching-off/normal.jsonl).
- Full project-local downloaded screenshots/network/memory evidence: `target/lock-batching-evidence/45131532216/paired-results/paired/`.
- Both final builds and cache generation logs: `target/lock-batching-evidence/45131532216/finish-evidence/`.
- Independently reconstructed summary: `target/lock-batching-evidence/45131532216/verified-browser-metrics.json`.
- Fixed-revision microbenchmark: `docs/memory-lock-batching-micro-45130504077.json` (approximately1.94×, a separate result, NOT substituted for browser performance).

## Scope and limitations

Implementation and requested experiment are complete. Batching remains default OFF, on the isolated experimental branch; no public deployment was performed. Independent read-only review also replayed acceptance, checked all eight VFS memory-coverage records, recomputed phase deltas/RSS from raw rows, and bound final optimization/batching evidence hashes to session metadata. It agreed with the acceptance result.

Additional limits: renderer RSS is the maximum single-renderer observation sampled every5seconds over the whole session; longer off sessions have more samples (27/25 versus15/15). It is not exact peak or total browser memory. Both cache-generation builds log a `cargo metadata failed` error before continuing successfully; this shared warning was not repaired by this experiment. The harness does not reject every browser console/pageerror or require diagnostic version freshness. Browser cold means a fresh browser/storage context, not a cold OS page cache.

Repeated independent runs, other hardware/mobile devices, larger workspaces and stronger semantic-equivalence checks remain useful follow-up before default enablement. Browser performance is demonstrated for this tested workload, not all Rubrc operations.

The experiment also found and fixed a pre-existing reset/optimizer interaction: Binaryen encoded `data.drop` as a synthetic global that later removal missed. Both arms include the same early passive-data-retention fix. See `docs/memory-lock-reset-diagnosis-2026-11-23.md`; its O3/O4 negative-control regression passed on pinned Binaryen131. No optimization level was lowered to obtain this result.
