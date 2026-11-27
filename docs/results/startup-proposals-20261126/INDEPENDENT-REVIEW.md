# Independent final review — limited startup / JS boundary experiment

2026-11-27 17:22 JST. Read-only source/evidence review; only this review file written. No production edits, commit, deployment, full checkout, Git repair, rebuild, or duplicate Cargo/browser run. Run **45964491888 remains pending for this review**; no result inferred. Local Node v24.22.2; working directory `/home/oligami/projects/rubrc`.

## Disposition

**Suitable to retain as default-off experimental work, not to promote. No critical production-reader/configuration defect identified in this scope. One reproducible medium-severity Cargo evidence-parser defect needs correction before reusing it as a strict completion witness.** No guaranteed 30-second outcome follows from this work.

The [frontend report](<docs/results/startup-proposals-20261126/frontend-45962666995/REPORT.md>) matches the saved [summary](<docs/results/startup-proposals-20261126/frontend-45962666995/summary.json>): two independent sessions/arm, eight visits, mixed cold/revisit results, all above 30 seconds. The [host findings](<docs/results/startup-proposals-20261126/HOST-CALL-FINDINGS.md>) appropriately disclose missing realms, sparse samples, and non-phase-exact snapshots. The [consolidated draft](<docs/results/startup-proposals-20261126/RESULTS.md>) correctly rejects release and does not present synthetic callback counts as performance evidence.

## Concrete findings and missing tests

