# Rust-Analyzer Live Diagnostics Design

## Problem

rubrc already embeds rust-analyzer and constructs a `MonacoLanguageClient`, but
invalid Rust code is not underlined in the editor. The backend can produce
`textDocument/publishDiagnostics`; the browser path does not reliably deliver
those notifications to Monaco.

The current path has three concrete weaknesses:

- The language client starts when Monaco mounts, before the VFS worker and its
  `/rust-project.json` workspace are ready.
- LSP output crosses a raw Wasm `i32` boundary while the browser compares the
  session as the unsigned value `0xffff_ffff`. The same bridge serializes bytes
  as an array, while the reader assumes it receives a `Uint8Array`.
- Editor changes are mirrored to `/src/main.rs` through a hard-coded callback.
  This does not define lifecycle behavior for additional open Rust models.

As a result, rust-analyzer may fail during initialization, its output may be
routed to the terminal, or the JSON-RPC framing buffer may reject the received
data before Monaco sees diagnostics.

## Goal

Use the embedded rust-analyzer to display diagnostics as Monaco squiggles for
every open Rust file.

- Changes are diagnosed while the user types, settling roughly 300 ms after
  input pauses under normal browser load.
- Error, warning, information, and hint diagnostics are all retained. Monaco
  chooses the standard marker color and decoration for each LSP severity.
- Correcting an error removes the stale marker.
- Diagnostic messages remain available through Monaco's normal hover UI.

The current UI opens only `/src/main.rs`, but the lifecycle must apply to any
future open `file:` model whose language is `rust`.

## Non-goals

- A Problems panel or workspace-wide diagnostic list.
- Diagnostics for files that have never been opened in Monaco.
- A custom parser, compiler-output parser, or custom squiggle renderer.
- Enabling rust-analyzer's Cargo `checkOnSave` subprocess.
- Borrow-checker, lifetime, and other compiler-only diagnostics that require
  `cargo check`; live diagnostics are limited to rust-analyzer's native
  syntax, name-resolution, type, and related analysis.
- Code completion, rename, formatting, or other new LSP features.
- Changing rust-analyzer, Cargo, rustc, `wasi_virt_layer`, or browser shim
  artifacts.

## Architecture

Keep the standard LSP flow:

```text
Monaco file model
  -> MonacoLanguageClient text synchronization
  -> rubrc LSP JSON-RPC bridge
  -> embedded rust-analyzer
  -> textDocument/publishDiagnostics
  -> MonacoLanguageClient diagnostic collection
  -> Monaco model markers and squiggles
```

`MonacoLanguageClient` remains the owner of LSP document synchronization and
diagnostic markers. A text-synchronization middleware coordinates VFS writes
with the client's standard `didOpen` and `didClose` operations, but it does not
construct JSON-RPC notifications or delay standard incremental `didChange`
operations. rubrc does not call `monaco.editor.setModelMarkers` itself. This
avoids a second source of marker state and lets the client clear markers on an
empty diagnostic publication or document close.

The browser separately mirrors model contents into the Rust-side VFS so Cargo,
rust-analyzer filesystem reads, and terminal commands see the same source. VFS
mirroring does not replace LSP `didChange`; an open document's in-memory LSP
text is authoritative for live diagnostics.

## Startup Lifecycle

The application tracks Monaco readiness and VFS readiness as state, not as
ephemeral events. It starts the language client exactly once per component
mount, as soon as both conditions are true regardless of their completion
order:

1. Monaco has mounted and supplied its editor/API instances.
2. `vfs_ready_id` has fired, meaning the worker has installed the root VFS,
   `/src/main.rs`, and `/rust-project.json`.

Starting the client then sends `initialize` against a complete workspace. Its
client options keep the selector `{ scheme: "file", language: "rust" }`, root
URI `file:///`, linked project `/rust-project.json`, disabled proc macros, and
disabled `checkOnSave`.

The model for `/src/main.rs` must have the canonical URI
`file:///src/main.rs`. Additional models participate only when they also use
the `file:` scheme and Rust language ID. A model outside that selector is left
untouched.

