# Unpatched WASI Shim 0.5.0

## Objective

Use the unmodified npm distribution of
`@oligami/browser_wasi_shim-threads@0.5.0` in all four installation manifests.
Delete the local patch and both patch registrations. Do not replace the patch
with edits to node_modules, private-field shims, or runtime monkey patches.

## Lifecycle Contract

`destroy()` in 0.5.0 initiates teardown; it is not a completion barrier. The
lifecycle worker must await the public `async_destroy()` before acknowledging
`destroyed`. Duplicate requests share one in-flight operation and receive their
own correlated result. Failure must remain failure, and a hung operation must
continue to trigger the existing runtime deadline/quarantine path.

Before lifecycle adoption, utility-worker rollback awaits
Animal.async_destroy(). After adoption, only the lifecycle owner initiates
teardown. Existing generation validation, startup ordering, and primary-error
preservation remain intact.

Upstream completion means logical teardown and issued worker termination, not a
physical browser thread join. Do not claim a stronger guarantee. If existing
runtime safety cannot be retained through public APIs, report the failing case
and request an upstream fix instead of restoring a patch.

## Dependency and Test Scope

Update root, page, lib, and generated-worker manifests and their tracked
lockfiles. Keep the existing Vite exclusions and dev cache guard; dependency
optimization is not part of this migration. Replace patch-existence tests with
unpatched-version and installation-durability tests. Replace old manually
constructed lifecycle buffers and private coordinator fixtures with public API
behavioral tests.

## Constraints

- Preserve all pre-existing uncommitted work and the retained stash.
- Do not commit, stage, push, or rebuild VFS as part of implementation.
- Do not modify generated thread_spawn.ts, allocator sizes, or memory limits.
- Keep the 64 MiB base-call allocator, 8192-page RA reserve, and 32775-page
  maximum.
- Do not use ports 3000 or 4173 for verification; use 4174 or an ephemeral port.
- Add no application-level Atomics or SharedArrayBuffer code.

## Verification

Require regression tests for delayed, duplicate, failed, and hung async
teardown; structured-clone public handles; allocator behavior; clean package
installation after binding copies; runtime disposal and quarantine; and a page
build. Exercise real browser lifecycle behavior using the shipped package
without modifying it. The pre-existing post-ready LSP diagnostics timeout is a
separate baseline limitation and must not be hidden by weakening assertions.
