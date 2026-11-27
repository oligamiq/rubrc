# Cargo baseline run stalls before observed completion

Run45964491888 at5ff404d6,2026-11-27. FeatureOFF cold+second navigation editor checks pass. Fresh empty prompt established. Actual Compile and Run click invokes cargo run --target wasm32-wasip1.180s later no expected program marker, no returned prompt and no successful exit code: failed observation, not a benchmark duration.

Terminal raw evidence records echoed command only after click. Runtime run→idle occurs but only acknowledges dispatch. Console independently shows cargo:enter id27, rustc entry id28 and later repeated snapshot cargo27/rustc31/stderr117bytes/wait=cargo-main through end. This supports an actual unfinished guest operation, not merely missing DOM prompt capture. It does NOT identify lock/stdio root cause, nor prove introduced regression or deadlock. Published baseline not compared. FeatureON was not run due early abort; cannot attribute stall to single-init change (it was OFF) or new coalescing (absent from retained Wasm).

Next scoped measurement retains a failed Cargo arm, closes its browser to terminate guest, then measures remaining independentON/ON/OFF arms. Final process remains fail if any Cargo observation fails. This yields comparative evidence without marking failures successes or repeatedly rerunning identical baseline only.

Independent review found separate whitespace normalization bug allowing earlier prompt before indented marker. No markers were observed here, so this run is unaffected. Parent fixed marker-position normalization and added regression test;13tests pass pending rerun log.
