# WASI Workspace File Provider Design

## Goal

Expose the browser-side WASI workspace tree through the Monaco VS Code `file:`
service so `file:///src/main.rs` and future workspace files resolve without
duplicating their contents in a second JavaScript file store.

The provider must be available before `MonacoVscodeApiWrapper.start()` because
the editor service can restore or resolve workspace resources during startup.
The existing embedded VFS synchronization remains responsible for propagating
document changes into the running Rust VFS session.

## Current Problem

The application currently has three related but separate representations:

- `browser_wasi_shim` `Directory` and `File` objects back the WASI preopen.
- Monaco models represent open editor documents.
- The Monaco VS Code files override owns an independent `file:` provider.

`/src/main.rs` exists in the WASI tree and as a Monaco model, but it is never
registered with the VS Code file service. When `TextModelResolverService`
resolves `file:///src/main.rs`, `TextFileEditorModel` reads through the empty
default file provider and throws `FileOperationError`. On Windows the error
renders the URI's filesystem path as `\src\main.rs`; that display is not a path
conversion bug.

## Chosen Architecture

Use one browser-side workspace tree as the JavaScript source of truth. A custom
file-system provider adapts that tree to the VS Code `file:` service, while the
WASI farm receives the same root as its preopen.

This sharing is compatible with the current threaded runtime. `WASIFarm` keeps
the actual file descriptors and `PreopenDirectory` objects on the UI thread.
Worker-side WASI calls cross the farm's existing shared transport and execute
against those host objects; the directory tree is not cloned into each worker.
The custom provider therefore reads the same host objects without introducing
another worker call or new shared-memory protocol.

This avoids two less suitable alternatives:

- A separate `RegisteredMemoryFile` mirror is simple but duplicates contents
  and requires every mutation to update two stores.
- An RPC-backed provider that forwards every `stat`, `read`, and `write` to the
  running VFS adds latency and makes file-service startup depend on worker and
  VFS readiness. It also introduces avoidable re-entrancy and deadlock risks.

The existing VFS synchronization RPC is not a second JavaScript content store.
It remains a propagation boundary for the already-running Rust VFS session,
which cannot be replaced by changing the host preopen object after startup.

## Components

### Workspace Tree

A focused workspace module owns the singleton browser-side filesystem:

- The root `Map<string, Inode>`.
- The `src`, `sysroot`, `.cargo`, `Cargo.toml`, and `rust-project.json` nodes.
- The initial `/src/main.rs` `File` containing `default_value`.
- The `PreopenDirectory` consumed by `WASIFarm`.
- POSIX-path traversal and mutation operations used by the provider and
  document synchronization.

`xterm.tsx` no longer constructs a private root. It consumes the shared preopen
and shared `sysroot` map. Rust-source population therefore remains visible to
the shell and spawned modules without copying archive contents.

The module exposes operations rather than allowing callers to duplicate path
walking. Operations validate absolute POSIX paths, reject `..`, backslashes,
NUL bytes, and non-empty authorities, and never use `URI.fsPath`. Using
`URI.path` keeps behavior independent of the browser host OS.

### VS Code File Provider

A custom `IFileSystemProviderWithFileReadWriteCapability` adapts `file:` URIs
to the shared workspace operations. It implements the operations required by
the files override:

- `stat`
- `readFile`
- `writeFile`
- `readdir`
- `mkdir`
- `delete`
- `rename`
- `watch`

The provider replaces the default `file:` provider through
`registerCustomProvider("file", provider)` before
`MonacoVscodeApiWrapper.start()`. The default provider is an empty in-memory
filesystem, so layering the WASI tree over it adds no useful content and can
make the UI see lower-layer files that the WASI guest cannot access. A complete
replacement guarantees that Monaco, the explorer, and the guest observe the
same namespace and that deleted files cannot reappear from a lower layer.

The WASI workspace owns the authority-free POSIX `file:` root, including `/`
itself and future top-level project paths such as `/tests` or `/build.rs`.
Windows drive-letter URIs and non-empty authorities are rejected without
mutation. Other VS Code resources continue to use their distinct schemes such
as `vscode-userdata`, `extension-file`, and `tmp`.

The provider copies incoming write buffers before assigning `File.data`, so a
caller cannot mutate workspace content after a completed write. Lightweight
creation and modification metadata is maintained separately from file bytes.
Writes, creates, deletes, and renames emit the corresponding VS Code file
change events.

