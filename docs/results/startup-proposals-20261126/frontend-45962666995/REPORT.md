# Single-project initialization actual browser comparison

2026-11-27. Successful run https://github.com/oligamiq/rubrc/actions/runs/45962666995 atec5347ea6b225e0a1e19feaa2e8386f6f402a6ee. Ubuntu24.04 hosted runner, Chrome150.0.7871.24, viewport1280x900, navigator hardwareConcurrency4. Same runner sequential OFF/ON/ON/OFF independent browsers; cold then reload each. Local ephemeral static servers, unthrottled network. No deployment. Two independent sessions/arm, not statistically conclusive.

## Inputs

Same exact batching-on core from45131532216, SHA1448142480a5d35519f5eb7048e1a4b684cb94ae3bc31ad09ae6bb276a665d25. Exact generated JS adapter1c054b321970ade528428adfa23ece00d7bfac46d78820a9b63d80078f18fdf4. Imported shared memory initial9203pages/max65536. Identical rust-src,cache parts,tool assets; provenance.json and frontend-pair/identity.json. Only VITE_RUBRC_RA_SINGLE_PROJECT_INIT flag varies between frontend builds. Opt-in used only sysroot-first path; neither arm contains Rust coalescing patch in Wasm.

## Observations

All8 visits reached ready then produced actual std completion candidates and mismatch diagnostic via UI interaction. Saved screenshots/raw result. Navigation→both editor checks complete (includes sequential probe input, screenshot and restoration overhead):

| Mode | Visit | Measurements seconds | Mean seconds |
|---|---|---|---|
| OFF | cold |52.689,48.893|50.791|
| ON | cold |46.197,48.468|47.333|
| OFF | reload |47.157,49.692|48.424|
| ON | reload |44.971,54.572|49.771|

Cold mean -3.458s/-6.8%; reload mean +1.347s/+2.8%. NOT a stable improvement claim: few independent sessions, substantial variation, no confidence interval or preset tolerance. Do not pool with original Chrome157 diagnostic or previous environment results. Startup ready alone ON43.04–52.28s, so probe overhead does not explain missing30s gate. All eight visits exceed30s.

## Decision and outstanding gates

Keep feature defaultOFF; no public update. Actual graph rebuild count avoided has not been instrumented, despite source rationale; successful UI behavior doesn't prove intended eliminated recomputation count. Cargo not run here. Published page baseline not identified.30s requirement unmet in this environment; Cargo non-regression unestablished. Next run adds initial compile/unchanged rerun/edit rebuild after editor checks with marker+returned-prompt witness. Explicit exit0 is not exposed by existing API, preserve this limitation.
