# Development Rust-Source Asset Design

## Goal

Make `bun run --cwd page dev` and `bun run --cwd page start` serve the same
validated `rust-src.tar.vfsbr` asset shape as production, and prevent an HTML
fallback response from poisoning the compressed-asset cache or reaching the
Brotli decoder.

## Root Cause

Production and browser acceptance generate `page/dist/rust-src.tar.vfsbr`
before previewing the built site. Vite development mode serves `page/public`,
but no rust-src asset is prepared there. A request for
`/rust-src.tar.vfsbr?v=development&build=0` therefore falls through to Vite's
SPA fallback and returns `index.html` with status 200 and content type
`text/html`. The Brotli decoder reads the leading `<!DOCTYPE html>` bytes as a
reserved Brotli format marker and throws error `-2`.

Because the optional cache currently stores every successful HTTP response,
the 200 HTML fallback can remain under the compressed-asset URL even after a
valid asset becomes available.

## Development Asset Lifecycle

Add a root `rust-src:prepare-dev-asset` script that invokes the existing
validated archive preparation, writes the development copy to
`.rubrc-cache/dev/rust-src.tar.vfsbr`, and atomically writes its SHA-256 to a
sidecar file. Add `predev` and `prestart` lifecycle scripts to
`page/package.json`; Bun runs these before `dev` and `start` and does not launch
Vite if preparation fails.

A small Vite `configureServer` plugin reads the sidecar at server startup and
serves only the `/rust-src.tar.vfsbr` development request from that ignored
cache path with `Content-Type: application/octet-stream`. Vite uses the same
SHA-256 as the development `SOURCE_REVISION` define. The middleware requires
the request's `v` query parameter to equal that hash before serving the file;
an identity mismatch returns an explicit conflict error rather than caching
the wrong toolchain under a new key. Missing or unreadable files call
`next(error)` instead of falling through to the SPA HTML fallback.

The generated asset stays outside `page/public`, Vite's production static-copy
path, and Vite's watched source tree. The existing toolchain-identity cache
under `.rubrc-cache/sysroot` keeps repeated development starts cheap. A branch
switch with the same toolchain remains valid because the archive contains the
installed toolchain's standard-library source, not repository source. A
toolchain change is detected by the existing archive identity validation on the
next dev/start lifecycle, produces a new content hash, and therefore receives a
new browser cache key. Changing the active Rust toolchain while a dev server is
already running requires restarting that server, matching other Vite config
changes.

## Cache And Response Validation

Extend `fetchWithOptionalCache` with an optional response-acceptance predicate
and cache deletion boundary.

- A valid cache hit is returned unchanged.
- An invalid cache hit is deleted, then the network is tried.
- A valid successful network response is cached.
- An invalid network response is returned by the generic cache helper but is
  not cached; `fetch_compressed_stream` then rejects it before exposing a body.
- Cache open, match, delete, and put failures remain optional-cache failures and
  never replace the network response.

The application has one rust-src archive loader. Cache recovery therefore does
not introduce a global fetch-coalescing layer: doing so would have to reconcile
different abort signals and clone streaming response bodies. If duplicate
callers are added later, CacheStorage deletion and replacement for the same URL
remain idempotent, while request coalescing can be designed at that new owner
boundary.

`fetch_compressed_stream` supplies a strict predicate accepting an absent
content type or the known binary Brotli types `application/octet-stream`,
`application/brotli`, and `application/x-brotli`. It checks the network result
before reading the body and throws a descriptive compressed-asset response
error containing the URL and content type. HTML, JSON, image, and other invalid
payloads never enter CacheStorage or reach `BrotliDecStream`.

## Error Handling

- Missing `rust-src` or `rust-src-preview` components fail the pre-lifecycle
  script with the existing archive-generation error; Vite does not start.
- A stale HTML cache entry is deleted and retried from the network.
- A still-missing network asset produces a clear invalid-content-type error,
  not Brotli error `-2`.
- A non-OK response retains the existing HTTP failure path.
- Corrupt non-text compressed bytes still reach the decoder and retain its
  detailed Brotli error.

## Test Strategy

1. Add cache tests proving an invalid hit is deleted and replaced by a valid
   network response, and that invalid network HTML/JSON is not cached.
2. Add compressed-stream tests proving HTML and JSON are rejected before body
   decompression and acceptable binary/unspecified content types remain valid.
3. Add script contracts requiring `predev` and `prestart`, the development
   output/sidecar paths, content-hash Vite identity, middleware query check, and
   the Git ignore rule.
4. Run the development preparation command, start Vite dev, and verify the
   revisioned rust-src URL returns `application/octet-stream` bytes that native
   Brotli decompression accepts.
5. Re-run focused cache/archive tests and exact browser diagnostics acceptance.

## Rejected Alternatives

- On-demand generation inside Vite middleware couples Node/Vite request
  handling to the Deno archive generator and makes first-request failure
  handling more complex. The selected middleware only streams a file prepared
  before Vite starts.
- A remote development asset can mismatch the local toolchain, breaks offline
  development, and hides local archive-generation failures.
- Merely improving the decoder error leaves development unusable and preserves
  a poisoned CacheStorage entry.
