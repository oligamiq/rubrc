# Actual Wasm wait/notify correspondence

## Objective and scope

Verify the production `PostCombineStreamPass` lowering of `wvl_atomic` imports
`__wvl_atomic_wait32_vfs` and `__wvl_atomic_notify_vfs`, then execute those exact
emitted bytes in Node worker threads sharing a `WebAssembly.Memory`.

This harness imports the **complete real production Rust source files**, not an
extracted match branch, handwritten replacement, or full CLI crate. The pinned
source checkout is `77f45543eb976e4e7843e78fcd67bd837acac6bd`, normally at
`.worktrees/wvl-lock-batching`. The runner fails on a different revision or dirty
checkout. No production files are modified. Generated fixtures contain actual
imports, exports of the imported functions, and defined wrappers calling those
imports; this checks both export and call-index rebinding.

## Reproduce

From the rubrc repository root, with Python 3.12+, native Rust 1.98.1/Cargo,
Node 24.22.2, and a clean source checkout at the revision above:

```sh
python3 verification/memory-lock-wasm/run.py \
  --output-dir verification/memory-lock-wasm/results/my-fresh-run
```

The output directory **must not already exist**. Default operation permits Cargo
to fetch the locked small dependency graph. For fully cached environments:

```sh
python3 verification/memory-lock-wasm/run.py --offline \
  --source-root .worktrees/wvl-lock-batching \
  --output-dir verification/memory-lock-wasm/results/my-fresh-offline-run
```

`--cargo-home /path/to/cache` selects another Cargo cache. `WVL_SOURCE_ROOT` is an
optional environment default; explicit `--source-root` takes precedence. No Wasm
Rust target, wasm-tools, browser, C++ Wasmtime graph, or full CLI build is needed.
The 38 external Cargo packages are locked by [Cargo.lock](harness/Cargo.lock).
Direct dependencies: eyre 0.6.12, wasmparser/wasm-encoder 0.252.0, wat 1.252.0,
rayon 1.12.0, log 0.4.29, serde_json 1.0.149, strum 0.28.0 with derive.

## Structural oracle

[The Rust harness](harness/src/main.rs) invokes the actual pass twice, with
`threads=true` and `threads=false`, on the same fixture. It validates input/output
binaries, independently decodes the output with wasmparser, and requires:

* Both special function imports eliminated; only `env::memory` remains.
* One shared memory, index 0, minimum/maximum one 64-KiB page, wasm32.
* Wait signature `(i32, i32, i64) -> i32`; notify `(i32, i32) -> i32`.
* Exactly `local.get 0; local.get 1; local.get 2; memory.atomic.wait32; end`
  for wait, and the corresponding two-argument notify body.
* Both atomics use memory 0, offset 0, alignment exponent 2.
* Both defined wrappers have unchanged signatures/arguments and calls rebound to
  the generated functions.
* A deliberately malformed i32 timeout ABI is rejected by validation/oracle.

The real imported modules are abi, pipeline, translator, mem_info, own_memory_abi,
post_combine, fn_in_starts, and reactor_initialize. No production dependency is
stubbed. [build.rs](harness/build.rs) supplies explicit source paths and Cargo
change tracking for all eight files and the source-root environment setting.

## Worker oracle and parking evidence

[The Node test](worker-tests.mjs) sends the **generated Wasm bytes** and the shared
memory to each worker. Workers independently instantiate the module and call its
exported functions. Every worker checks mismatch => 1 and matching zero-timeout
=> 2, signals readiness, then enters a finite five-second **Wasm** wait.

There is no JavaScript `Atomics.wait`, `Atomics.waitAsync`, or `Atomics.notify`.
JavaScript atomic load/store is used only for a separate completion flag.
Readiness is explicitly **not** treated as proof that a worker is parked. After
all readiness messages, the parent calls the generated Wasm notify repeatedly,
yielding with `setImmediate` (not sleeping), until its returned wake count proves
a real parked waiter existed:

