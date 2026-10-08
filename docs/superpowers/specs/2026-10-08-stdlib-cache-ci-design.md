# Standard-library cache CI validation

## Approved scope

Commit and push the relevant source changes to `ci/stdlib-cache-validation` in
`oligamiq/rubrc` and `oligamiq/rust-analyzer`. Run validation on GitHub-hosted Linux.
The user approved these operations and requested attention to usage costs.

## Execution

One workflow in rubrc checks out both repositories as siblings, pinning the
analyzer to the full commit SHA in `.github/stdlib-cache-analyzer-revision`.
The first job runs targeted native, transfer, startup and copy-integrity tests.
Only if those pass does a second job build the analyzer WASM, build VFS, generate
the cache using that exact WASM, prepare the browser assets and run three matched
cold/cache trials. The experimental ItemTree feature stays disabled for timing.

Use the existing `--dev` VFS build route for this diagnostic validation; this
avoids the separate, expensive production optimization pass. This result is a
comparison within this configuration, not a production-build speed claim.

## Resource and publication limits

- Standard `ubuntu-24.04` runners on these public repositories.
- No matrix, larger runners, deployment, Pages updates or upstream PRs.
- Checks: 45 minutes maximum. Build/browser: 90 minutes maximum.
- Two Cargo build jobs; no incremental compiler state transferred from local builds.
- Cancel superseded runs of this same workflow on the same branch.
- Upload logs and source/tool/artifact hashes only, retained for one day.
- No generated WASM, large build-directory cache, personal host diagnostic records
  or unrelated temporary files in the new commits/artifacts.
- The analyzer snapshot commit uses `[skip ci]` to avoid its unrelated all-push
  coverage workflow; the rubrc validation workflow tests the pinned analyzer source.

## Failure handling and results

Every build/validation command must propagate failures. Always retain available
logs. Record renderer crashes distinctly and bound diagnostic collection so a
crashed renderer cannot hang the test driver. A downloaded cache is insufficient:
cached trials must report successful load/merge; cold trials must not use the cache.
Do not drop failed trials or substitute older binaries. Native success alone does
not establish WASM correctness. Report the run URL, tool versions and trial results.

## Toolchain

Pin Rust nightly to `nightly-2026-09-13`, with `rust-src` and the threaded WASI target;
pin WVL CLI to `0.10.0` (matching the library), wasm-tools to `1.252.0`, and Binaryen to `version_131`.
Use Bun for package management and the project's Deno scripts for WASI execution.
Verify downloaded binary distributions against their published SHA-256 values.
Preserve existing startup ordering: this work does not parallelize restoration or
sysroot preparation.

## Self-review

Both repositories are public and writable. The rubrc production workflows only
run on develop; Pages requires a separate dispatch. The fork's coverage workflow
is the only unrelated all-push workflow identified. The approved dedicated branch
and source-pin arrangement therefore avoid the existing long production jobs.
