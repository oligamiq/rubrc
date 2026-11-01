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

## Concrete profile: `strong-speed-v1`

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

Configuration provenance references: Cargo profile documentation
<https://doc.rust-lang.org/cargo/reference/profiles.html>, Binaryen's optimizer
options and the pinned 131 executable. The local system wasm-opt is version 120
and is not used for this experiment's compilation or acceptance.
