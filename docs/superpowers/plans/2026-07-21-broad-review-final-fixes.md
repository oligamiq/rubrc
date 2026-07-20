# Broad Review Final Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all broad-review correctness, safety, cancellation, and cache-integrity findings for rust source diagnostics.

**Architecture:** Preserve the existing two-channel readiness protocol and host queue protocol. Add narrow helpers for wasm32 pointer decoding, archive path validation, extraction error propagation, abort-aware parsing, and digest-bound cache metadata; serialize the existing guest protocol with one global mutex.

**Tech Stack:** Rust, WASI component ABI, TypeScript, Deno, Bun/Vite.

## Global Constraints

- Keep generated `wit-bindgen` `paramCount` output unchanged.
- Do not change external toolchains, shims, or readiness channels.
- Do not touch or stage `deno.lock`, `package-lock.json`, `crates/vfs/expanded.rs`, or `diff.patch`.
- Use failing regression tests before each production change.

---

### Task 1: Wasm32 Pointer Bit Patterns

**Files:**
- Modify: `crates/vfs/src/lib.rs`
- Test: `crates/vfs/src/lib.rs` module `lsp_cargo_result_tests`

**Interfaces:**
- Produces: one helper converting signed ABI pointers with `(ptr as u32) as usize`.
- Consumes: `LspResultAllocator::free` and existing cargo-result cleanup paths.

- [ ] Add a regression allocating at `0x8000_0000`, encoding to negative `i32`, decoding, freeing, and reusing the allocation.
- [ ] Run `RUSTFLAGS='-C link-arg=-Wl,--unresolved-symbols=ignore-all' cargo test -p vfs lsp_cargo_result_tests` and verify the new test fails because the signed cast does not identify the allocation.
- [ ] Route `host_free_memory` and cargo-result failure cleanup through zero-extending pointer decoding.
- [ ] Re-run the focused test and verify all allocator/ABI tests pass.

### Task 2: Safe Serialized Guest Extraction

**Files:**
- Modify: `crates/vfs-shell/src/main.rs`

**Interfaces:**
- Produces: a defensive relative-path validator, a fallible extraction helper, and one process-global `Mutex<()>` held across `sysroot_start_fetch` through the final queue read/write.
- Consumes: the existing host protocol and `RUST_SRC_CORE` sentinel check.

- [ ] Add tests rejecting `/absolute`, `..`, `../escape`, and `nested/../../escape`; add tests proving invalid UTF-8, directory creation failure, and file write failure return errors.
- [ ] Add a concurrency test proving two protocol closures cannot overlap while using the shared lock.
- [ ] Run focused `vfs-shell` tests and verify failures identify missing validation/error propagation/serialization.
- [ ] Implement the helpers, replace ignored filesystem/decode errors with `Result` propagation, and hold the lock around the complete transaction.
- [ ] Re-run focused extraction tests and the rust source bootstrap test.

### Task 3: Production Archive Validation And Abort

**Files:**
- Modify: `page/src/sysroot_archive.ts`
- Modify: `page/src/sysroot_archive_test.ts`

**Interfaces:**
- Produces: validated normalized relative entry names and parsing that observes the operation abort signal both in stream flow and entry callbacks.
- Consumes: the existing `loadSysrootArchive` return value and timeout `AbortController`.

- [ ] Add tests rejecting absolute, parent, and nested escape entries before they are returned.
- [ ] Add a cached-stream parse test that times out and proves visitor/stream work stops before consuming the complete archive.
- [ ] Run `deno test --no-lock page/src/sysroot_archive_test.ts` and verify RED failures.
- [ ] Validate each entry before queueing and pass an abort-aware stream to `parse`, checking the signal in each callback.
- [ ] Re-run archive and readiness Deno tests to GREEN.

### Task 4: Digest-Bound Atomic Cache Publication

**Files:**
- Modify: `scripts/sysroot_cache.ts`
- Modify: `scripts/sysroot_cache_test.ts`
- Modify: `scripts/vfs_lsp_diagnostics_test.ts`

**Interfaces:**
- Produces: SHA-256 archive digests, sidecar metadata containing exact toolchain identity plus digest, cache-pair validation, and invocation-unique temporary paths with cleanup.
- Consumes: existing deterministic rust-src generation and generic archive cache dependencies.

- [ ] Add tests rejecting a sidecar whose digest does not match exact archive bytes and proving separate cache invocations use distinct temporary paths.
- [ ] Update generic-cache expected calls to require unique temporary publication and cleanup.
- [ ] Run `deno test --no-lock scripts/sysroot_cache_test.ts` and verify RED failures.
- [ ] Implement metadata/digest helpers, make generic temporary paths unique, and clean temporary files in `finally`.
- [ ] Update the live diagnostics fixture to validate both metadata fields, generate unique archive/sidecar temporaries, publish by rename, and clean leftovers.
- [ ] Re-run cache tests to GREEN.

### Task 5: Full Verification And Report

**Files:**
- Create: `/home/oligami/projects/rubrc/.git/worktrees/rust-analyzer-diagnostics/sdd/final-fix-report.md`

**Interfaces:**
- Produces: reproducible RED/GREEN evidence, commit IDs, command outcomes, and residual concerns.

- [ ] Run Rust formatting and focused ABI/allocator/extraction/bootstrap tests.
- [ ] Run Deno archive/cache/readiness tests.
- [ ] Run `bun run vfs:build` and verify generated `paramCount` remains unchanged.
- [ ] Run `deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts` with complete rust source.
- [ ] Run corrected page build `bun run --cwd page build`.
- [ ] Inspect `git status`, `git diff --check`, generated-file diffs, and prohibited paths.
- [ ] Write the final report and commit only intended repository files.
