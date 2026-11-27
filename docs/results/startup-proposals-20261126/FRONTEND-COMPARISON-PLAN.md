# Isolated frontend comparison plan

2026-11-27 JST. Not yet executed.

To measure single-project-init without confounding Wasm rebuilds:
1. Create new isolated worktree from experimental committed harness. Do not overwrite root dirty bindings/Wasm.
2. Restore generated bindings from exact sourceff3e160d (matching retained preview); verify they have no unexplained differences. Reconstruct original core from retained Brotli parts with streamed hash/size checks against build checksum; never invoke optimizer. Current restore_optimizer_input helper explicitly accepts only unoptimized input, so do not misuse it by falsifying metadata; make separate verified asset restoration helper if necessary.
3. Rebuild frontend twice from identical source/dependencies/tool settings with only VITE_RUBRC_RA_SINGLE_PROJECT_INIT0/1 varying. Same core/cache/rust-src assets and metadata provenance in both arms. Flag must be actually present in compiled bundle and exercised cache/sysroot-first.
4. Same-host A-B-B-A cold/reload measurement. Start timing at navigation and finish only after current-document completion and deliberate diagnostic probe succeed. Record actual ready state separately; do not subtract download/compile time or move work outside timer. Record configuration notifications, workspace fetch and graph transitions if available. Reject changed output/input identities.
5. Cargo unchanged-code plus repeated behavioral timing is still required. Use visible command invocation→actual expected output and exit status, not Rust-only internal timers. Initial build/run and repeated/edit rebuild separately. Compare deployed public baseline where identifiable by assets, as well as experimental off/on to isolate change. No release acceptance claim from tests alone.

Hosted retained-preview control reached ready; instrumented diagnostic produced partial host-call coverage (HOST-CALL-FINDINGS.md). No improvement performance outcome yet. Independent-memory redesign remains deferred.

Preparation2026-11-27: local git worktree creation failed on corrupt pack; untouched original repository, independent remote shallow clone succeeded at target/startup-js-boundary-20261126/clean-source. Fetch offf3e160d and diff of bindings/lib/package/lockfile showed no difference from2635f7fe. Restored optimized core to new target path with SHA/decoded-size checks using restore_verified_preview_core.mjs; hard-linked only to absent core path in clean clone. Shared existing node_modules via new symlink, not package changes. Off frontend build running job bash-ab29c093d1e74ff7; all logs durable. Build success and output identity still to verify. Local build is disposable prep, hosted acceptance remains required.
