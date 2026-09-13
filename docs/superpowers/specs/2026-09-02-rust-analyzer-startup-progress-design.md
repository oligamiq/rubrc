# Rust-Analyzer Startup Progress Design

## Goal

Make long rust-analyzer crate-graph activation observable in the startup overlay.
Users must be able to distinguish continuing analysis from a stalled process before
the existing 300-second timeout expires.

## Scope

This change exposes progress already observed by the crate-graph readiness loop.
It does not change:

- the 300-second readiness timeout;
- the five-second crate-graph polling interval;
- the required `rubrc_main`, `core`, `alloc`, and `std` labels;
- request ordering, cancellation, or disposal behavior;
- rust-analyzer configuration or memory limits.

Cargo-call counts, VFS debug memory pages, raw DOT, and rust-analyzer log messages
remain diagnostic-only and are not added to the startup overlay.

## Progress Contract

`RustAnalyzerReadiness.waitForCrateGraph()` accepts an optional observation-only
callback and emits this immutable value after each crate-graph request outcome:

```ts
export type CrateGraphProgress = {
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly labels: readonly string[];
  readonly ready: boolean;
};
```

`attempt` starts at one. `elapsedMs` and `remainingMs` use the readiness instance's
existing monotonic `now()` source and deadline. `labels` contains only the four
required labels, in the stable order `rubrc_main`, `core`, `alloc`, `std`.

A successful graph response emits the labels found in that response. A
`ContentModified` response emits an event for the attempt with an empty label list
and `ready: false`, then follows the existing retry path. Other request errors keep
their existing behavior and are not converted into progress.

The observer is telemetry only. Observer exceptions are caught and ignored so a UI
or test subscriber cannot interrupt startup.

## Data Flow

The structured event follows the existing startup ownership chain:

```text
RustAnalyzerReadiness
  -> RustProjectActivation
  -> StagedAnalyzerSession.activateProject
  -> StartupCoordinator
  -> StartupSnapshot project task
  -> StartupOverlay and test API
```

`StartupCoordinator` remains the owner of published startup state. It accepts
project progress only for the current generation while startup is active. Events
received after abort, failure, readiness, disposal, or generation replacement are
discarded.

The project task gains an optional `projectProgress: CrateGraphProgress` value
rather than a percentage. Progress updates preserve this value during
`project-activating`. Entering `semantic-warming` or `ready` clears it because crate
graph discovery has ended. Entering `failed` preserves the last value for diagnosis.

## Overlay

During `project-activating`, the Project row replaces the indeterminate `...` with
two lines derived from the structured event:

```text
› Project                         125s · poll 24 · crates 3/4
                                  rubrc_main, core, alloc · waiting: std
```

Before the first response, the existing pulsing `...` remains visible. Elapsed time
is shown in whole seconds. The labels line wraps within the existing overlay rather
than widening it. No percentage is shown because crate discovery is not a linear
measure of analysis completion.

At timeout, the last observed details remain visible while the Project task changes
to failed and the existing timeout message is shown. At readiness, the existing
phase transition replaces the running detail with the normal completed task state.

## Test API

The startup test state exposes the latest structured project progress together with
the phase history. Tests must not issue an additional crate-graph request to obtain
this value; it must be the exact progress event emitted by the production readiness
loop.

## Error Handling

- Observer exceptions do not affect readiness.
- Stale-generation and post-abort progress is ignored.
- `ContentModified` remains retryable and observable as an incomplete attempt.
- Ordinary request failures and the 300-second timeout keep their current errors.
- The last emitted progress remains available when startup fails.

## Verification

Unit tests cover:

- attempt numbering and monotonic elapsed time;
- stable filtering and ordering of the four required labels;
- ready and incomplete graph events;
- `ContentModified` progress followed by retry;
- observer exceptions not interrupting readiness;
- coordinator publication and stale-generation suppression;
- overlay rendering before the first poll, during partial progress, and on failure;
- test API exposure of the production polling event.

Deterministic readiness tests verify that delayed crate-graph responses emit changing
elapsed time, attempt count, and labels before readiness. Built browser acceptance
verifies that the production polling event reaches the rendered overlay and retained
test state, then reaches the existing ready state without an additional crate-graph
request or any change to startup semantics.