Tree writes identify their origin. Provider-originated commits emit file
events. Model-originated writes from `RustDocumentSync` update the shared bytes
without emitting an external-file event because the active Monaco model already
contains that edit. This prevents a keystroke from being misclassified as an
external disk change and avoids reload or save-conflict feedback loops.

Provider registration is application-scoped and guarded so it runs exactly
once before service initialization. Development hot reload reuses the existing
provider rather than attempting an invalid post-initialization replacement.

### Document Synchronization

`RustDocumentSync` continues to send immediate LSP document notifications and
immediate VFS synchronization commands. Its local write dependency changes to
the shared workspace mutation operation.

For each accepted Rust document change, ordering remains:

1. Silently update the shared browser-side workspace file.
2. Propagate the same path and content to the running Rust VFS session.
3. Complete the existing `didOpen` or `didChange` flow.

This preserves the current no-debounce LSP behavior and the existing VFS
session contract while removing the special-case direct assignment to the
exported `rust_file` object.

## Data Flow

At startup:

1. Create the shared workspace tree and initial files.
2. Register the custom `file:` provider.
3. Start `MonacoVscodeApiWrapper`.
4. Mount the Monaco editor using `file:///src/main.rs`.
5. Start the WASI farm with the shared preopen.
6. After rust-src readiness, start the embedded language client.

For editor changes:

1. Monaco updates the text model.
2. `RustDocumentSync` writes the shared `File.data`.
3. `RustDocumentSync` forwards the update through the existing VFS sync
   session.
4. The language client sends the corresponding LSP notification.

For file-service reads, the provider traverses the shared tree and returns the
current `File.data` directly. No worker RPC or content mirror is involved.

## Scope And Limitations

The provider supports multiple files under the workspace, not only
`/src/main.rs`. This matches existing secondary-document synchronization and
avoids another single-file special case.

Rubrc intentionally uses immediate-persistence editing rather than a separate
Save/Revert lifecycle. Every accepted Monaco model change becomes the current
WASI workspace content and compiler input immediately. Closing an editor does
not discard those changes, and the application does not present them as an
unsaved disk buffer. Introducing conventional save, discard, and revert
semantics would require a separate buffer-versus-workspace design and is
outside this change.

Writes committed through the provider emit file events. Model-originated
`RustDocumentSync` writes are silent by design. The current browser WASI shim
does not expose a general notification when a guest process mutates a preopen
file directly. Such content is visible to subsequent provider reads because
the same `File` object is shared, but an already-open Monaco model is not
automatically reloaded from an unobservable guest write. Guest-originated
source editing and conflict detection are outside this fix; supporting them
requires a separate explicit VFS change channel rather than polling or
pretending that model edits are external disk writes.

The provider does not inspect private Wasm memory, poll atomics, or call back
into Rust from a Rust-originated JavaScript callback.

## Error Handling

Invalid or escaping paths fail before tree traversal. Missing files and
directories map to the standard VS Code file-not-found error. Type conflicts,
such as treating a file as a directory, map to the corresponding provider
error. Unsupported authorities are rejected instead of silently aliasing the
local workspace. Windows drive-letter file URIs are not rewritten to the POSIX
workspace and fail as unsupported resources.

VFS propagation failures remain visible to `RustDocumentSync`; a successful
host-tree write does not hide a failed update to the running Rust VFS session.
No automatic retry is added because ordering against LSP notifications must
remain explicit.

## Testing

Focused workspace tests verify:

- `/src/main.rs` is readable before the VS Code API wrapper starts.
- The provider and WASI preopen observe the same `File` bytes.
- Multiple workspace files can be created, read, changed, listed, renamed, and
  deleted, including new top-level project paths.
- Writes copy input buffers and provider commits emit the correct file change
  events.
- Model-originated writes update shared bytes without emitting an external-file
  event.
- POSIX traversal rejects escaping, backslash, NUL, and authority variants.
- Root-relative behavior is identical under Windows and non-Windows browser
  user agents because only `URI.path` is used; drive-letter URIs are rejected.
- Root listing contains exactly the entries visible through the WASI preopen.
- Deleting a file removes it from both the VS Code and WASI views without a
  lower-layer reappearance.

Document synchronization tests verify the shared-tree write, VFS propagation,
and LSP completion order for both main and secondary Rust files.

Browser verification reloads the extended editor service, confirms
`file:///src/main.rs` resolves without `FileOperationError`, and preserves the
existing invalid-diagnostic publication and valid-diagnostic clearing checks.