1. **Medium — Cargo prompt ordering can falsely pass for a whitespace-prefixed marker.** [countMarker](<scripts/ci/measure_cargo_interactions.mjs#L19-L22>) accepts `line.trim() === marker`, but [prompt inspection](<scripts/ci/measure_cargo_interactions.mjs#L42-L54>) only trims line ends before `lastIndexOf(marker)`. A leading-space marker therefore counts as fresh while `lastIndexOf` returns `-1`; `slice(0)` searches the entire viewport, including an old prompt *before* the marker. Reproduced `interactionPassed: true` and `shellPromptAfterMarker: true` with no returned prompt (procedure below). Normalize consistently and explicitly reject an absent marker index; add a negative test with a prompt before a whitespace-prefixed marker. The existing workload prints an unindented marker, so this counterexample does **not by itself invalidate** its pending real run. Inspect raw snapshots for exact marker and subsequent prompt ordering. Parent notified immediately.

2. **Medium release-gate gap, already disclosed — Cargo observations are not exit-status/non-regression acceptance.** [The helper](<scripts/ci/measure_cargo_interactions.mjs#L59-L74>) deliberately ignores `exitCodeObserved`/`exitCodeZero` when deciding interaction success and always sets `releaseGatePassed: false`. Rendered terminal viewport is not lossless stdout/stderr, `STOCK_MANIFEST` is recorded rather than read back, and runtime idle only establishes input dispatch. Keep this limitation even if all three runs pass. Required before release: explicit successful status/output attribution, actual manifest/workload identity, matched published baseline, repeated initial/rerun/edit measurements and a predefined non-regression tolerance. Add parser/DOM tests for whitespace, viewport rollover, delayed output after marker, capture replacement/limits, page/model/target/generation changes and cleanup failures; present coverage is primarily positive fake-page orchestration plus selected failure cases.

3. **Low evidence-label/gate ambiguity — “reload” is a second navigation, not verified warm-cache behavior.** [The frontend loop](<scripts/ci/measure_frontend_pair.mjs#L19-L26>) uses `page.goto(url)` for both visits and records no HTTP/CacheStorage/IndexedDB hit evidence. Prefer “same-browser revisit (cache state unverified)” unless warm-state evidence is added; a fresh browser also does not make host filesystem caches cold. [Completion status](<scripts/ci/measure_frontend_pair.mjs#L46-L48>) can be `complete` with exit 0 when every visit exceeds 30 seconds. This is fine for investigation, but never equate green CI/`complete` with acceptance; preserve explicit `releaseAccepted: false` in summaries. A separate tested release evaluator should enforce required session/visit counts, timing, Cargo and baseline gates if promotion is later considered.

4. **Integration gate — native and small Wasm passes do not validate production coalescing across WVL.** The [reader](<crates/vfs-shell/src/sysroot_extraction.rs#L12-L87>) preserves remaining/cache accounting, checks cancellation before cached delivery, bounds refills and retains legal short-read behavior. The native [tests](<verification/sysroot-coalescing-native/tests.rs>) cover byte/count/order boundaries, cached-tail cancellation, errors and tar drain well. However the [Wasm fixture](<verification/sysroot-coalescing-native/wasm_boundary.rs#L6-L18>) uses a custom `probe` import returning an error code, whereas the [production shell import](<crates/vfs-shell/src/main.rs#L603-L648>) is void and the [production wrapper](<crates/vfs/src/lib.rs#L3699-L3707>) allocates/copies and appends mount input. Missing before promotion: real known-file rust-src mount validation; first/later import failure, short/long reply and JS trap behavior; cancellation during final fetch/drain and subsequent retry/new load; mount-abort/finish ordering; shared-memory/channel/thread integration; peak memory and synchronous callback latency. Native callback errors cannot certify JS trap cleanup. No new promise of rollback, retry safety or final-commit cancellation should be made.

5. **Missing efficacy attribution, not an implementation failure.** [Single-project configuration](<page/src/rust_lsp_config.ts#L62-L85>) defaults off, retains one immutable snapshot in ON and legacy activation in OFF. Existing [configuration tests](<page/src/rust_lsp_config_test.ts>) and browser UI results support this limited behavior, not the number of avoided graph rebuilds. Instrument actual project/workspace graph-load phases before describing measured duplicate-work elimination. The [coalescing implementation report](<docs/results/startup-proposals-20261126/sysroot-coalescing-implementation.md#L92-L99>) is appropriately conservative; its task-time “main not compiled” limitation is superseded only by the later [standalone shell build](<docs/results/startup-proposals-20261126/sysroot-coalescing-wasm-build.json>), not merged-app execution. No coalescing timing attribution is possible from the frontend pair, which used unchanged Wasm; future coalescing timings would measure a combined coalescing + progress-clock-relocation patch unless separated.

## Verification performed and retained reproduction

Reviewed all requested files, relevant harness tests, production call sites, frontend identity/provenance/summary, and [actual-source boundary log](<docs/results/startup-proposals-20261126/sysroot-boundary-final.log>). Accepted native OFF23/ON24 and six-length Wasm results as recorded evidence, without duplicating those builds. Standalone shell compile/link is not a matched baseline or full application test.

Executed from the project root:

```sh
node --test scripts/ci/measure_cargo_interactions_test.mjs
# Node v24.22.2: tests 12, pass 12, fail 0; exit 0.
node --input-type=module <<'JS'
import {inspectCargoEvidence} from './scripts/ci/measure_cargo_interactions.mjs';
const runtime={generation:'g',phase:'ready',operation:'idle'};
const x=inspectCargoEvidence({
  baseline:'/ $',
  snapshots:[{atMs:1,text:'/ $\n  CARGO_probe_BASE_338350'}],
  marker:'CARGO_probe_BASE_338350',
  history:[{...runtime,operation:'run'},runtime], runtime,
  generation:'g',prompt:'/ $'
});
console.log(JSON.stringify(x,null,2));
JS
```

Observed counterexample: `markerAtMs=1`, `commandDoneAtMs=1`, `shellPromptAfterMarker=true`, `interactionPassed=true`, `exitCode=null`, `releaseGatePassed=false`. Expected: interaction rejected because the only prompt precedes the marker. This is deterministic parser correctness evidence, not a browser/performance measurement.

Reviewed source SHA-256 (dirty workspace; not a clean-tree/commit identity claim):

| Source | SHA-256 |
|---|---|
| [Frontend measurement](<scripts/ci/measure_frontend_pair.mjs>) | `a5bbb840d40e79ccfaed9783c16a0d41cb9515a8457fe5db5d8b133cb05e0c71` |
| [Cargo measurement](<scripts/ci/measure_cargo_interactions.mjs>) | `ab75234f06df001101384d53011791bfa0c17e8f0098a2e4693fc3b8f32b4828` |
| [Reader](<crates/vfs-shell/src/sysroot_extraction.rs>) | `cd2fda026d915c3ac112a12fee09a74444b05b50a7cabb35478c7cffd101c155` |
| [Configuration](<page/src/rust_lsp_config.ts>) | `6dfa46956aa1b4cbf0b7b4ad32d062a7e44d865c77f2c09786cab250c7d0378d` |

Links above are project-root-relative. **Final recommendation: keep defaults off and no deployment; retain the limited evidence, fix the parser before stricter reuse, and close release gates only with actual integrated and baseline-matched measurements.**
