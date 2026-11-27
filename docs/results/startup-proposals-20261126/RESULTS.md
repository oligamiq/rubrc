# Scoped startup / JS-boundary optimization results

2026-11-27 JST. Scope authorized: investigate duplicate RA initialization/reanalysis and frequent Wasm→JS/timer calls; implement limited evidence-backed experiments. Independent-memory redesign excluded. No public deployment and no default enablement.

## Findings and changes

1. Source audit found linkedProjects=[] does not disable initial manifest discovery; later inline project identity differs from discovered file project. This opens a second workspace load route. It is NOT a measured count of completed duplicate graph builds. Added defaultOFF single-project initialization, only when sysrootsReady, preserving document reopen, write barriers, semantic readiness, cleanup and legacy fallback.
2. Hosted import profiling produced PARTIAL coverage:19realms including17thread-spawn workers, four other worker snapshots missing. Clock11029calls, sysroot chunk9595, terminal1038. Only9 clock and9 chunk timing samples; inclusive durations not CPU or wall time attribution. Clock caching not implemented; no evidence it is worthwhile/safe. Details HOST-CALL-FINDINGS.md.
3. Added defaultOFF64KiB coalescing and progress-only clock sampling in vfs-shell. Cancellation checked even on cached tail; one refill per logical read, bounded incremental heap64KiB, max512KiB public read cap preserved, source mount sideeffects/drain retained. Native actual-source OFF23/ON24passed; actual shell wasm32-wasip1-threads compile/link passed. Small actual-source Wasm→JS fixture verified exact data/six lengths and callbacks1350→17 at1048593bytes consumed777bytes each. NOT merged application performance or full shared-memory/mount/trap integration.

## Actual frontend comparison

Run45962666995: unchanged Wasm/cache, same-host OFF/ON/ON/OFF,2sessions each, cold+reload, Chrome150. All8 actual completion/diagnostic UI checks succeeded. ON navigation→both checks44.971–54.572s. Cold mean50.791→47.333s; reload48.424→49.771s. Mixed result, too few replicates to claim reliable speedup. All8exceed30s; ready-aloneON43.04–52.28s also exceeds30s. Detailed raw JSON/screenshots/provenance and report in frontend-45962666995/.

## Public release decision

DO NOT UPDATE public build.30s condition unmet in measured environment. Cargo non-regression against published version unestablished; published source revision remains unknown. Cargo helper uses visible button, terminal-only fresh marker and returned prompt; existing APIs do not expose explicit successful exit status, so helper never certifies release gate. First Cargo attempt45963794430 stopped before compile due stale prompt after background logs; fixed by empty Enter before timing. Corrected run45964491888 actually clicked Cargo but baselineOFF initial compile did not produce marker/prompt within180s. Console repeatedly records cargo27/rustc31 waiting. Cause unresolved, not proof of introduced regression. Followup45965528969 at751ffa20 preserves failed arms and continues independentON/ON/OFF, final fail if any failure; watch bash-67a045afc2b94d6a. No non-regression claim.

## Reproduction and limitations

Experimental branch perf/memory-lock-batching; no main/runtime defaults altered. Relevant commits af81aa91(single-init/profiler),90b7972e(coalescing),ec5347ea(memory-compatible reconstruction),deb39f40(first Cargo integration),5ff404d6(fresh prompt). CI workflows startup-host-diagnostic.yml/startup-frontend-comparison.yml invoked via stdlib-cache-ci workflow_dispatch mode. No public deployment step.

Reconstruction failures preserved, not efficacy failures: missing v1 assets, mismatch checked-in vs CI-generated adapter, then memory1028 vs required9203pages. Only corrected45962666995used for frontend comparison. Local Chrome SIGABRT and git corrupt pack recorded separately; no destructive repairs; remote clean build used. Unrelated dirty binary/bindings untouched.

Independent review INDEPENDENT-REVIEW.md found no critical production defect, but reproduced a Cargo prompt-order parser false positive for indented markers. Fixed normalized marker position and added regression test (13tests pass); prior failed Cargo run had no marker so unaffected. Review correctly notes second navigation isn't verified warm cache and green workflow completion isn't release acceptance. Pending: all-arm Cargo results; real merged-app coalescing benchmark and trap/cancellation cleanup; public baseline matching. Do not claim a release gate or unmeasured optimization. Keep experiments opt-in pending evidence.
