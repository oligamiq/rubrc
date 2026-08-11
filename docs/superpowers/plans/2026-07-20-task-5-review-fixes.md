# Task 5 Review Fixes Implementation Plan

> **Superseded allocator design:** The CAS-before-reservation/rollback design in
> this historical document was superseded by commit `dd1ee901`. Rollback could
> expose logical ranges without physical backing. See the worktree SDD ledger at
> `.git/worktrees/rust-analyzer-diagnostics/sdd/task-5-report.md` for the final
> reserve-before-CAS reasoning.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all four Task 5 review findings with complete rust-src coverage, supported shim initialization, deterministic validated toolchain caching, and leak-free target-memory contention accounting.

**Architecture:** Claim target logical pages before physical reservation so CAS losers allocate nothing. Move rust-src identity, structural validation, and deterministic tar arguments into testable cache helpers; the integration fixture uses those helpers, serves every archive entry, and delegates thread memory plus LSP input copying to supported shim APIs.

**Tech Stack:** Rust, Deno TypeScript, WASI, `@oligami/browser_wasi_shim-threads`, rust-analyzer LSP, GNU tar, Brotli streams.

## Global Constraints

- Do not modify `deno.lock`, `package-lock.json`, or `crates/vfs/expanded.rs`.
- Do not use direct `Atomics`, `SharedArrayBuffer`, shared-memory construction, or private memory offsets in the diagnostics worker.
- Serve every entry in the validated rust-src archive.
- Preserve separate Rust accounting and Task 5 fixture commits.
- Delete only `diff.txt`, `diff2.txt`, and `new_diff.txt` from the untracked review artifacts.

---

### Task 1: Contention-Safe LSP Result Reservation

**Files:**
- Modify: `crates/vfs/src/lib.rs`
- Test: `crates/vfs/src/lib.rs`

**Interfaces:**
- Produces: `claim_lsp_result_pages(pages, logical_size, reserve, compare_exchange) -> Result<i32, String>`.
- Consumes: target logical-size getter, physical reservation function, and logical-size CAS.

- [ ] **Step 1: Write failing accounting tests**

Add tests proving a first CAS loss followed by a win calls physical reservation exactly once, a failed reservation rolls back the logical claim, and a failed rollback after later target growth adopts existing physical capacity.

- [ ] **Step 2: Run RED**

Run:

```bash
RUSTFLAGS='-C link-arg=-Wl,--unresolved-symbols=ignore-all' cargo test -p vfs lsp_cargo_result_tests
```

Expected: compilation fails because `claim_lsp_result_pages` does not exist.

- [ ] **Step 3: Implement CAS-before-reservation**

Implement this ordering:

```rust
loop {
    let next = current.checked_add(pages).ok_or_else(|| "LSP result memory size overflowed".to_string())?;
    let observed = compare_exchange(current, next);
    if observed != current {
        current = observed;
        continue;
    }
    if reserve(pages) > 0 {
        return Ok(current);
    }
    let rollback = compare_exchange(next, current);
    if rollback == next {
        return Err("failed to reserve LSP result memory".to_string());
    }
    if rollback > next {
        return Ok(current);
    }
    return Err("LSP result memory accounting moved backwards".to_string());
}
```

Use the helper from `reserve_lsp_result_region`; compute the byte pointer only after a successful claim.

- [ ] **Step 4: Run GREEN and format**

Run the focused test command and `cargo fmt --check --package vfs`.

- [ ] **Step 5: Commit**

Stage only `crates/vfs/src/lib.rs` and commit with `fix(vfs): account for LSP result reservation contention`.

### Task 2: Deterministic Validated Rust-Source Cache

**Files:**
- Modify: `scripts/sysroot_cache.ts`
- Modify: `scripts/sysroot_cache_test.ts`
- Modify: `scripts/vfs_lsp_diagnostics_test.ts`

