# First hosted JS boundary results (partial coverage)

2026-11-27 JST. Run https://github.com/oligamiq/rubrc/actions/runs/45958190399 at2635f7fe; input verified retained batching-on preview from45131532216. Raw downloaded evidence in hosted-45958190399/. No application source or Wasm change in this experiment.

Control reached ready48.765s; instrumented45.152s. Single sequential runs, warm host and instrumentation differences: NOT a speedup comparison, neither satisfies30s. User-level completion/diagnostic editing checks and Cargo benchmarks were not run; startup readiness does check versioned diagnostics/inlay hints.

Import counts captured from19live realms (page, util_cmd,17thread_spawn workers):
- clock-time-get11029,9samples inclusive total0.145ms, max0.025ms.
- sysroot-read-archive-chunk9595,9samples inclusive total6.245ms,max0.790ms.
- terminal-write1038, no timed samples (period1024 per instance, distributed).
- sched-yield224, fd-write65, random-get32, thread-spawn17.

Four OTHER worker snapshots timed out: lifecycle_worker, editor.worker, worker, worker_background_worker. Therefore original diagnostic-complete label/green job overstated coverage. Parent explicitly classifies this as PARTIAL, not all-JS coverage. Harness corrected to return diagnostic-partial and nonzero for errors. Live snapshots omit already terminated workers; no count claimed for missing realms. Worker pause/resume collection occurs after ready, not a phase-exact end snapshot. Periodic sample9 is sparse, inclusive time can include waiting/nesting; do not sum/extrapolate as startup wall time.

Useful actionable observation: sysroot bridge is frequently called and slower per sampled call than clock read. Shell directly forwards each Read buffer to host and computes elapsed clock every chunk even progress is printed only perMiB. Investigate bounded read aggregation and moving progress clock computation under existing report condition; verify cancellation, mount/stream side effects, error and memory limits. Clock caching is not justified by these measurements; would risk precision/deadline semantics. Need improved samples and repeated controlled performance before promotion.

Local control error was short protocolTimeout; later corrected local attempt Chrome SIGABRT unrelated to accepted test success. Hosted control reached ready. Local git worktree reconstruction separately failed corrupt pack (local-git-object-error.md); no destructive repair performed.
