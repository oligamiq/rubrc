# Standard-library cache: hosted CI result

## Validated source and run

- [Successful run 38110216260](https://github.com/oligamiq/rubrc/actions/runs/38110216260), 2026-10-11.
- rubrc: `2ed89dd40feb6710874f209b425c84e36472c0b9`.
- rust-analyzer: `07e8d30e340e504655ebace245a8df17f7f91fbf`.
- Branch in both repositories: `ci/stdlib-cache-validation`.
- Runner: standard GitHub-hosted `ubuntu-24.04`; no deployment performed.

The checks and WASM/browser jobs both passed. The analyzer and VFS were rebuilt
on the runner, and the cache was generated and restoration-validated using the
same bundled WASM analyzer used by the browser. No local generated binaries were
substituted. The final WASM parker notification/lifetime fix is included.

## Browser startup results

Fresh browser per trial, three pairs, cold then cached in each pair. Both modes
used the same sysroot-first ordering (`VITE_RUBRC_STD_CACHE_COMPARE=1`), initial
program and build. Audit was disabled. All six trials reached `ready` and exposed
the standard-library crate graph. Each cached trial reported download, load and
merge with `moved_source_root_files=0`; cold trials did not use the cache.

| Trial | Cold (s) | Cached (s) | Paired saving (s) |
| --- | ---: | ---: | ---: |
| 1 | 184.231 | 179.960 | 4.272 |
| 2 | 181.742 | 152.308 | 29.433 |
| 3 | 167.230 | 152.688 | 14.542 |
| Median of each mode | **181.742** | **152.688** | **29.054 difference of medians** |

The difference of mode medians is **15.986%** of the cold median. Each individual
pair was also faster with the cache; the median *paired* saving is 14.542 seconds.
These are descriptive results from three trials, not a statistical guarantee.
The fixed run order and shared runner/network conditions can affect timings.

| Cached trial | Validation (ms) | Decode (ms) | Activation (ms) | LSP linear-memory peak (bytes) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 943 | 9524 | 54 | 259260416 |
| 2 | 927 | 9217 | 38 | 251658240 |
| 3 | 914 | 9270 | 42 | 251199488 |

Cold LSP linear-memory peaks were 260767744, 263520256 and 262537216 bytes.
These values are not total browser memory. `image_validation=true` in all cached
trials. Decode remains approximately 9.2–9.5 seconds and is a meaningful remaining
cost. This run checked load/merge and startup, not audit-mode recomputation counts.

### Configuration

- Chrome `150.0.7871.24`, Node `22.22.1`, Bun `1.4.2`, Deno `2.9.7`.
- Rust `nightly-2026-09-13`, rustc `809936eac` / LLVM `23.1.1`.
- WVL CLI/library `0.10.0`, wasm-tools `1.252.0`, Binaryen `131`.
- Analyzer flags: `-Copt-level=2 -Ccodegen-units=1`, plus the build script's
  panic-unwind/exception-handling flags and rebuilt standard library.
- VFS: `--features debug-log --dev --own-memory --vfs-unwind --validate`.
- ItemTree persistence and codec benchmark features disabled for timing.
- Brotli quality `1` for local CI serving.

The diagnostic VFS build omits the expensive final production optimization pass.
These results should not be relabeled as production-build performance. No startup,
restoration or sysroot-preparation parallelization was introduced for this work.

## Tests

200 executed regression cases passed, including feature-configuration variants:

| Suite | Passed |
| --- | ---: |
| Patched parking-lot core, including four WASM fallback regressions | 16 |
| ide-db semantic cache (default) | 5 |
| Server semantic cache | 5 |
| ide-db semantic cache (ItemTree + codec features) | 8 |
| VFS | 124 |
| Web transfer, cache, startup and synchronization | 34 |
| Node copy/asset integrity and browser failure handling | 8 |

No timeout or renderer crash occurred in the successful run's six browser trials.
This establishes the recorded configuration's result, not universal absence of
startup failures on every machine or browser.

## Artifact identity

Cache envelope: 34,545,184 bytes, two distribution parts.

```text
375388644c5f4395a3e1e9917b7f10a3f04a6e5031b37619222f4e599f310d5d  analyzer WASM
a45661f98c386cb2e7a709a3cd4249669ff090e3e504d6885482ed4bee9d1e5b  generated VFS core
a45661f98c386cb2e7a709a3cd4249669ff090e3e504d6885482ed4bee9d1e5b  bindings VFS core
895ee39876e200183939430dd2cd0da82406512369c5e14c66d129470c2d66ad  std.salsa
```

The Web asset finalizer also verified its canonical VFS hash. Only diagnostic
logs, the small generated JS adapter and hashes were uploaded, not WASM payloads.

## Resource usage

- Successful run: checks 3m37s; WASM/browser job 32m58s; **36m35s total job time**.
- All five setup/validation attempts: approximately **92.3 runner-minutes**, summing
  job elapsed times (not a billing-rounding calculation).
- Standard hosted Linux runners on public repositories: runner execution is free
  under GitHub's public-repository policy. No larger or paid runner was selected.
- Successful run's uploaded artifacts: **107,461 bytes total**, retained for one day.
  GitHub's ordinary workflow-log retention is separate.
- No broad matrix, automatic retry loop or large build-directory cache was used.
  The analyzer fork's unrelated full coverage workflow was intentionally suppressed;
  this workflow tested its pinned source instead.

Prior attempts stopped on checkout metadata, archive-tool compatibility, published
CLI compatibility and the missing `origin` remote. Each was diagnosed before the
next run. Details and run IDs are in the CI implementation plan. These setup failures
are not included as successful browser trials or mixed into the timing samples.
