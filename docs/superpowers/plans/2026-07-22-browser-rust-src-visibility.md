# Browser Rust-Source Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the validated browser rust-src tree visible at `/sysroot/lib/rustlib/src/rust/library/core/src/lib.rs` to both the bootstrap shell and spawned rust-analyzer so browser diagnostics publish Monaco markers.

**Architecture:** Add temporary build-gated probes at supported filesystem boundaries, compare the exact browser path and `/rust-project.json` bytes with the GREEN Deno integration, and identify the first divergent boundary. Capture that divergence in a focused failing test, apply one minimal rubrc-owned filesystem fix, remove temporary probes, then run browser and complete Task 7 verification.

**Tech Stack:** TypeScript, Deno tests, `@bjorn3/browser_wasi_shim`, Vite build gating, Puppeteer, rust-analyzer LSP.

## Global Constraints

- Preserve spawned-thread LSP routing and same-origin generated rust-src assets.
- Preserve explicit GREEN-equivalent rust-analyzer initialization options.
- Preserve `MonacoLanguageClient` marker ownership; do not write markers directly.
- Do not inspect private Wasm memory, poll Atomics, or re-enter Rust from a Rust-invoked JS callback.
- Do not stage or commit `deno.lock`, `crates/vfs/expanded.rs`, `diff.patch`, or generated `page/dist/rust-src.tar.vfsbr`.
- Change one behavioral variable after identifying the first divergent boundary.

---

### Task 1: Capture Three-Boundary Evidence

**Files:**
- Modify temporarily: `page/src/lsp_test_api.ts`
- Modify temporarily: `page/src/xterm.tsx`
- Modify temporarily: `page/src/App.tsx`
- Modify temporarily: `scripts/lsp_browser_diagnostics_test.mjs`
- Compare: `scripts/vfs_lsp_diagnostics_test.ts`

**Interfaces:**
- Consumes: `VfsReadyResult`, the browser preopen `Map<string, Inode>`, validated `SysrootArchiveEntry[]`, and the build-gated `window.__rubrcLspTest` object.
- Produces: browser evidence for the archive entry, shell bootstrap exact-path result, Web-side VFS exact-path result, `/rust-project.json` UTF-8 bytes, and rust-analyzer's inbound workspace error.

- [ ] **Step 1: Add a build-gated synchronous probe registered by `xterm.tsx`**

The probe must traverse only the public `Directory`/`File` objects backing the browser preopen, read the exact core path and `/rust-project.json`, and record archive entry name and size. It must not call Rust.

- [ ] **Step 2: Invoke the probe after `{ ok: true }` bootstrap readiness and before `LspStartGate.setVfsResult` starts the client**

Record shell evidence from the readiness state that validates the exact core path, then invoke the Web-side probe synchronously.

- [ ] **Step 3: Extend browser failure output with the boundary evidence**

Run:

```text
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome bun run test:lsp-browser
```

Expected: RED marker timeout with explicit archive, shell, Web-side VFS, project JSON, and inbound LSP evidence.

- [ ] **Step 4: Compare with Deno GREEN**

Run:

```text
deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts
```

Expected: `rust-analyzer published and cleared diagnostics` and 2,791 served rust-src entries. Confirm its archive normalized name and project bytes from the source setup.

### Task 2: Add the Focused Regression and Minimal Fix

**Files:**
- Create or modify: one focused helper under `page/src/`
- Create or modify: its adjacent `*_test.ts`
- Modify minimally: `page/src/xterm.tsx`

**Interfaces:**
- Consumes: validated relative archive entry names and `Uint8Array` contents.
- Produces: the exact Web-side VFS tree required by spawned embedded modules, if Task 1 proves that boundary differs.

- [ ] **Step 1: State one hypothesis from the first divergent boundary**

Do not edit production behavior until the archive, shell, Web-side VFS, and LSP observations identify the first mismatch.

- [ ] **Step 2: Write one failing regression**

The test must traverse the same supported in-memory filesystem representation used by child modules and assert that `core/src/lib.rs` resolves beneath `/sysroot/lib/rustlib/src/rust/library` with exact bytes.

- [ ] **Step 3: Verify RED**

Run the focused Deno test and confirm it fails because the exact path is absent at the identified boundary.

- [ ] **Step 4: Implement the smallest rubrc fix**

Populate or share only the missing filesystem boundary using validated archive entries. Do not alter LSP routing, marker handling, initialization options, archive URLs, or unrelated lifecycle timing.

- [ ] **Step 5: Verify focused GREEN**

Run the focused test and its neighboring archive/readiness tests.

### Task 3: Remove Diagnostics and Verify Task 7

**Files:**
- Remove temporary changes from: `page/src/lsp_test_api.ts`
- Remove temporary changes from: `page/src/App.tsx`
- Remove temporary changes from: `scripts/lsp_browser_diagnostics_test.mjs`
- Retain only required production changes in: `page/src/xterm.tsx` and the focused helper/test
- Update: `/home/oligami/projects/rubrc/.git/worktrees/rust-analyzer-diagnostics/sdd/task-7-report.md`

**Interfaces:**
- Consumes: focused GREEN filesystem behavior.
- Produces: browser marker acceptance and final Task 7 evidence.

- [ ] **Step 1: Remove temporary boundary probes**

Keep the permanent build-gated acceptance API minimal and verify the production bundle does not expose it.

- [ ] **Step 2: Run browser acceptance**

```text
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome bun run test:lsp-browser
```

Expected: `browser displayed and cleared rust-analyzer markers`.

- [ ] **Step 3: Run complete Task 7 verification if browser acceptance is GREEN**

Run all focused Deno suites, the direct embedded diagnostics integration, production build, formatter check, generated-bundle test-hook search, and `git diff --check`.

- [ ] **Step 4: Run adversarial pre-merge review**

Review all intended Task 7 changes for correctness, routing regressions, generated artifacts, and protected-file staging.

- [ ] **Step 5: Update the Task 7 report and commit only intended files if all required checks pass**

Inspect `git status`, `git diff`, and recent log; exclude protected/generated files; create one concise repository-style commit without amending.