Development remounts and application cleanup must not create duplicate
clients or duplicate listeners. The app retains the client start promise. On
cleanup it clears synchronization timers, settles pending middleware
operations, stops the active `MonacoLanguageClient`, and disposes the JSON-RPC
connection and reader subscription. A failed start is logged once and may be
retried only by a later component mount, not by every keystroke or readiness
notification.

## Document And VFS Synchronization

The standard language client observes matching Monaco models. Its
text-synchronization middleware and VFS mirror cooperate as follows:

- On open, mirror the full document to the VFS and then call the client's
  standard `didOpen` continuation with the document and its version.
- On change, call the client's standard `didChange` continuation immediately,
  preserving the incremental edits and versions produced by
  `MonacoLanguageClient`. Independently replace that URI's pending VFS snapshot
  and restart a 300 ms mirror timer.
- When the timer fires, write the latest complete document text to the VFS.
  Different URI timers and writes do not block one another.
- On close, cancel the URI's timer, flush and await its latest full-text VFS
  snapshot, and only then call the standard `didClose` continuation.
  After a successful write, rust-analyzer cannot discard its open-document
  overlay before the same text is visible in the VFS. A failed write is logged
  before close continues.

No promise returned from `didChange` waits for the debounce timer or VFS write.
This preserves the language client's event queue and rust-analyzer's native
incremental analysis. rust-analyzer may perform its own analysis coalescing;
live diagnostic latency is expected to settle around 300 ms under normal load,
but the VFS mirror delay is the only explicit 300 ms timer. Initial Wasm and
sysroot loading are excluded from this interaction target.

VFS mirroring is performed by the same middleware and only for documents
matching `{ scheme: "file", language: "rust" }`. It uses `document.uri.path`,
not a raw encoded URI string, requires an absolute path with no authority, and
sends JSON `{ "path": string, "content": string }` through the
`input_string` SharedObject with session `0xeeeeeeee`. The worker maps that
session to `EVENT_TYPE_WRITE_FILE`.

The existing worker callback launches an unreturned async IIFE, so its proxy
currently resolves before dispatch completion. The VFS and LSP branches are
changed to call synchronous `vfs_root.dispatch` before the SharedObject handler
returns. The proxy response then acknowledges that the dispatch completed; a
synchronous exception rejects the call. This acknowledgement lets `didOpen`
and `didClose` enforce their VFS-before-LSP ordering. Interactive terminal input
retains its existing behavior. A VFS write failure is logged with the path but
does not suppress the LSP notification; live diagnostics remain available even
if terminal builds temporarily see older contents.

The initial `/src/main.rs` continues sharing `rust_file` with the browser VFS
bootstrap. For compatibility with existing host-side consumers, mirroring
`/src/main.rs` also updates that object before dispatching the write event. The
Rust-side VFS remains authoritative for rust-analyzer and terminal commands.
Other Rust models use the same Rust-side VFS write event; its existing path
creation behavior creates missing parent directories.

## LSP Transport

### Session routing

`LSP_SESSION_ID` remains `0xffff_ffff`. At the raw Wasm-to-JavaScript boundary,
the received session is normalized with `sessionId >>> 0` before comparison
and forwarding, so raw `-1` and unsigned `0xffff_ffff` are equivalent. Normal
terminal session IDs retain their existing values and routing.

### Byte payloads

The generated binding continues copying terminal output out of shared Wasm
memory before returning and sends a plain numeric array through SharedObject.
The LSP reader accepts the two explicitly supported in-process forms:

- `Uint8Array`
- numeric arrays

It validates every array element as an integer byte and converts the payload to
a fresh `Uint8Array`. Object-shaped and malformed payloads call the reader's
error notification with an `Error`; they are not silently treated as empty
messages.

### JSON-RPC framing

The reader preserves bytes across callbacks and supports split headers, split
bodies, and multiple messages in one callback. It requires a valid ASCII
`Content-Length` header and waits until the declared UTF-8 body length is
available before parsing JSON. A malformed header, impossible length, or
invalid JSON reports an error and closes the message connection. The reader
does not scan forward to guess a new frame boundary because a corrupted byte
stream cannot be safely resynchronized.

