# Actual-source native lock regression evidence

## Scope and objective

This experiment directly compiles the unmodified production lock at WVL commit
`77f45543eb976e4e7843e78fcd67bd837acac6bd` and runs its existing native regression
cases. It is **empirical implementation regression evidence, not a formal proof**.
The independent protocol model in this directory is a separate artifact; neither
model success nor native test success establishes all real executions are safe.

The source worktree is `/home/oligami/projects/rubrc/.worktrees/wvl-lock-batching`.
No production files are edited, no Cargo dependency graph is built, and no packages
are installed. This experiment does not commit or push anything.

## Inputs and compilation

The runner hashes these files before and after execution:

- [Production lock](../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs).
- [Existing shared regression cases](../../.worktrees/wvl-lock-batching/wasi_virt_layer/tests/support/memory_lock_cases.rs).
- [Production exported wrapper](../../.worktrees/wvl-lock-batching/wasi_virt_layer/src/shared_global.rs).
- [Existing native export smoke harness](../../.worktrees/wvl-lock-batching/wasi_virt_layer/tests/memory_lock_protocol.rs).

There are two harnesses:

1. **core**: a generated Rust crate root declares a `#[path = "<absolute actual
   production source path>"] mod memory_lock;`. This preserves `pub(super)`
   visibility and loads the production module's existing relative test-module
   path. Neither implementation nor test cases are copied or rewritten.
2. **exports**: the existing native smoke harness is compiled directly. It includes
   the production exported wrapper and its production lock submodule, so all core
   cases are repeated, plus one uncontended exported-reader notification test.
   Its existing stub macro suppresses unrelated generated globals, and native
   stubs replace Wasm wait/notify/memory-growth imports. Only uncontended exported
   reads are exercised by the extra test; no actual memory growth occurs.

Both harnesses are compiled with `rustc --edition=2024 --test`, with and without
`--cfg 'feature="waiter-aware-memory-lock"'`, and at `-C opt-level=0` and
`-C opt-level=3`. Feature-off selects the baseline branch in the same current source,
not a separate historical source snapshot. Each of eight binaries is run twenty
times, alternating `--test-threads=1` and `--test-threads=4`, always with
`--nocapture`. Optimized builds also exercise rustc's default optimized assertion/
overflow behavior rather than imposing Cargo profile settings.

The core test inventory is eight baseline tests and ten waiter-aware tests. The
export harness has nine and eleven respectively. Successful full execution is
160 test processes and 1,520 individual passing test executions, including repeated
core cases; it does **not** mean 1,520 distinct scenarios.

## Reproduction and evidence

Run from the project root:

```bash
python3 verification/memory-lock-protocol/native_regression.py
```

The runner refuses to overwrite any prior result file, log directory, or artifact
directory. To repeat, choose a new output directory (example only):

```bash
python3 verification/memory-lock-protocol/native_regression.py \
  --source-root /home/oligami/projects/rubrc/.worktrees/wvl-lock-batching \
  --output-dir verification/memory-lock-protocol/native-rerun-01
```

The [runner](native_regression.py) uses only Python's standard library. Every
subprocess is bounded: 60 seconds per compile, 20 seconds per list/test process,
30 seconds for compiler identification, and 10 seconds per Git query. A timeout
kills the subprocess's process group and collects stdout/stderr; test threads
cannot indefinitely stall the runner. The existing native cases additionally
have five-second condition-variable/channel watchdogs. `RUST_BACKTRACE=1` is set.

The machine-readable report is [native-results.json](native-results.json). It
records UTC start/end times, exact argv and shell-escaped commands, source commit,
Git status before/after, source SHA-256 before/after, runner/wrapper/binary hashes,
`rustc -vV`, host/Python information, each command's timeout/return code/duration,
test inventory, parsed outcomes, and paths and hashes for every raw stdout/stderr
stream. Logs are captured as bytes without discarding empty streams. Generated
wrapper and executables are retained locally alongside the logs. Executables (57MiB total) are deliberately excluded from Git; their hashes, build commands, generated wrapper and all raw logs are preserved, so a fresh checkout rebuilds rather than downloads binaries. A parent rerun used two repetitions per binary and also passed16/16 processes,152 individual executions; its report is `native-parent-results.json` and full local logs are under `target/verification-tools/protocol-native-parent/`. The primary run's360 raw stdout/stderr stream hashes were independently rechecked.

## Observed outcome

**PASS**, executed on 2026-11-26 from 05:11:42.285942 to 05:11:48.166765 UTC.
Host: x86_64 Linux; compiler: `rustc 1.98.1 (48a229cea 2026-09-01)`,
`x86_64-unknown-linux-gnu`, LLVM 22.1.8. Python: 3.14.4.