**Interfaces:**
- Produces: `rustSrcToolchainIdentity(rustcVersion, sysroot) -> string`.
- Produces: `deterministicRustSrcTarArgs(libraryPath) -> string[]`.
- Produces: `validateRustSrcArchive(archive, listEntries?) -> Promise<boolean>`.

- [ ] **Step 1: Write failing cache tests**

Add tests for exact identity sensitivity, deterministic tar flags/order, missing `core/src/lib.rs`, `alloc/src/lib.rs`, or `std/src/lib.rs`, and unsafe archive paths. Inject an entry-list function so unit tests remain compatible with `deno test --allow-read`.

- [ ] **Step 2: Run RED**

Run `deno test --allow-read scripts/sysroot_cache_test.ts`.

Expected: type checking fails because the new helpers are not exported.

- [ ] **Step 3: Implement helpers and fallback reuse**

Normalize archive paths with `validateTarEntryName`, require all three standard-library crate roots, and generate identity JSON containing schema version, trimmed `rustc -vV`, and resolved sysroot. Generate tar arguments with sorted names, epoch mtime, numeric owner/group zero, stable permissions, and deleted atime/ctime PAX fields.

In the integration fixture, reuse the local archive only when the sidecar identity matches and archive validation succeeds. Otherwise regenerate it from the installed toolchain, validate generated bytes, rename archive first, then rename identity so partial updates cannot create a false cache hit.

- [ ] **Step 4: Run GREEN**

Run `deno test --allow-read scripts/sysroot_cache_test.ts` and verify all cache tests pass.

### Task 3: Complete Archive And Supported Worker APIs

**Files:**
- Modify: `scripts/vfs_lsp_diagnostics_test.ts`
- Modify: `scripts/vfs_lsp_diagnostics_worker.ts`
- Delete: `diff.txt`
- Delete: `diff2.txt`
- Delete: `new_diff.txt`

**Interfaces:**
- Consumes: shim-managed `WASIFarmAnimal.get_share_memory()` and `dispatchSpecialInput`.
- Preserves: async sysroot host callback protocol and existing `MessageChannel` output forwarding.

- [ ] **Step 1: Remove the archive filter**

Store an immutable template for every parsed directory or file and clone all templates for each `rust-src` fetch.

- [ ] **Step 2: Remove direct memory dependencies**

Omit `share_memory` from the `WASIFarmAnimal` constructor. Pass the shim-owned map from `get_share_memory()` to `custom_instantiate`. Replace private offset writes with `root.dispatch(0, 1, 100, 100)`. Replace manual buffer copying in `send` with `dispatchSpecialInput(root, animal.get_share_memory().memory, { sessionId: LSP_SESSION_ID, data: encodeLspMessage(message) })` and fail if it returns false.

- [ ] **Step 3: Delete only requested artifacts**

Delete `diff.txt`, `diff2.txt`, and `new_diff.txt`; leave lockfiles and `crates/vfs/expanded.rs` untouched.

- [ ] **Step 4: Run integration and formatting**

Run `bun run vfs:build`, then `deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts`, then scoped Deno formatting and `git diff --check`.

- [ ] **Step 5: Commit**

Stage only the cache and diagnostics scripts plus the three deletions, then commit with `test(lsp): cover complete deterministic rust source`.

### Task 4: Report And Final Verification

**Files:**
- Modify outside worktree: `/home/oligami/projects/rubrc/.git/worktrees/rust-analyzer-diagnostics/sdd/task-5-report.md`

- [ ] **Step 1: Run complete verification**

Run the focused VFS tests, cache tests, `bun run vfs:build`, full diagnostics integration, Rust and Deno format checks, and `git diff --check`.

- [ ] **Step 2: Append exact evidence**

Append commands, pass counts, integration success text, commit hashes, full-archive entry evidence, shim-managed memory explanation, and any remaining concerns to the Task 5 report.

- [ ] **Step 3: Confirm scope**

Verify status retains only pre-existing lockfile and generated-file changes, then return the requested conforming status and concise evidence summary.
