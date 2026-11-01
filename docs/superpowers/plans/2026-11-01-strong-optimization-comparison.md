# Strong-Optimization Lock Comparison

**Goal:** Re-evaluate the old/new lock under explicit high-speed optimization,
instead of treating the previous O1 experiment as a production-speed baseline.

The user requested this correction after reviewing the earlier result. Continue
inline using the existing paired-run infrastructure; no new approval checkpoint
is needed for this evaluation correction. Heavy compilation/profiling remains
on hosted CI. Mobile work and public deployment remain outside the task.

## Audit findings

- Analyzer Rust compilation was forced to `opt-level=2`, codegen-units=1, without
  cross-crate fat LTO. Its standalone WASM did receive Binaryen O3.
- VFS and shell used Cargo's release defaults, not explicit fat LTO / one CGU.
- WVL `--dev` skipped its per-module/merge optimizer stages.
- WVL's normal optimizer defaults to **Oz**, not speed O4, and can discard a
  successful optimization solely because its output is larger.
- Final combined core received only O1.
- LLVM/rustc/Cargo inputs are checked-in prebuilt WASM. Their original source
  compiler/LTO flags are not recorded by this repository. Do not infer them from
  `_opt` filenames or claim to have rebuilt these guests from source.

The earlier 48.9% post-sysroot reduction remains an **O1-configuration result**.
It is not evidence of the same gain under the strongest ordinary presets.

## Initial attempted profile: `strong-speed-v1` (rejected)

- Rebuilt analyzer, VFS and shell: Cargo release opt-level **3**, LTO **fat**,
  codegen-units **1**, with the existing target/unwind semantics.
- Analyzer standalone optimization: **O4**.
- Every WVL optimizer stage: **O4**, no `--dev`/`--no-opt` bypass, retaining the
  produced output even if it is larger. Preserve reactor no-inline protection.
- Final combined core: **O4**. Never silently downgrade to O1.
- No fast-math/trap-elision/closed-world assumptions. Do not enable unsupported
  GC/shared-everything transformations merely to enable optimization.
- Fixed prebuilt guest input hashes, reoptimized through WVL's O4 stages.
- No shell `debug-log` feature in this speed comparison.
- Both variants retain the same 512 MiB initial heap, worker counts, source
  tuple, cache generation path and readiness criteria.

This specifies the highest ordinary Rust/Binaryen speed levels used here. It
does not claim an absolute optimum across all pass combinations or unknown
prebuilt-source compiler settings.

## Work and verification

### WVL policy and strong translation gate

- [x] Add `WVL_OPTIMIZATION_PROFILE=speed-o4` to the pinned CLI source. Keep the
  historical size policy when unset. Require native wasm-opt for speed mode.
- [x] Test policy selection, larger-output acceptance, O4 arguments and retention
  of special pass arguments. Run standalone native tests before heavy builds.
- [x] Run the generated relocation gate with Rust O3/fat LTO/one CGU and WVL O4.
  Run `41289330167` passed at `3c9c6940380aa2bf5e02b24796e734ebdbdeded2`.
  The previously approved non-threaded diagnostic exception stays explicit.

### App build profile and evidence

- [ ] Build the native CLI from that exact source revision, then install observer
  wrappers. The native tool itself need not use the delivered WASM profile.
- [ ] Record actual rustc arguments/results for the final analyzer/VFS/shell
  compilations, and every actual wasm-opt invocation. Preserve Cargo jobserver
  descriptors in the rustc wrapper by invoking rustc directly from a shell.
- [ ] Verify effective final `-C` values, successful statuses, analyzer/final O4
  stages, at least seven WVL optimizer invocations and accepted-output records.
- [ ] Package the profile and checksummed evidence only after verification.
  Reject missing, weaker or mixed profiles before measuring.
- [ ] Verify identical analyzer and prebuilt guest inputs across both modes,
  distinct core binaries, and archive/core/cache checksums.

### Hosted execution

- [ ] Run both coherent builds sequentially with the existing 64 GiB swap setup.
  Raise job budget to 330 minutes and final-optimizer emergency deadline to 180
  minutes for this profile. Save resource heartbeats covering all build stages.
- [ ] Run fresh-browser A–B–B–A on one runner with unchanged startup/editor checks.
- [ ] Independently verify raw results, profile evidence and artifacts. Report
  the strong-profile result separately, including inconclusive/regressed results.

## Measured tool limitation and compatible ceiling

Run `41336108089`, source `8b89871425cfe300877a58a9af21e050ca9ad11c`, did not
produce a measurement. Actual analyzer rustc arguments confirm O3, fat LTO and
one CGU, and compilation succeeded in 6m49s. Binaryen 131 then aborted during
standalone analyzer O4 after about 9.9 seconds:

```text
unexpected expr type
UNREACHABLE executed at /src/src/passes/Flatten.cpp:231!
```

This is not an optimizer-memory failure. Flatten explicitly lacks TryTable
support, which is needed for the analyzer's new-EH unwinding. Latest release 133
has the exact same `src/passes/Flatten.cpp` Git blob as 131:
`10c791f609eb0c9b6f38a4999b6aefc04f4c6e18`.

The revised explicit profile is **`strong-compatible-v1`**:

- Rust O3/fat LTO/one CGU stays unchanged.
- Standalone analyzer and final combined core use O3 because they require new EH.
- WVL inspects each input module **before execution**. Inputs with TryTable use
  O3; inputs without it use O4. The selected level and `hasTryTable` are recorded.
- There is no error-triggered downgrade. A failure of the selected level fails
  the build; O1 is never substituted.
- The audit matches actual WVL optimizer argument lists to accepted-output
  records and rejects an unnecessary O3 selection for a module without TryTable.
- Add a minimal imported-call/exported-tag EH fixture: forced O4 must reproduce
  the pinned tool limitation, while the compatible O3 result must validate.

WVL revision `f5825e94cea867cef8305bf7aea4e8d9c9f49d66` implements this policy.
Gate `41361615856` passed, including the real EH fixture: forced O4 reproduced
the failure, selected O3 validated, and the accepted-output record explicitly
reported `hasTryTable=true`. The native policy tests and threaded relocation/
reset checks also passed under the revised policy.
The previously failed uniform-O4 attempt remains recorded and must not be
described as a successful all-O4 build. Logs are saved under
`/tmp/opencode/strong-build-baseline-41336108089/`.

Sources: <https://github.com/WebAssembly/binaryen/blob/version_131/src/passes/Flatten.cpp>
and <https://github.com/WebAssembly/binaryen/blob/version_133/src/passes/Flatten.cpp>.

Configuration provenance references: Cargo profile documentation
<https://doc.rust-lang.org/cargo/reference/profiles.html>, Binaryen's optimizer
options and the pinned 131 executable. The local system wasm-opt is version 120
and is not used for this experiment's compilation or acceptance.
