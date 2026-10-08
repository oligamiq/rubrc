# Standard-library Cache CI Implementation Plan

> Execute inline using the executing-plans workflow. No parallel agent implementation.

**Goal:** Validate the current stdlib cache and WASM parker fixes on a clean hosted runner.

**Architecture:** A source-pinned sibling checkout and two dependent Linux jobs.
Targeted checks gate a fresh WASM/cache build and three browser comparison pairs.

**Tech Stack:** GitHub Actions, Rust nightly, Bun, Deno, Node/Puppeteer, WVL and Binaryen.

## Global constraints

- Follow the approved design in `docs/superpowers/specs/2026-10-08-stdlib-cache-ci-design.md`.
- Only `oligamiq/rubrc` and `oligamiq/rust-analyzer`; no upstream or deployment changes.
- Standard `ubuntu-24.04`; 45-minute check job and 90-minute build job; one-day logs.
- No new startup parallelism, JS Atomics/SharedArrayBuffer, WIT lists or Rust reentry.
- Exclude generated binaries, host-specific diagnostic documents, `_tmp_*` and `patch.diff`.

## Task 1: Source snapshots and workflow

**Files:**
- Add `.github/stdlib-cache-analyzer-revision` containing the actual analyzer commit SHA.
- Add `.github/workflows/stdlib-cache-ci.yml` for sibling checkout and gated jobs.
- Add `scripts/ci/stdlib_cache.sh` for reproducible stage commands.

- [ ] Inspect source diffs and staged file lists; commit the analyzer source/tests with
  an AI disclosure and `[skip ci]` to suppress the unrelated coverage job.
- [ ] Write its full `git rev-parse HEAD` output to the revision file.
- [ ] Configure checkout paths `rubrc` and `rust-analyzer`, validate the revision with
  `[[ "$revision" =~ ^[0-9a-f]{40}$ ]]`, and use it in `actions/checkout`.
- [ ] Configure workflow push trigger only for `ci/stdlib-cache-validation`,
  `permissions: { contents: read }`, and branch-scoped cancel-in-progress concurrency.
- [ ] Install the pinned toolchain, runtime dependencies and checksum-verified tools.
  Use a Cargo shim for internal `cargo +nightly` invocations to select the pinned date.
- [ ] Make every stage fail on command errors (`set -euo pipefail`); upload logs with
  `if: always()` and `retention-days: 1`.

## Task 2: Targeted checks

Run in the analyzer checkout:

```sh
cargo test --locked -p parking_lot_core --lib
cargo test --locked -p ide-db -p rust-analyzer --lib semantic_cache
cargo test --locked -p ide-db --lib semantic_cache --features cache-item-trees,cache-codec-bench
```

Run in rubrc:

```sh
cargo test --locked -p vfs --lib
deno test --no-lock --allow-read --allow-env page/src/stdlib_cache_test.ts page/src/worker_process/lsp_dispatch_test.ts page/src/startup_coordinator_test.ts page/src/workspace_sync_test.ts
node --test scripts/copy_vfs_bindings_test.mjs scripts/finalize_vfs_asset_test.mjs
```

- [ ] All selected tests must pass before the next job is eligible.
- [ ] Check optional-feature persistence tests without enabling those features in the timing build.

## Task 3: Fresh artifact and browser validation

Run in rubrc after dependency/tool setup:

```sh
RUSTFLAGS='-Copt-level=2 -Ccodegen-units=1' bun run lsp:build
wasi_virt_layer build -p vfs crates/vfs/llvm_opt.wasm crates/vfs/rustc_opt.wasm crates/vfs/lsp_opt.wasm crates/vfs/cargo_opt.wasm vfs-shell --features debug-log --dev --own-memory --vfs-unwind --validate
wasm-tools validate --features all dist/vfs.core.wasm
node scripts/copy_vfs_bindings.mjs
bun install --cwd page/src/worker_process/vfs_bindings
bun run std-cache:generate target/std.salsa
VITE_RUBRC_LSP_TEST=1 VITE_RUBRC_STD_CACHE_COMPARE=1 bun run --cwd page build
VFS_BROTLI_QUALITY=1 bun run vfs:prepare:prod
bun run rust-src:prepare-asset
bun run std-cache:prepare-asset target/std.salsa page/dist
RUBRC_STDLIB_RUNS=3 RUBRC_STDLIB_TIMEOUT_MS=360000 node scripts/stdlib_cache_browser_test.mjs
```

- [ ] Add a small tested helper for renderer-failure racing/bounded diagnostics to
  `scripts/stdlib_cache_browser_test.mjs`, so crashes cannot masquerade as endless waits.
- [ ] Assert cache load/merge on cached trials and report all attempted trial outcomes.
- [ ] Record SHA-256 for the analyzer, generated VFS and cache plus source SHAs/tool versions.
- [ ] Upload only diagnostic logs/hashes, not the hundreds-of-MB WASM or build trees.

## Task 4: Validate, publish and observe

- [ ] Run small local script tests and YAML/shell checks only; hosted execution provides
  the clean build validation. Review the precise staged diff and exclusions.
- [ ] Push analyzer source first, then push the rubrc source/workflow snapshot.
- [ ] Use `gh run list/view --repo oligamiq/rubrc` to observe the single run.
- [ ] If a job fails, inspect that job's logs before changing anything or retrying.
  No blind rerun loop. Report run URL and completed/blocked acceptance criteria.

## Execution notes

- Analyzer snapshot: `07e8d30e340e504655ebace245a8df17f7f91fbf`.
- Initial run `37728733895` stopped during checkout, before compilation. The existing
  `test_repo` gitlink has no `.gitmodules` mapping; checkout's credential cleanup
  traversed it and failed. Fetch the public rubrc repository directly by the validated
  triggering SHA, without submodule traversal or stored credentials. Preserve the
  existing gitlink; this CI change does not modify that unrelated repository content.

## Self-review

The plan preserves the sibling paths required by existing scripts, avoids locally
generated artifacts, and gates expensive work on focused checks. Timing uses one
build and no audit. The three-run count is fixed rather than an expanding matrix.
