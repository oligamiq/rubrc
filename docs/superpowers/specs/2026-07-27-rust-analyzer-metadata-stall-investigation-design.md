# Rust-Analyzer Metadata Stall Investigation Design

## Goal

Identify the exact wait condition that prevents browser rust-analyzer startup from advancing beyond `querying project metadata`. The investigation must distinguish a rubrc scheduling or lifecycle defect from a stall inside embedded Cargo or another external component.

Syntax highlighting is outside this investigation. Its direct cause is already known: the Rust default extension and its TextMate grammar are not registered.

## Current Evidence

- The browser opens `/src/main.rs` and rust-analyzer reports `discovering sysroot`, then `querying project metadata`.
- Four embedded rustc subprocesses have previously returned status 0, but the surrounding embedded Cargo invocation has not returned.
- Controlled runs with 8 and 10 initial VFS workers reach the same boundary and dynamically expand through worker 15. A fixed eight-worker capacity shortage is therefore falsified.
- The browser transport publishes no diagnostics because project loading never completes.
- The passing Deno VFS integration provides a comparison path through the same rubrc-owned Cargo and rustc entry points.

## Scope

Instrumentation is limited to rubrc-owned code, primarily `crates/vfs/src/lib.rs`. The investigation will not modify Cargo, rustc, rust-analyzer, `wasi_virt_layer`, or browser shim packages.

Detailed traces are enabled only when `VFS_DEBUG_TRACE=1`. Normal execution must retain its existing output and control flow. Existing user changes and protected generated files remain untouched.

## Instrumentation

The primary diagnostic is a watchdog-triggered wait-state snapshot taken after rust-analyzer remains at `querying project metadata`. This avoids continuously serializing every scheduler operation and changing the interleaving under investigation.

Low-volume boundary events use existing child, command, worker, and channel identifiers as causal correlation IDs. They do not introduce a global sequence counter or lock. Events identify the current virtual thread where available and cover:

- entry and return of the embedded Cargo invocation;
- child command spawn, dispatch, return status, and reap completion;
- virtual thread pool enqueue, dequeue, execution start, execution return, and worker exit;
- completion channel send, receive, disconnect, and endpoint drop;
- stdout and stderr pipe creation, drain progress, EOF, and endpoint drop;
- joins or waits immediately surrounding Cargo and child execution.

The triggered snapshot records active workers, queued jobs, outstanding child and pipe endpoints, completion channel endpoints, and known join or wait locations. Events and snapshots describe state rather than dump command output or source payloads. Queue depth and endpoint state are included only when already available without acquiring a new cross-thread lock.

Trace egress uses a fixed-size ring buffer. Overflow increments a dropped-event counter instead of allocating without bound or synchronously flushing from worker threads. The browser test retrieves the ring and wait-state snapshot through rubrc-owned host glue after the watchdog fires. Rubrc's JavaScript call boundaries record request, callback, Promise resolution or rejection, and response delivery without modifying `wasi_virt_layer` or browser shim packages.

## Comparison Method

Run the passing Deno integration and failing browser acceptance with the same minimal workspace and VFS thread count. The browser observation window may be extended only in an isolated snapshot; the real worktree's acceptance timeout remains unchanged. Both paths trigger the same snapshot operation at the equivalent Cargo boundary, with the passing path also recording its state immediately before Cargo returns.

Failure reports retrieve the bounded event ring and the complete triggered wait-state snapshot; they do not rely on the terminal's current 4,000-character tail. Comparison is causal and state-based rather than a strict total ordering across engines. It identifies:

1. the last completed lifecycle phase for each correlated child, pipe, job, and completion endpoint;
2. the first lifecycle phase present in the passing path but incomplete in the browser path;
3. the outstanding queue, worker, child, pipe, join, channel, or host-call state at that point.

One variable is changed per experiment. Repeated runs are required only if event ordering is nondeterministic enough to prevent a conclusion.

## Classification

The result is classified by the first unmatched wait condition:

- an unreaped child process;
- an enqueued job that no worker executes;
- a lost or disconnected completion channel;
- an unfinished worker or join;
- an undrained stdout or stderr pipe;
- a rubrc host call whose callback or Promise does not complete;
- a Cargo-internal wait after all rubrc-managed work has completed;
- another boundary demonstrated by the trace.

If the defect is in rubrc, the investigation produces the smallest corrective design and a regression test. If the stall is beyond rubrc's ownership boundary, it produces a minimal reproduction, complete boundary trace, and a precise external blocker statement instead of speculative compatibility code.

## Verification

The instrumentation itself is verified by focused tests showing that trace gating is off by default, the ring is bounded, overflow is counted, the watchdog snapshot is retrievable, and required lifecycle transitions are emitted when enabled. Existing Deno VFS integration must continue to pass.

The investigation is complete only when the browser and Deno traces establish the first divergent lifecycle event and the outstanding wait state. Merely increasing timeouts, changing worker counts, or observing `querying project metadata` again is not completion.

After root-cause identification, temporary high-volume events are removed. Only concise diagnostics with continuing operational value may remain.
