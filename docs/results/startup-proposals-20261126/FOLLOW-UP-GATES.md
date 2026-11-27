# Gates before enabling these experiments

This investigation does not authorize publication or independent-memory redesign. Do not treat failure/timeout as a passing performance result.

## Single-project initialization
- Keep VITE_RUBRC_RA_SINGLE_PROJECT_INIT unset/defaultOFF. Existing8visit measurement validates UI behavior but not stable speed gain; all exceed30s.
- Instrument actual project/config/workspace graph events in a diagnostic arm to establish whether intended second graph load is eliminated; existing source-based reasoning is not a graph-count measurement.
- Repeat same-source matched browser/hardware and defined cold/cache policy; second navigation was labelled reload but cache warmth not verified. Record sample size/dispersion and all failures, not only mean.

## Sysroot read coalescing
- Keep vfs-shell/sysroot-read-coalescing disabled. It combines64KiB coalescing AND progress-clock sampling; separate arms if attributing benefit.
- Build both full mergedWVL components with identical pinned toolchain/optimizer/features except this feature. Verify actual generated adapter/memory configuration, source/cache identity. Small synthetic Wasm fixture is insufficient for production channels/mount effects.
- Exercise both rust-src mount and target tar archives, boundaries/cancellation/failure, repeated attempts and cleanup under JS import trap. Reader io::Error is not a production void-import trap model. Verify no duplicate/missing mounted bytes and bounded incremental64KiB heap (whole mount still retains archive).
- Measure startup bridge call counts/length histograms plus uninstrumented page→actual completion/diagnostics. Do not estimate wall savings by multiplying9inclusive samples.

## Cargo and release
- Diagnose unfinished initial compile in featureOFF browser snapshot cargo27/rustc31/stderr117bytes before any non-regression claim. Current APIs acknowledge dispatch early, so runtime idle cannot establish command done.
- Record exact successful command completion/exit status through a supported test-only observation channel if current prompt/marker is insufficient; never expose unsupported private internals or source-text marker as stdout.
- Identify public asset baseline and compare same target/workload/browser/cache conditions. No invented tolerance. A-B-B-A experimental frontend is not public baseline.
- User release gate is navigation→working completion+diagnostics<=30s AND Cargo not slower. Both need evidence. Current disposition is NO RELEASE.