* `notify-one`: one worker, count 1, require an actual single notify return of 1.
* `notify-all-u32-max`: three workers, count -1 (unsigned `u32::MAX`), require a
  **single** actual notify call returning 3. If only a subset wakes, workers loop
  back into wait until all three are parked together and this witness is seen.

Each awakened worker must report wait result 0. A bounded notify drain covers the
race where a worker re-enters wait before observing the completion flag. Notify
with count zero, notify at a distinct address, and notify after worker completion
must all return zero. The tests do not rely on presumed scheduling or sleeps.

`notify-one` does **not** prove selective waking among multiple simultaneously
parked waiters, because that case uses only one worker. The three-worker case
proves an all-wake witness, not fairness or eventual completion under arbitrary
scheduling. Runtime testing uses the threads-enabled emitted module; both modes
are structurally checked. This is a bounded ABI/lowering/engine correspondence
check, not proof of the entire memory lock protocol, weak-memory behavior,
production VFS linking, Rust lock lifecycle, or CLI end-to-end behavior.

## Bounds and evidence

* Cargo build: 240 seconds by default (`--build-timeout`), 2 build jobs;
  source/versions queries 10 seconds each; native harness 20 seconds.
* Node subprocess/global watchdog: 30 seconds; per phase 8 seconds;
  each Wasm wait 5 seconds; notification/drain attempt ceiling 1,000,000 per cohort.
  Readiness polling is wall-clock bounded but does not consume notify attempts.
* Two Rayon threads; child CPU soft/hard limits 240/241 seconds; no core dumps.
  There is no claimed RSS limit. Timeouts kill the complete child process group.
* Worker termination is awaited in `finally`; no jobs intentionally survive.
* Python optimization is explicitly rejected rather than disabling assertions.
* Reports begin as failure and become success only after structural/runtime case
  inventory checks and source hash/status stability checks. Nonzero exit means
  failure. Existing evidence directories are never overwritten/deleted.

Every run writes raw command stdout/stderr, exact argv/cwd/timeout/exit/time,
compiler/Node/Python/platform versions, source revision/status and before/after
SHA-256, harness/lockfile/executable hashes, input WAT/Wasm, both emitted binaries,
[structural and runtime reports](results/final-20261126/result.json), and artifact
hashes. The `result.json` file itself is not included in its own hash manifest.

## Observed results (2026-11-26 UTC)

* [Initial run](results/initial-20261126/result.json): PASS, actual full-source pass
  + four total workers; notify witnesses 1 and 3. Node 24.22.2, Rust/Cargo 1.98.1,
  Python 3.14.4 on this host. This earlier run used the stricter 100,000 iteration
  bound; retained without overwriting.
* [Final run](results/final-20261126/result.json): PASS after separating readiness
  from the notification attempt budget, increasing the bound, enforcing source
  revision/cleanliness and source status after execution, and rejecting `-O`.
* [Optimized Python negative control](results/optimized-python-rejected-20261126/result.json):
  expected FAIL with exit 1 and diagnostic; no build/runtime falsely marked pass.

Final commands were:

```sh
python3 verification/memory-lock-wasm/run.py --offline \
  --output-dir verification/memory-lock-wasm/results/final-20261126
python3 -O verification/memory-lock-wasm/run.py --offline \
  --output-dir verification/memory-lock-wasm/results/optimized-python-rejected-20261126
```

An exploratory offline build before the instrumented runner reported exit 101
with compilation warnings but no concrete error in the returned tool output.
An immediate same-command retry with one build job returned 0;
[its raw build log is retained](build-attempt2.log). That uninstrumented first
attempt is not treated as evidence of success and has no reconstructed raw log.
Both subsequent complete instrumented runs have their own successful raw build
logs. No source workaround or production change was made for the exploratory
failure. CI should use the fresh runner rather than any existing binary/result.
