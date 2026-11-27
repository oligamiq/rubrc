# Browser Cargo interaction helper — implementation and integration handoff

Date: 2026-11-27 (Asia/Tokyo). Objective: implement the predeclared [Cargo measurement plan](<CARGO-MEASUREMENT-PLAN.md>) without changing production code or duplicating the parent's hosted frontend experiment. **No browser/Cargo benchmark was run; there are no measured Cargo timings yet.** Parent reported corrected frontend experiment `45961525624` running after the earlier `ABBA45961080208`; this helper was not integrated into either run.

## Delivered scope

- [Measurement helper](<../../../scripts/ci/measure_cargo_interactions.mjs>): exported `measureCargoInteractions(page, options)`, for an already-loaded Puppeteer Page. No CLI side effects, server, browser launch, navigation, reload, build, target change, analyzer shutdown, cache reset, or private runtime invocation.
- [Unit tests](<../../../scripts/ci/measure_cargo_interactions_test.mjs>): evidence classifier plus an in-process fake DOM/Monaco/Puppeteer orchestration test. These are NOT real browser validation.
- [Raw unit output](<CARGO-HELPER-UNIT-20261127.log>): 12/12 passed.

No production files changed. No commit, push, checkout, reset, or Git pack traversal was performed. Checkout/commit identity is intentionally **unverified** because the parent reported local Git pack corruption; the integrating workflow must record its verified build identity and asset hashes.

## Existing API investigation

