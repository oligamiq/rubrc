# Browser rust-std Analysis Design

## Context

The WebShell already installs a complete `rust-src` tree at
`/sysroot/lib/rustlib/src/rust/library` and a compiled target sysroot at
`/sysroot/lib/rustlib/<target>/lib`. rust-analyzer still cannot provide useful
standard-library analysis because the linked project overrides normal sysroot
discovery with a synthetic crate graph containing only
`core/src/unit.rs`. The workspace crate has no standard-library dependencies,
and startup readiness only requires `rubrc-main` and `core` graph nodes.

The artifact pipeline also does not prove that `rust-src` and the compiled
sysroot came from the same Rust commit. The local rust-src cache records only
the host toolchain used to create it, target sysroot archives carry no identity
metadata, and browser startup checks archive structure rather than provenance.
The currently cached rust-src and the known target-sysroot build provenance are
from different Rust commits.

## Requirements

- rust-analyzer provides completion, definition navigation, and diagnostics for
  APIs in `core`, `alloc`, and `std`.
- `rust-src`, the embedded rustc, and every compiled target sysroot used by the
  WebShell come from one exact 40-character Rust commit hash.
- A missing, malformed, stale, or mismatched artifact fails before project
  activation.
- The staged startup order remains unchanged: lightweight analyzer startup,
  sysroot installation, project activation, then semantic readiness.
- `cachePriming.enable` remains false. Correctness and acceptable cold-start
  behavior must not depend on a persistent rust-analyzer semantic cache.

## Toolchain Bundle

The artifact producer publishes rustc, rust-src, and target sysroots as one
immutable toolchain bundle. A versioned manifest is the authority for their
identity:

```json
{
  "schema": 1,
  "rustcCommit": "<40 lowercase hex characters>",
  "rustcWasmSha256": "<64 lowercase hex characters>",
  "archives": {
    "rust-src": {
      "url": "<immutable URL>",
      "sha256": "<decompressed tar SHA-256>"
    },
    "wasm32-wasip1": {
      "url": "<immutable URL>",
      "sha256": "<decompressed tar SHA-256>"
    }
  }
}
```

The producer creates every manifest entry from the same explicitly checked-out
Rust commit. In particular, rust-src is copied from that checkout or from a
rust-src component whose companion rustc reports the exact manifest commit. It
must not be generated from the deploy machine's arbitrary active toolchain.
The producer verifies the embedded rustc verbose version, records the raw Wasm
digest, hashes each decompressed tar stream, and publishes artifacts under
immutable, content-addressed URLs. Updating files behind an existing URL is not
permitted.

Rubrc pins one bundle manifest. Its build fails unless the checked-in
`crates/vfs/rustc_opt.wasm` digest matches `rustcWasmSha256`. The same validated
manifest is copied into the page assets; production must not discard identity
metadata while copying rust-src.

## Browser Validation

Startup parses and validates the manifest before starting archive prefetch.
The selected rust-src and target entries therefore share the manifest's single
`rustcCommit` by construction. Unknown schemas, malformed commit hashes,
unsupported targets, duplicate URLs, or malformed digests are rejected.

`SysrootArchiveStore` fetches each immutable URL and computes the SHA-256 of the
decompressed tar bytes before exposing them to the VFS. Network responses are
not promoted into trusted CacheStorage until this check passes; a mismatched
cached response is evicted. A digest mismatch is rejected before in-memory
archive publication, rust-src workspace population, or guest installation.
CacheStorage keys include the expected digest, so an archive from an older
bundle cannot satisfy a newer request. Existing tar path and required-entry
validation remains defense in depth.

Any identity or digest failure moves the relevant sysroot load to `failed`.
`StartupCoordinator` reports the concrete failure while still in
`sysroots-loading`; it does not send full linked-project configuration or open
the Rust document.

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

The immutable archive URLs and CacheStorage avoid repeated network transfer.
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

- manifest schema, exact commit syntax, target lookup, and immutable URLs;
- producer rejection when rustc, rust-src, or a target archive has a different
  commit or digest;
- Rubrc build rejection when the embedded rustc Wasm digest differs;
- CacheStorage isolation by archive digest;
- browser archive rejection before publication or VFS installation on a
  digest mismatch;
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
- Silently accepting legacy target archives that lack verifiable provenance.
