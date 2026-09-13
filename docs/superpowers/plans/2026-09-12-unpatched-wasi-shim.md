# Unpatched WASI Shim Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans to execute the approved migration.

**Goal:** Remove the complete local WASI thread-shim patch and use upstream
0.5.0.

**Architecture:** Consume upstream async lifecycle completion through the
existing utility/lifecycle state machines. Keep one teardown promise per adopted
runtime; use existing runtime deadlines for quarantine. No replacement patch or
private runtime protocol implementation.

**Tech Stack:** Bun, Deno, Vite, TypeScript, browser Workers.

## Global Constraints

Follow `../specs/2026-09-12-unpatched-wasi-shim-design.md`, including
preservation of dirty work, no commits, no VFS rebuilds, and unchanged
memory/port constraints.

## Task 1: Unpatched Installation

Files: root/page/lib/generated-worker package.json and tracked lockfiles;
`scripts/browser_wasi_shim_patch_test.ts` and
`scripts/browser_wasi_shim_patch_durability_test.ts`.

- [x] Rename tests to installation tests; require exact 0.5.0 in each manifest,
      no shim patchedDependencies entry, and no local shim patch file.
- [x] Run the new tests against 0.4.1 and observe expected failures.
- [x] Change exact manifest versions to `"0.5.0"`, remove patch registrations,
      delete the old patch, and install in both roots using Bun.
- [x] Update tracked dependency snapshots without discarding unrelated entries.
- [x] Verify a copied binding directory installs the same upstream distribution
      using its frozen lockfile, with no patch directory available.

## Task 2: Async Completion

Files: `page/src/runtime_worker_protocol.ts`, its tests, and package lifecycle
behavior tests/worker fixtures in `scripts/browser_wasi_shim_*`.

- [x] Add deferred-success, deferred-failure, duplicate-token, and pre-adoption
      rollback tests that fail when `destroyed`/`fatal` is emitted prematurely.
- [x] Replace the lifecycle destroyer interface with
      `async_destroy(): Promise<void>` and memoize the completion result:

```ts
destroyOutcome ??= Promise.resolve().then(() => destroyer!.async_destroy())
  .then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, message: toErrorMessage(error) }),
  );
const outcome = await destroyOutcome;
```

- [x] Await `animal?.async_destroy()` in pre-adoption rollback; retain error
      aggregation and ownership rules.
- [x] Update mocks and obsolete source-shape tests without changing unrelated
      Farm teardown calls. Verify public handles by structured-cloning real
      handles, not manually inventing lifecycle-buffer layouts.
- [x] Remove fixtures that rewrite node_modules or monkey-patch private classes.

## Task 3: Verification and Review

- [x] Run
      `deno test --no-lock -A page/src/runtime_worker_protocol_test.ts page/src/app_runtime_test.ts`
      and `bun test page/src/production_runtime_test.ts` with their respective
      runners.
- [x] Run installation/durability tests with their required file/process grants
      and `bun test` on package public-behavior tests.
- [x] Run `bun run --cwd page build` and real browser lifecycle checks on an
      ephemeral port.
- [x] Confirm both installation roots are unmodified upstream 0.5.0; ensure no
      active manifest/lock references the removed patch.
- [x] Review lifecycle races. Report any upstream blocker rather than adding a
      substitute patch. Leave work uncommitted and the original stash intact.

## Verification Results

- Deno: 134 tests passed across runtime protocol, runtime lifecycle,
  installation, installation durability, coordinator failure, and published-file
  comparison.
- Bun: 115 tests passed across production runtime, public clone behavior, and
  the published allocator/base-call/worker suites.
- Chromium: three repeated owner generations, concurrent clone teardown, and
  coordinator bootstrap rejection passed through public APIs.
- Both installed package trees match every file in the npm 0.5.0 tarball; the
  tarball's SHA-512 matches registry metadata.
- Page build and scoped whitespace checks passed.

The initial Bun-hosted coordinator failure fixture did not settle. The
equivalent fixture passes under Deno and Chromium, so the failure test uses
Deno. This host difference remains a limitation, not a reason to reintroduce a
patch. No claim is made that Bun's failing nested-worker path was fixed.

The existing full LSP acceptance timeout after its first std-completion edit was
not repaired or retested as part of this package migration. The new browser test
isolates package lifecycle behavior without changing that acceptance test.

Independent final review was requested but unavailable due reviewer quota. The
production lifecycle change was self-reviewed against deferred/duplicate/
rejected completion and existing quarantine tests.
