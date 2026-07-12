# Cargo Info HTTP Bridge Design

## Goal

Make `cargo info dashmap` complete in WebShell by connecting Cargo's WASI HTTP client to the browser host without blocking on Cargo's internal HTTP worker thread.

## Root Cause

Cargo's WASI `Client::request()` sends work to a spawned HTTP worker and awaits a oneshot response. In the embedded WebShell runtime, that response never wakes the waiting future. Separately, VFS exports `wasi_ext_fetch` as an unconditional error stub, so no crates.io request can succeed even if the worker wakes.

## Architecture

On WASI only, Cargo performs HTTP requests directly from `Client::request()` through the existing synchronous `fetch_wasi` bridge. Non-WASI Cargo retains the worker-thread implementation.

VFS replaces the `wasi_ext_fetch` stub with a WIT host bridge. It copies request data from `cargo_opt` memory into VFS-owned data, invokes a synchronous WIT import, then copies the returned status, headers, and body into Cargo-owned memory using Cargo's exported allocator.

The WIT import delegates to `WASIFarm.unknown_fn` with an `httpRequest` message. The farm executes browser `fetch()` asynchronously on its host side. The existing SharedArrayBuffer/Atomics unknown-function bridge synchronously suspends the Wasm caller until the Promise resolves.

## Components

### Cargo WASI Client

- `Client::new()` does not create an HTTP worker on WASI.
- `Client::request()` calls the WASI blocking request implementation directly and returns its result from the async function.
- Native request scheduling is unchanged.

### VFS HTTP ABI

- Input: method, URL, request headers, and raw body.
- Output: HTTP status, response headers, and raw response body.
- VFS never exposes Cargo guest pointers directly to the component host callback.
- Empty buffers use zero length and are not dereferenced.
- Allocation failures or host errors return a nonzero bridge status.

### Browser Host

- `httpRequest` uses `fetch()` with the supplied method, headers, and body.
- Response headers preserve repeated entries as far as the Fetch API exposes them.
- Response body remains binary and is never decoded as text.
- Fetch rejection returns a structured error to Cargo instead of hanging.

### Deno Regression Host

- The debug harness supplies the same `httpRequest` unknown-function contract using Deno `fetch()`.
- The regression uses an isolated VFS workspace and rejects timeout, Cargo errors, or missing package metadata.

## Error Handling

- Network errors become Cargo HTTP errors.
- Non-2xx HTTP responses retain their actual status and body for Cargo's normal handling.
- Malformed host responses produce a bridge error, not undefined memory reads.
- The caller always receives a response or an explicit error; no oneshot wait remains on WASI.

## Testing

1. RED: `cargo info dashmap` times out after `Updating crates.io index`.
2. Cargo focused tests prove WASI requests bypass the worker channel while native behavior remains unchanged.
3. Host bridge tests cover method, headers, binary body, response status, and network error serialization.
4. GREEN: `cargo info dashmap` prints DashMap package metadata and returns to the shell prompt.
5. Regression: the isolated `cargo b -j 1 -p app` build still compiles and links successfully.
6. Both generated `vfs.core.wasm` files validate and remain byte-identical.

## Scope

- No general Cargo async refactor.
- No crates.io-specific proxy or persistent package cache.
- No change to native Cargo HTTP behavior.
- No change to rustc execution or process stdin semantics.