| Harness | Feature | Optimization | Tests/run | Successful runs | Passing executions |
|---|---|---:|---:|---:|---:|
| Core | Off | 0 | 8 | 20/20 | 160 |
| Core | Off | 3 | 8 | 20/20 | 160 |
| Core | On | 0 | 10 | 20/20 | 200 |
| Core | On | 3 | 10 | 20/20 | 200 |
| Exports | Off | 0 | 9 | 20/20 | 180 |
| Exports | Off | 3 | 9 | 20/20 | 180 |
| Exports | On | 0 | 11 | 20/20 | 220 |
| Exports | On | 3 | 11 | 20/20 | 220 |
| **Total** | | | | **160/160** | **1,520** |

All eight compilations and all eight inventories succeeded. No subprocess timed
out; no test failures or ignored/filtered tests were observed. All four source
hashes were unchanged, and target worktree Git status was clean before and after.
The [machine-readable summary](native-results.json#L4799-L4822) records these
outcomes. Raw [compiler identification](native-logs/002-rustc-version.stdout.log),
[baseline test output](native-logs/005-core-baseline-opt0-run01.stdout.log), and
[feature test output](native-logs/049-core-waiter-opt0-run01.stdout.log) provide
representative direct evidence; the report indexes every captured stream.

## Coverage interpretation and limitations

Existing deterministic hooks cover:

- overlapping readers and last-reader notification policy;
- waking a parked writer after the last reader releases;
- last reader leaving before writer-marker registration (feature only);
- notification between expected-state capture and actual parking;
- reader-count ABA before parking;
- writer-release broadcast reaching a reader;
- completion of two waiting writers;
- retry after one simulated spurious wait return;
- reader-count saturation at both marker settings (feature only);
- a four-thread, 100-iteration-per-thread exclusion/payload exercise;
- baseline versus waiter-aware uncontended exported-reader notification counts.

Important caveats:

1. **Backend assumption:** the native `Parking` backend uses a mutex and condition
   variable to make expected-value comparison/registration coherent with notify.
   It approximates the required compare-and-park contract; it does not implement
   or verify WebAssembly `memory.atomic.wait32`/notify, address routing, generated
   imports, or browser/runtime behavior. A marker is not proof that a writer is
   currently asleep: it persists until writer acquisition.
2. **Weak-memory gap:** this is native testing on the recorded host architecture,
   not exhaustive Rust/C++ atomic-memory-model exploration. Mutex/condition-variable
   and channel synchronization in the test backend may supply extra ordering that
   masks defects in the lock's own Acquire/Release edges. Payload fields are atomic,
   so this is not a non-atomic race-detector test. No Miri, Loom, sanitizer, ARM, or
   model checker runs are claimed by this experiment.
3. **Schedule gap:** repetition and parallel test dispatch are not exhaustive
   interleaving exploration. They do not guarantee CAS spurious failures or every
   multi-writer/reader wake selection. The multi-writer case uses two writers;
   the existing tests do not deterministically force every mixed reader/writer
   waiting population or broadcast race. The broadcast test observes one reader,
   not a fully populated mixed wait set.
4. **Progress gap:** both implementations intentionally prefer readers and permit
   writer starvation under unending reader traffic. Finite completion/watchdog
   success is not starvation-freedom, fairness, or unbounded liveness proof.
5. **Count boundary gap:** feature saturation is seeded directly at the boundary,
   and the test hook decrements the state to mimic an exiting reader. It does not
   create a billion reader threads, exercise a real saturated release schedule,
   or establish baseline safety at `i32::MAX`. Balanced, non-reentrant lock use is
   assumed; misuse/underflow/owner death is not tested.
6. **Integration gap:** these runs exclude transformed Wasm, CLI lock batching,
   offset globals, relocation/memory-growth correctness, real VFS memory, ABI
   generator validation, and performance/notification counts under real workloads.
   The export smoke harness uses a no-op generated-global macro and native stubs.
7. **Build gap:** direct `rustc --test` compiles test-only hooks and bypasses Cargo
   feature resolution, the full application graph, Wasm target flags, and workspace
   profiles. It validates these explicit native source configurations only.
8. **Evidence integrity:** source hashes establish exactly which files were used
   and detect changes spanning the experiment; they are not a cryptographic
   attestation of execution or proof that files could not change and change back.
   The generated binaries retain absolute source paths and may not be portable;
   rerunning the script is the intended reproduction method.
