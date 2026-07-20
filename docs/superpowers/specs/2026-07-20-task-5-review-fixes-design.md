# Task 5 Review Fixes Design

## Scope

Resolve the four Task 5 review findings without changing lockfiles, generated
`crates/vfs/expanded.rs`, external toolchains, or shim packages. Remove only the
three agent-created untracked diff files named by the user.

## Rust-Source Fixture

The parent fixture will parse every entry from the cached rust-src archive and
clone immutable templates into the active host queue. The worker will continue
using an explicit bounded project graph and disabled cache priming so serving
the complete production source tree does not turn the lifecycle assertion into
an unrelated indexing benchmark.

## Supported Worker Initialization

The diagnostics worker will omit the optional `share_memory` constructor option
and let `WASIFarmAnimal` create thread memory internally. It will retrieve the
shim-managed memory map only for component instantiation. LSP input will use
the existing `dispatchSpecialInput` helper rather than directly writing the
memory buffer. Terminal geometry will use scalar `root.dispatch` event 1. The
script will contain no `Atomics`, `SharedArrayBuffer`, shared-memory constructor,
or private byte offsets.

## Deterministic Cache

Installed-toolchain fallback archives will be reusable only when all conditions
hold:

- The identity sidecar exactly matches `rustc -vV` plus the resolved sysroot.
- Archive parsing succeeds.
- The archive contains the required `core`, `alloc`, and `std` crate roots.
- Every entry path passes traversal validation.

Fallback creation will invoke GNU tar with name sorting and fixed metadata,
then Brotli-compress the deterministic tar bytes. Archive and identity files
will be installed via temporary files and rename. Focused tests will cover
identity mismatch, missing required entries, unsafe entries, and deterministic
tar arguments through injected dependencies.

## Target-Memory Accounting

Result-region growth will first atomically claim the logical target range. Only
the CAS winner may request physical pages. A CAS loser retries at the observed
logical end without reserving pages. If physical reservation fails, the winner
attempts to roll back its logical claim. A failed rollback means another target
growth has already adopted the claimed logical boundary; that can occur only
when existing physical capacity covers the range, so the claim remains usable.

A pure injected accounting helper will make contention and reserve-failure
paths testable on native targets. Tests will prove CAS losers reserve nothing,
successful rollback reports failure, and adopted claims remain successful.

## Verification And Commits

Run focused VFS ABI tests, sysroot cache tests, Rust and TypeScript formatting,
the production VFS build, complete rust-src diagnostics integration, and
`git diff --check`. Commit the Rust accounting fix separately from the Task 5
cache/fixture fix. Append exact commands, results, and commit hashes to the Task
5 report.