The writer retains byte-length-based `Content-Length`, not JavaScript string
length, so non-ASCII JSON content is framed correctly.

## Diagnostics

No severity filtering is added. Incoming `textDocument/publishDiagnostics`
notifications are handled by `MonacoLanguageClient`, which maps LSP zero-based
ranges and severities to its diagnostic collection and Monaco markers.

An empty diagnostic array for a URI replaces and clears previous markers.
Diagnostics for a URI with no matching open Rust `file:` model remain managed
by the language client but are not surfaced in a new workspace Problems UI.

## Failure Handling

- Worker/VFS readiness delays LSP startup; it does not start a partial client.
- Language-client startup failure is logged and leaves editing and terminal
  execution usable.
- Invalid transport payloads and malformed JSON-RPC frames are reported through
  the message reader's error mechanism and close the LSP connection without
  being rendered as diagnostics.
- A failed VFS mirror write is logged with its path. It does not close the LSP
  connection or suppress the corresponding standard document notification.
- rust-analyzer crashes or connection closure stop further diagnostics but do
  not affect Run/Cargo operations.

## Testing

### Transport tests

Focused TypeScript tests prove:

- signed `-1` and unsigned `0xffff_ffff` both route to the LSP channel;
- ordinary terminal sessions do not route to LSP;
- typed and numeric arrays reconstruct exact bytes;
- a Unicode JSON-RPC payload uses UTF-8 byte length;
- split and coalesced frames produce messages exactly once;
- malformed payloads and headers report errors and close the connection.

### Synchronization tests

Focused tests with fake middleware continuations prove:

- `didChange` calls its standard continuation without waiting 300 ms;
- rapid changes for one URI produce one VFS write containing the latest text;
- changes for two URIs use independent timers and paths;
- `didClose` flushes the latest VFS text before its continuation runs;
- the VFS proxy resolves only after synchronous worker dispatch returns;
- a failed VFS write is logged and does not suppress the LSP continuation.

### Rust-analyzer integration test

A worker-backed test initializes the real embedded rust-analyzer with the same
framed transport and VFS workspace as the page. It then:

1. Sends `initialize`, receives its successful response, sends `initialized`,
   and opens `file:///src/main.rs` with invalid Rust.
2. Parses publications until one contains the expected diagnostic URI and a
   range covering the invalid expression; it does not assume the first
   publication is final.
3. Sends a higher-version `didChange` containing valid Rust.
4. Parses later publications until the same URI has no error diagnostic.

The test parses JSON-RPC messages; substring matching is insufficient.

### Browser acceptance test

A repository-owned Puppeteer test command starts the built page in a real
browser, waits for VFS and language-client startup, then edits the current Rust
model through Monaco. Puppeteer is declared as a root development dependency
instead of relying on an undeclared environment installation. The test:

1. Insert invalid Rust and wait for `monaco.editor.getModelMarkers` to return a
   marker for `file:///src/main.rs`.
2. Assert the marker has the rust-analyzer message, expected range, and LSP
   severity mapping.
3. Replace the text with valid Rust and assert the marker is removed.
4. Create `file:///src/secondary.rs` as an open Rust model, insert invalid Rust,
   and assert that URI receives its own marker and VFS mirror write.
5. Confirm the page remains usable and no diagnostic text was written to the
   terminal channel.

The test uses a generous startup timeout for Wasm/sysroot initialization but a
short post-readiness timeout for edit-to-marker propagation. It tests marker
state rather than screenshots, making the underline behavior deterministic.

## Acceptance Criteria

- Invalid code in any open Rust `file:` model receives Monaco squiggles from
  embedded rust-analyzer diagnostics.
- All four LSP diagnostic severities are accepted without custom filtering.
- Editing invalid code into valid code clears stale squiggles.
- The initial language client does not start before VFS readiness and starts no
  more than once per app mount.
- LSP output is never shown as ordinary terminal output.
- Open-model text is mirrored to its matching absolute VFS path after a 300 ms
  per-model debounce.
- Transport, real rust-analyzer invalid-to-valid behavior, and browser marker
  rendering have automated regression coverage.
