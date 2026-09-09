# Browser rust-std Analysis Design

## Context

The WebShell already installs a complete `rust-src` tree at
`/sysroot/lib/rustlib/src/rust/library` and a compiled target sysroot at
`/sysroot/lib/rustlib/<target>/lib`. rust-analyzer still cannot provide useful
standard-library analysis because the linked project overrides normal sysroot
discovery with a synthetic crate graph containing only
`core/src/unit.rs`. The workspace crate has no standard-library dependencies,
and startup readiness only requires `rubrc-main` and `core` graph nodes.

The artifact pipeline currently generates rust-src from the deploy host's
active toolchain, independently of the compiled target sysroot. The currently
cached rust-src and the known target-sysroot build provenance are therefore
from different Rust commits.

## Requirements

- rust-analyzer provides completion, definition navigation, and diagnostics for
  APIs in `core`, `alloc`, and `std`.
- `rust-src` and every compiled target sysroot used by the WebShell are produced
  from the same Rust source checkout.
- A missing or malformed artifact fails before project activation.
- The staged startup order remains unchanged: lightweight analyzer startup,
  sysroot installation, project activation, then semantic readiness.
- `cachePriming.enable` remains false. Correctness and acceptable cold-start
  behavior must not depend on a persistent rust-analyzer semantic cache.

## Artifact Production

The artifact producer packages rust-src and all target sysroots from one
explicit Rust source checkout in the same release workflow. Rust-src must no
longer be generated from the Rubrc deploy machine's active toolchain. Rubrc
fetches rust-src from the same pinned artifact release that supplies
`wasm32-wasip1` and additional target sysroots.

This is a production-pipeline invariant, not a runtime identity protocol. The
design adds no commit manifest, commit-hash comparison, archive SHA-256 check,
or embedded-rustc digest check. The existing archive parsing, safe-path checks,
and required `core`, `alloc`, `std`, and target `libcore` entry checks remain.
A structural failure continues to fail `sysroots-loading` before project
activation.

## rust-analyzer Project Graph

The full linked-project configuration keeps:

- `sysroot: "/sysroot"`
- `sysroot_src: "/sysroot/lib/rustlib/src/rust/library"`
- the `rubrc-main` workspace crate
- disabled build scripts, proc macros, check-on-save, and cache priming

It removes the custom `sysroot_project`. rust-analyzer then uses its supported
sysroot discovery path to identify the available source crates and attach its
public `core`, `alloc`, and `std` dependencies to `rubrc-main`. This avoids
encoding nightly-only internal standard-library dependencies and cfg details in
Rubrc.

The crate-graph readiness barrier requires exact `rubrc-main`, `core`, `alloc`,
and `std` node labels. It remains an attachment barrier rather than a semantic
success check. Document diagnostics and explicit semantic requests run only
after all four nodes are observable.

## Caching And Performance

The versioned archive URLs and CacheStorage avoid repeated network transfer.
The in-memory archive store avoids duplicate fetch and decompression in one
runtime. rust-analyzer's normal process-local query cache accelerates repeated
completion and navigation requests in one session.

No design claim relies on reusing semantic analysis after a page reload.
Enabling cache priming would move more work into startup and increase peak
memory, so it remains disabled. Standard-library analysis stays demand-driven.
The browser acceptance test records phase timing and must complete within the
existing bounded startup and analysis budgets. If cold-start measurements are
unacceptable, optimization is a separate measured change; an incomplete
hand-written sysroot graph is not the fallback.

## Testing

Focused tests cover:

- the artifact workflow packages rust-src from the same checked-out source tree
  and release job as the target sysroots;
- Rubrc production and development asset preparation no longer read rust-src
  from an arbitrary local active toolchain;
- existing archive structure and safe-path validation remains active;
- the exact rust-analyzer configuration shape without `sysroot_project`;
- crate-graph readiness requiring `rubrc-main`, `core`, `alloc`, and `std`.

The real browser test uses a standard-library type that is not available from
the current synthetic core graph. It verifies:

1. completion returns the expected `std` API;
2. go-to-definition resolves to a file below the installed rust-src `std`
   directory;
3. an invalid `std` API produces a versioned diagnostic;
4. replacing it with a valid API clears that diagnostic;
5. startup phase ordering and the no-Cargo-before-activation invariant remain
   intact.

## Non-Goals

- Persisting rust-analyzer semantic state across page reloads.
- Maintaining a Rubrc-owned model of all nightly sysroot crate dependencies.
- Enabling proc macros, build scripts, cache priming, or check-on-save.
- Adding commit-hash, archive-digest, or embedded-rustc identity verification.
