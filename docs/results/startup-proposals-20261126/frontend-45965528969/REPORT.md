# All-arm Cargo observations: no completion in either mode

Executed2026-11-27, retrieved2026-11-28JST. Run https://github.com/oligamiq/rubrc/actions/runs/45965528969 at751ffa20d17c11724380a2721f18b48fee2980fe. Chrome150.0.7871.24, Ubuntu24.04 hosted, independent OFF/ON/ON/OFF browsers; identical reconstructed core/adapter/cache/settings except single-init frontend flag. Each browser completed cold+second-navigation editor checks before Cargo. No Rust coalescing code in this retained Wasm.

| Session | Flag | Initial Cargo observation | Last guest state |
|---|---|---|---|
|0|OFF|no marker/prompt within180s|cargo27/rustc31,stderr117bytes,wait=cargo-main|
|1|ON|no marker/prompt within180s|same|
|2|ON|no marker/prompt within180s|same|
|3|OFF|no marker/prompt within180s|same|

All4real Compile and Run clicks recorded, same model/page/target/generation, run→idle dispatch acknowledged. Terminal snapshot shows command echo but never program marker or returned prompt; no exit code. Each timed-out browser closed before independent next session. Result correctly FAIL, allArmsObserved=true, allWorkloadsObserved=false. No unchanged/edit rebuild attempted after failed initial compile.180s is censoring/timeout, NOT completed duration; equality of timeout bounds does NOT establish non-regression.

Raw result/screenshots/console available in frontend-measurements/; concise summary.json and last-guest-snapshots.json. End state reproduced across all four arms supports a common unfinished guest-operation path; it does not prove root cause, deadlock, public-version behavior, or absence of regression. Next diagnostic should inspect rustc31 pending stderr117bytes and cargo-main wait/stdio/lock progress with independent reproducer. Do not claim public benchmark pass.

Editor checks all8passed but45.096–53.923s end-to-end, again none<=30s. New ON cold45.834/45.096s; ON second navigation45.884/48.039s. Treat separately from previous45962666995 rather than pooling opportunistically. Second navigation not proven warm-cache state. No public deployment. Both experiments remain defaultOFF.
