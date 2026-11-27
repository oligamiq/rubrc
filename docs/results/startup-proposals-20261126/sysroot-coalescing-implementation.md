# Limited opt-in sysroot transfer coalescing implementation

Date: 2026-11-27 (Asia/Tokyo). Objective: implement and natively validate the bounded 64 KiB proposal in the [boundary audit](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/sysroot-boundary-audit.md>), without JS/generated-code edits, deployment, commit/push, full Wasm rebuild, or destructive Git operations.

## Result and scope

**Implemented, default off; native correctness tests pass in both modes. Not a performance or browser-integration acceptance result.**

Production edits only:

- [Cargo.toml](</home/oligami/projects/rubrc/crates/vfs-shell/Cargo.toml>): adds `sysroot-read-coalescing = []`, not included in a default feature. For a package-selected build use `--features sysroot-read-coalescing`; workspace orchestration may use the namespaced `vfs-shell/sysroot-read-coalescing` feature. Merely enabling a frontend flag does not enable this Rust feature.
- [sysroot_extraction.rs:8–87](</home/oligami/projects/rubrc/crates/vfs-shell/src/sysroot_extraction.rs#L8-L87>): feature-gated fixed 64 KiB heap buffer; at most one synchronous refill per nonempty logical read, at most 64 KiB per refill. No archive-sized buffer, background work, growing queue, or alternate import. Large consumer requests may now return a legal short read of at most 64 KiB. The existing 512 KiB ceiling remains.
- [main.rs:603–648](</home/oligami/projects/rubrc/crates/vfs-shell/src/main.rs#L603-L648>): **feature ON only**, elapsed/speed calculation is inside the existing progress-print branch. Feature OFF keeps the original per-callback sampling to enable matched combined-patch A/B. Progress thresholds, exact-final-byte condition, zero-time guard, formatting and flush remain unchanged. [Final speed/duration sampling](</home/oligami/projects/rubrc/crates/vfs-shell/src/main.rs#L686-L702>) is unchanged. The ON sample happens a few instructions later; displayed speed is not bit-identical. This is a combined coalescing + clock-relocation candidate, not a coalescing-only timing comparison.

The isolated [native harness manifest](</home/oligami/projects/rubrc/verification/sysroot-coalescing-native/Cargo.toml>) declares its own workspace to avoid application/Wasm dependencies. Its [library source](</home/oligami/projects/rubrc/verification/sysroot-coalescing-native/lib.rs>) includes the actual production extraction module by path, including existing unit tests. New tests live in [tests.rs](</home/oligami/projects/rubrc/verification/sysroot-coalescing-native/tests.rs>). The [lockfile](</home/oligami/projects/rubrc/verification/sysroot-coalescing-native/Cargo.lock>) pins tar 0.4.46 and three transitive crates; this new isolated dependency lockfile is the only newly generated harness metadata. Existing generated application/JS/Wasm artifacts were not modified by this task.

## Reader invariants and observable semantics

- `remaining` means **not delivered**, not not fetched. Cached bytes are `cache_end - cache_start`; unfetched bytes are `remaining - cached`. Refill is allowed only with an empty cache, where `remaining` equals unfetched bytes. Thus successful paths preserve `delivered + cached + unfetched = archive_len` without a redundant independent counter.
- The fixed boxed slice is allocated only with the feature enabled (including for an empty stream), never resized, and freed by ordinary drop. This is 64 KiB of extra retained shell buffer per reader, not an end-to-end memory claim. Existing wrapper buffers, JS serialization temporaries/archive cache, and rust-src mount accumulation remain.
- Empty destination and true delivery EOF return zero before any cancellation probe or host callback. Every other `read` checks the existing cancellation predicate/message/error kind **before serving cached bytes**, including when the entire remaining archive is already cached.
- Cancellation occurring inside a synchronous host callback cannot preempt it. That read may return bytes; cancellation is observed on the next nonempty, non-EOF read. If all bytes have already been delivered, the existing EOF semantics permit success. This change does not add a final commit cancellation check or a wall-clock cancellation latency guarantee.
- Each refill goes through the existing callback exactly once. Cached delivery does not call the wrapper again. Host cursor/mount append order is preserved; host transfer progress and read-complete events may occur up to one cache ahead of consumer delivery. These remain **transfer**, not extraction/mount-readiness, events.
- A failing callback does not publish cache indices or decrement `remaining`. Caller paths stop on error and do not introduce retries. There is no remote rollback guarantee: the host might have advanced before failing. The reader is not made into a generally retryable transport; a manually retried call after an error is not promised safe.
- Tar extraction itself is unchanged: `archive.into_inner()` returns the same cache-owning reader, and the existing post-tar drain consumes prefetched and unfetched trailing bytes. The complete-load mutex is unchanged.
- [rust-src sink/drain, exact-length check, abort, and finish ordering](</home/oligami/projects/rubrc/crates/vfs-shell/src/main.rs#L651-L681>) remain unchanged. It is not safe to remove the sink read: the wrapper appends mount input as a side effect. Finish remains after full consumer delivery, not after the final refill.

## Environment and provenance

[Environment log](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/sysroot-coalescing-native/environment.log>): x86_64 Linux; rustc 1.98.1 (48a229cea 2026-09-01), cargo 1.98.1 (797e8a9bc 2026-08-05). HEAD metadata reported `2635f7fee35a6139ca4d4188d00a7222bb926c9f`; this is not a clean-tree or hosted-artifact identity assertion. Working tree already contained unrelated tracked and untracked edits, including generated frontend/Wasm artifacts and parent-agent scripts/evidence. They were left alone. No checkout, worktree, reset, pack repair, or full Git history/diff traversal was attempted; only `git status --short` and `git rev-parse HEAD` were used.

Exact candidate/harness source identities are retained in [source-sha256.log](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/sysroot-coalescing-native/source-sha256.log>). The actual source and harness remain at the linked repository paths. Tests do not substitute a copied implementation.

## Reproduction commands

Run from `/home/oligami/projects/rubrc`. Offline mode requires the lockfile's four crates in the local Cargo cache; those were already available here. Explicit native target avoids any Wasm target assumption.

```sh
pwd
git status --short
git rev-parse HEAD
mkdir -p docs/results/startup-proposals-20261126/sysroot-coalescing-native
set -o pipefail
{
  date --iso-8601=seconds
  rustc --version
  cargo --version
  uname -a
  git rev-parse HEAD
} | tee docs/results/startup-proposals-20261126/sysroot-coalescing-native/environment.log

# Initial run (before fixing the test fixture described below):
cargo test --offline --manifest-path verification/sysroot-coalescing-native/Cargo.toml --target x86_64-unknown-linux-gnu --no-default-features 2>&1 | tee docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-off.log
# Exit 101; ON command was gated on OFF success and therefore did not run.

# After correcting the fixture and strengthening true-EOF cancellation:
cargo test --offline --manifest-path verification/sysroot-coalescing-native/Cargo.toml --target x86_64-unknown-linux-gnu --no-default-features 2>&1 | tee docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-off-final.log
cargo test --offline --manifest-path verification/sysroot-coalescing-native/Cargo.toml --target x86_64-unknown-linux-gnu --no-default-features --features sysroot-read-coalescing 2>&1 | tee docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-on-final.log

# Final source: add explicit 1 MiB count case, format only new harness tests.
rustfmt --edition 2024 verification/sysroot-coalescing-native/tests.rs
cargo test --offline --locked --manifest-path verification/sysroot-coalescing-native/Cargo.toml --target x86_64-unknown-linux-gnu --no-default-features 2>&1 | tee docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-off-locked.log
cargo test --offline --locked --manifest-path verification/sysroot-coalescing-native/Cargo.toml --target x86_64-unknown-linux-gnu --no-default-features --features sysroot-read-coalescing 2>&1 | tee docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-on-locked.log

sha256sum crates/vfs-shell/src/sysroot_extraction.rs crates/vfs-shell/src/main.rs crates/vfs-shell/Cargo.toml verification/sysroot-coalescing-native/Cargo.toml verification/sysroot-coalescing-native/Cargo.lock verification/sysroot-coalescing-native/lib.rs verification/sysroot-coalescing-native/tests.rs | tee docs/results/startup-proposals-20261126/sysroot-coalescing-native/source-sha256.log
git status --short -- crates/vfs-shell verification/sysroot-coalescing-native docs/results/startup-proposals-20261126/sysroot-coalescing-native
```

Actual paired test invocations captured `PIPESTATUS[0]` after OFF and exited on failure before running ON. All final tests and fingerprint/status commands exited 0. No timing significance is assigned to unit-test runner durations.

## Observed test results

| Mode | Final native result | Raw log |
|---|---|---|
| Feature OFF | **23 passed, 0 failed**; 0 doctests | [OFF locked log](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-off-locked.log>) |
| Feature ON | **24 passed, 0 failed**; 0 doctests | [ON locked log](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-on-locked.log>) |

Coverage:

1. Deterministic patterned source lengths `0, 1, B-1, B, B+1, 2B, 2B+17, 9B+13, 1MiB`, with `B = 65536`; each with fixed consumer reads `1, 512, 8192, B, 512KiB+19` and mixed reads `[1,511,7,8192,B+7,3,512KiB+19]`. Byte equality, append-spy equality/order, callback sum N, no zero requests, existing maximum request bound. Feature ON additionally asserts **each exact refill length** and exact **ceil(N/B)** callback count, including zero for N=0 and 16 for 1 MiB. This is deterministic correctness, not a startup speed measurement.
2. Empty reads before and between reads; repeated true EOF; exact cancellation-probe counts; no extra callbacks after EOF (length sum and exact count include EOF probes).
3. Cancellation before first fetch, with remaining unfetched bytes, with final tail fully cached, during a callback, and before last refill. No output modification or callback after observed cancellation. True-EOF behavior after cancellation inside the final callback is preserved.
4. First/second/third callback failure in `io::copy`: error kind and message preserved, attempts separate from successful bytes, no failed bytes exposed with coalescing, no automatic retry. First/later extraction failures also stop without retry.
5. Full tar fixture with directory, empty file, small file, large patterned file crossing multiple refill boundaries, standard terminators, and over 64 KiB of extra trailing bytes. Exact file contents/totals and complete declared drain, with refill counts based on the entire stream including trailing bytes.
6. Declared tar file payload truncation and short-host-source failure; unsupported symlink type and file-creation failure. Existing production unit tests cover unsafe entry paths, invalid metadata/name lengths, filesystem errors and serialized loads.
7. Feature ON additionally cancels inside a final refill of an empty tar with trailing bytes: tar terminates, but the same reader's drain sees cancellation instead of falsely succeeding on the final cache.

### Initial test failure, preserved rather than hidden

The [initial OFF log](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-off.log>) records 22 passing and one failing test (exit 101). The original fixture cut the tar at 2048 bytes, **exactly between complete entries**, and incorrectly expected a rejection. Existing tar behavior permits EOF there, returning two complete files / three bytes, even without terminator blocks. No production change was made to tighten tar validation. The fixture was corrected to 2660 bytes, inside the declared large-file payload; this tests actual payload truncation while preserving existing semantics. A separate overreported-host-length case checks propagation of `UnexpectedEof`. Subsequent [OFF rerun](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-off-final.log>) and [ON rerun](</home/oligami/projects/rubrc/docs/results/startup-proposals-20261126/sysroot-coalescing-native/feature-on-final.log>) passed, followed by the final locked runs above.

## Limitations / parent integration handoff

- Native tests compile the **actual reader/extractor**, not the heavyweight shell entrypoint, JS import, VFS wrapper, or SquashFS mount. The append spy demonstrates callback ordering/once-only delivery but is **not** a real mount/cleanup/readiness test. Real rust-src known-file verification and interrupted mount lifecycle remain integration requirements.
- The shell import returns `void`; its closure returns `Ok(())` only after a normal host return. JS short/long replies, missing active archive, exceptions or Wasm traps are not proven to become Rust `io::Error`, and may bypass Rust abort/cleanup. Native injected callback errors do **not** establish trap cleanup or retry safety. No claim of catching all JS traps or rollback of partially extracted files is made.
- Main progress changes were reviewed by source/data-flow inspection, not compiled in this lightweight harness and not clock-instrumented in a browser. Need a normal targeted shell build in the parent CI before artifact acceptance, then real integration checks. Final time-reporting and mount code were left untouched.
- No JS edits, generated application edits, full Wasm build, frontend build, deployment, commit, push, or hosted A/B was performed by this task. Parent owns frontend/CI comparison; ensure both core artifacts share all other feature/build/cache/memory settings and explicitly enable the Rust feature only for ON.
- ON deliberately changes transfer granularity, progress sampling timing, temporary allocation size, and host-ahead-of-consumer distance. Larger synchronous callbacks may have different latency/serialization/GC behavior. Memory/latency and repeated matched cold/warm startup outcomes remain unmeasured.
- **No speedup follows from fewer callbacks alone.** Do not extrapolate the previous hosted sampled timing sums or divide its call count by a guessed factor. Adoption remains opt-in pending real integration and performance evidence.
