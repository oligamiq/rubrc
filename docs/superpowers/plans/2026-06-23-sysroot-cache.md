# Sysroot Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rustc debug harness clear its local expanded sysroot, reuse a
cached compressed sysroot archive when present, and download/cache the archive
when absent.

**Architecture:** Add a focused Deno helper for sysroot cache preparation, then
call it from `scripts/test_rustc_inspect.ts`. The helper owns cache paths,
workspace cleanup, download, and extraction; the debug harness remains
responsible for VFS setup and command execution.

**Tech Stack:** Deno scripts, browser-compatible
`DecompressionStream("brotli")`, existing `lib/src/parse_tar.ts` tar parser.

## Global Constraints

- Do not add new `Atomics` or `SharedArrayBuffer` usage.
- Do not call Rust functions from JavaScript functions invoked by Rust.
- Keep the change focused on the rustc debug sysroot setup.
- Cache files must be ignored by git.

---

### Task 1: Sysroot Cache Helper

**Files:**

- Create: `scripts/sysroot_cache.ts`
- Create: `scripts/sysroot_cache_test.ts`
- Modify: `.gitignore`

**Interfaces:**

- Produces:
  `sysrootCachePaths(options?: Partial<SysrootCacheOptions>): SysrootCachePaths`
- Produces:
  `prepareCachedSysroot(options?: Partial<SysrootCacheOptions>): Promise<SysrootCacheResult>`

- [ ] **Step 1: Write failing tests**

Create tests for path calculation and cache-vs-download behavior using
dependency injection for file operations and fetch.

- [ ] **Step 2: Run RED**

Run: `deno test --no-lock -A scripts/sysroot_cache_test.ts` Expected: type-check
failure because `scripts/sysroot_cache.ts` does not exist.

- [ ] **Step 3: Implement helper**

Implement the smallest Deno helper that deletes the expanded sysroot, ensures
`.rubrc-cache/sysroot`, uses cached `.tar.br` if present, otherwise fetches and
writes it, then extracts it into `test_workspace_rustc/sysroot`.

- [ ] **Step 4: Run GREEN**

Run: `deno test --no-lock -A scripts/sysroot_cache_test.ts` Expected: all tests
pass.

### Task 2: Connect Debug Harness

**Files:**

- Modify: `scripts/test_rustc_inspect.ts`
- Test: `scripts/sysroot_cache_test.ts`

**Interfaces:**

- Consumes: `prepareCachedSysroot()` from Task 1.

- [ ] **Step 1: Replace native rustc sysroot copy**

Remove `rustc --print sysroot` and `cp -R` logic. Call
`await prepareCachedSysroot()` before `buildPreopenDirectory`.

- [ ] **Step 2: Verify**

Run:
`deno test --no-lock -A scripts/sysroot_cache_test.ts scripts/vfs_debug_config_test.ts`
Expected: all tests pass.

Run:
`VFS_DEBUG_TIMEOUT_MS=60000 deno run --no-lock -A scripts/test_rustc_inspect.ts`
Expected: the script reports whether it used cache or downloaded sysroot, then
emits run 1/2 and run 2/2 debug markers.

- [ ] **Step 3: Commit**

Commit the sysroot cache change separately from the existing checkpoint commit.