- [Existing test API](<../../../page/src/lsp_test_api_state.ts#L35-L71>) exposes Monaco model/editor, runtime state/history and lifecycle controls; **no terminal instance, stdout stream, command-completed event, or exit status**. The helper uses model and state/history only, never `runRuntime`.
- [Terminal binding](<../../../page/src/xterm.tsx#L53-L58>) forwards runtime writes into a locally scoped xterm instance. [Xterm wrapper](<../../../page/src/solid_xterm.tsx#L180-L198>) opens the terminal; no global test handle is installed. Current configuration uses the normal DOM renderer; helper requires `.xterm .xterm-rows` and fails explicitly if unavailable.
- [Public button](<../../../page/src/btn.tsx#L1-L36>) calls the actual application `run` handler; [App wiring](<../../../page/src/App.tsx#L563-L569>) supplies selected target and runtime handler. The helper obtains this exact button by text and invokes Puppeteer's ElementHandle.click(), not `HTMLElement.click()` or a test runtime shortcut.
- [Runtime run](<../../../page/src/app_runtime.ts#L857-L877>) returns to idle after flush plus command dispatch; [command service](<../../../page/src/runtime_command_service.ts#L232-L235>) awaits the input-string endpoint. **Idle is not a process-completion or exit-zero witness.**
- [Shell prompt](<../../../crates/vfs-shell/src/main.rs#L1356-L1375>) is emitted after `handle_parallel` returns and prints its failures. Prompt format is [absolute working directory followed by ` $ `](<../../../crates/vfs-shell/src/main.rs#L1012-L1019>). The helper requires that prompt after the fresh stdout marker. [Nonzero command status](<../../../crates/vfs-shell/src/main.rs#L792-L806>) is printed as `Command exited with status: N`; successful zero status is not printed.
- [Stock manifest](<../../../page/src/workspace_fs.ts#L51-L60>) contains package `main`, version `0.1.0`, edition `2021`, no dependencies. The helper does not alter it. Existing test API cannot read the VFS manifest, so caller must ensure the stock workspace and record that precondition.

## Workload and measurement contract

One loaded page, one visible terminal and only Session 0, ready analyzer, ready/idle runtime, displayed `file:///src/main.rs`, preselected `wasm32-wasip1` (configurable expected target; helper never changes it):

1. Set Monaco model to a deterministic std-only program. Checked multiplication/addition sums squares `1..=100`, asserts `338350`, then prints `CARGO_<token>_BASE_338350`.
2. Click **Compile and Run**. Observe new whole-line marker in rendered terminal DOM, returned empty shell prompt after that marker, and runtime history `run → idle`.
3. Click **Compile and Run** again **without setting/changing model**. Require a larger marker occurrence count than the pre-click terminal snapshot. Model version must remain identical to step 2.
4. Set edited program summing `1..=101`, assert `348551`, print distinct `CARGO_<token>_EDIT_348551`, and click again. Require new marker/prompt evidence and advanced model version.
5. Restore original Monaco source without executing another command. Compilation artifacts remain from the workload.

The source and its SHA-256 are recorded. Token defaults to 12 random hex characters; a caller-provided safe ASCII token makes workload bytes reproducible. Use one token across independently isolated A/B browsers for byte-identical source; ensure output was not already present. Pass a new token if rerunning in the same terminal.

Host `elapsedMs` starts immediately before the Puppeteer click and ends when marker + prompt + runtime transition are all observed. It includes automation and observation overhead (default 100 ms poll). `markerAtMs` and `commandDoneAtMs` use the DOM observer's earlier installation clock, explicitly labeled in the result; they are not the primary click latency. Initial compile means first compile of this workload in that session, **not necessarily a cold Cargo cache**.

A MutationObserver captures only rendered xterm row text, with per-snapshot timestamps, pre-click baseline, runtime history and failure evidence. No document-body text, source-substring witness, fabricated stdout, console-as-stdout, private xterm internals, or injected production hook is used. Keep the terminal wide enough to avoid wrapping the ≤49-character marker (1280×900 recommended). If marker counts cannot increase because the viewport rolls over, the test fails closed instead of inventing freshness. Snapshots are viewport observations, not lossless byte stdout/stderr; the channels are merged by the UI. Bounds: 1,024 changed snapshots / 4 MiB per command, 180 seconds per command, 15 seconds per setup/cleanup call by default. Any replaced/hidden terminal, changed model/target/page/generation, page crash/error, or capture overflow fails.

Returned top-level status is either `pass-observed-interactions` or `fail`; each run preserves assertions, snapshots and timing. With `outputDirectory`, a **fresh** directory is created (existing directory is rejected without overwriting its result) and successful per-run JSON plus final JSON are saved; failed run snapshots remain in final JSON. Parent directory must already exist. Without an output directory the caller must persist the returned object. Deadlines bound the helper's wait, not guest execution: after a timeout/failure, the parent must close its browser/page in its existing `finally` block, rather than reuse a possibly still-running guest command.

### Exit status and release gate limitation

An observed marker followed by prompt proves the deterministic main body reached its final print and the shell returned from the command; it **does not prove explicit process exit zero**. A fresh printed nonzero status is retained and fails the interaction even if the marker was already printed. Successful current builds return `exitCode: null`, `exitCodeObserved: false`, `exitCodeZero: false`. `releaseGatePassed` is **always false**. No default-enablement or published-release non-regression conclusion is warranted.

To close the exit-status gate, parent should separately authorize/design a generation/session/command-correlated completion hook that forwards actual guest exit status and terminal writes without altering acknowledgements. None was added here. A DOM prompt or absence of error must not be relabeled exit zero.

## Actionable future integration

Use the existing parent browser lifecycle, not a second browser alongside a benchmark. Build both compared fronts with `VITE_RUBRC_LSP_TEST=1`; preserve the parent's exact generated adapter, `+v1` assets, target/compiler/runtime binaries and cache settings. Wait for startup readiness and any prior editor interaction helper to restore its source. Only Session 0 should exist and its terminal should be scrolled to the latest empty prompt. Do not call during a running frontend timing window.

Example inside a future measurement driver located under `scripts/ci`:

```js
import assert from 'node:assert/strict';
import { measureCargoInteractions } from './measure_cargo_interactions.mjs';

// Existing page, already navigated and ready. Parent owns browser cleanup.
const cargo = await measureCargoInteractions(page, {
  outputDirectory: join(out, `${i}-${mode}-cargo`), // fresh child directory
  token: 'comparison45961525624', // same source bytes across independent A/B pages
  timeoutMs: 180000,
  setupTimeoutMs: 15000,
  pollMs: 100,
  target: 'wasm32-wasip1',
  metadata: {
    mode, repetition: i, comparisonOrder: 'A-B-B-A',
    // Add real verified build/asset hashes, browser.version(), host/CPU,
    // stock-manifest provenance, cache state and parent artifact identifiers.
  },
});
session.cargo = cargo;
assert.equal(cargo.status, 'pass-observed-interactions', JSON.stringify(cargo));
assert.ok(cargo.runs.every(run => run.assertions.freshTerminalMarker
  && run.assertions.shellPromptAfterMarker && run.assertions.runtimeRunThenIdle));
// Explicitly keep the release gate pending; do not assert exitCode===0 here.
assert.equal(cargo.releaseGatePassed, false);
```

Predeclare independent-browser A-B-B-A repetitions on the same host and identical assets/cache state; run all three Cargo interactions consecutively on each selected page. Do not reload between them. Preserve all repetitions, raw snapshots, workload source/hash, build and browser versions, and stdout/errors. A local flag off/on comparison does not establish equivalence to an unknown deployed baseline. No slowdown threshold/tolerance/statistical policy has been invented.

If the DOM renderer is absent, current render wrapping differs, or prompt parsing fails on integration: retain failure JSON, investigate actual terminal DOM, and report to parent. Do not substitute body text. No actual browser validation was performed here, so prompt/DOM compatibility remains an integration check.

## Static/unit experiment evidence

Environment: Node `v24.22.2`, working tree `/home/oligami/projects/rubrc`, date 2026-11-27. Code identity: the new source files delivered with this report; Git commit not queried. Commands:

```sh
node --version
node --check scripts/ci/measure_cargo_interactions.mjs
node --check scripts/ci/measure_cargo_interactions_test.mjs
node --test scripts/ci/measure_cargo_interactions_test.mjs > docs/results/startup-proposals-20261126/CARGO-HELPER-UNIT-20261127.log 2>&1
```

Observed outcome: both syntax checks succeeded; 12 tests passed, 0 failed. Coverage includes deterministic arithmetic, source-text false witness rejection, stale marker/status rejection, prompt ordering, runtime/generation requirements, explicit nonzero exit after marker and compile failure before marker, no fabricated exit zero, three actual helper-path click calls with unchanged model version, bounded missing-output timeout, DOM-renderer absence, capture limits, and no launch/navigation/runtime shortcut. Test durations are unit execution time, **not Cargo performance measurements**.
