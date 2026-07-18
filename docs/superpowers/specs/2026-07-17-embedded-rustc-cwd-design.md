# Embedded Rustc Virtual Cwd Design

## Problem

Cargo downloads and extracts registry crates into rubrc's Rust-side `VIRTUAL_FILE_SYSTEM`. When Cargo invokes embedded rustc for a registry crate, it supplies a cwd such as:

```text
/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/hello-1.0.4
```

`wasi_ext_spawn` currently calls the outer VFS module's `std::env::set_current_dir`. That outer module is not plugged into `VIRTUAL_FILE_SYSTEM`; it sees the browser-host preopen instead. Registry files created by embedded Cargo exist only in the Rust-side LFS, so the outer lookup returns `ENOENT` before rustc runs.

The local root build does not expose the bug because `/` is explicitly exempted from the outer `set_current_dir` call.

Investigation confirmed that wasi-libc converts both relative `x` (while its cached cwd is `/`) and absolute `/x` to the identical root-preopen-FD plus `x` WASI call. The host therefore cannot infer absolute intent from the FD/path pair, and an automatic cwd-prefix exception is unsafe because a legitimate relative path can begin with the cwd directory name. The rubrc-only signal that exists before libc destroys intent is rustc's original argv, so the wrapper receives normalized root-path hints extracted from that argv for each invocation.

## Scope

This change fixes cwd-aware path resolution for embedded `rustc_opt` executions. The acceptance case is `cargo add hello` followed by `cargo build` in the same WebShell session.

Build-script execution is explicitly outside this design. No build-script architecture, protocol, or implementation work is included.

## Constraints

- Change rubrc only.
- Do not modify `wasi_virt_layer`, browser shim libraries, Cargo, or rustc artifacts.
- Continue using the shared `StandardDynamicLFS` and global open-FD table.
- Apply cwd only to a named embedded target while its invocation is active.
- Preserve absolute-path behavior and explicit directory-FD behavior.
- Restore cwd routing and temporary FD state on every exit path.
- Do not mirror `.cargo/registry` into the browser-host filesystem.

## Wrapper

Add a rubrc-owned wrapper around `StandardDynamicFileSystem`:

```rust
pub struct CwdAwareFileSystem<F> {
    inner: F,
    root_inode: InodeId,
    root_fd: Fd,
    target_cwds: parking_lot::RwLock<HashMap<TypeId, TargetCwdEntry>>,
    fd_allocation: parking_lot::Mutex<()>,
}
```

`TargetCwdEntry` stores `Wasm::NAME` for diagnostics, the temporary cwd FD, and normalized root-relative path hints extracted from the invocation's original rustc argv. `TypeId::of::<Wasm>()`, not the display name, is the target identity; two target types may legally expose the same name.

The concrete wrapped value remains `StandardDynamicFileSystem<LFS>`. The wrapper implements `Deref` to the inner filesystem so existing rubrc code can continue using `.lfs`, `add_fd`, and `remove_fd` without duplicating storage or changing synchronization helpers.

`CwdAwareFileSystem` implements `Wasip1FileSystem`. Non-path operations delegate unchanged to the inner filesystem. It intercepts every path operation whose directory basis can be affected by cwd:

- `path_create_directory_raw`
- `path_filestat_get_raw`
- `path_filestat_set_times_raw`
- `path_link_raw`
- `path_open_raw`
- `path_readlink_raw`
- `path_remove_directory_raw`
- `path_rename_raw`
- `path_symlink_raw`
- `path_unlink_file_raw`

Two-directory operations remap each directory/path pair independently. For `path_symlink_raw`, only the new-link path is directory-relative; the old path is link contents and is not used to choose a directory FD.

## Path Routing

The wrapper uses `TypeId::of::<Wasm>()` to look up the active cwd FD and root-path hints for the calling embedded target and retains `WasmAccessName::NAME` only for diagnostics. It uses `WasmPathAccess` to normalize and compare guest path components without modifying guest memory or assuming guest pointers are host pointers.

A directory FD is remapped only when all conditions hold:

1. The calling target has an active cwd mapping.
2. The incoming directory FD equals the wrapper's recorded root preopen FD.
3. The guest path is relative; its first component is not the root component.
4. The guest path's normalized normal-component sequence does not equal or descend from an active root-path hint.

A hinted path stays on the original root FD; every other relative root-FD path is remapped to the cwd FD. Directly rooted paths remain at the original root FD, paths relative to an explicitly opened directory FD remain relative to that FD, and targets without an active mapping behave exactly like the inner filesystem. The previous automatic cwd-prefix exception is removed: matching the cwd's directory-name prefix alone never implies root intent.

This mechanism intentionally cannot preserve absolute paths that are not represented in rustc argv. Once libc converts such a path to root FD plus relative bytes, it is indistinguishable from a genuine relative path under the no-WVL/no-artifact constraint and therefore follows cwd routing.

Empty or malformed paths are forwarded to the inner filesystem, which retains ownership of WASI error semantics.

Each intercepted path method holds the target-cwd read lock from lookup through completion of the delegated inner filesystem call. Guard cleanup requires the write lock, so it cannot remove a temporary FD after routing has selected it but before the inner filesystem reads it. Two-directory operations hold one read guard while routing and dispatching both path pairs.

The wrapper also intercepts `fd_close_raw` and `fd_renumber_raw`. Each operation holds the target-cwd read lock from the protected-FD check through completion of any delegated inner mutation. The recorded root FD and every active temporary cwd FD are protected from close, replacement, and renumbering while owned by the wrapper. Attempts return a deterministic WASI error without mutating the inner FD map. All other FD operations delegate unchanged.

`path_open_raw`, successful unprotected renumbering, and temporary cwd FD allocation also share `fd_allocation`. This closes the inner allocator's gap between incrementing `next_fd` and inserting into `fd_map`. Renumbering leaves `next_fd` unchanged; before each later allocation, the wrapper advances past any occupied descriptor under the same lock. Descriptor `u32::MAX` is reserved, so renumbering to it or allocating it returns exhaustion without wrapping to stdio FDs.

## Cwd Lifecycle

The wrapper exposes a rubrc-internal operation that resolves a virtual directory path from the LFS root and installs it for one target:

```rust
fn enter_target_cwd<Wasm>(
    &self,
    cwd: &[u8],
    root_path_hints: Vec<Vec<String>>,
) -> Result<TargetCwdGuard<'_, F>, String>
where
    Wasm: WasmAccessName + 'static;
```

The operation:

1. Returns a no-op guard for an empty cwd so rustc discovery/probe invocations preserve root routing without allocating a mapping or FD.
2. Decodes and normalizes a non-empty Cargo cwd for traversal.
3. Rejects invalid UTF-8, unsupported prefixes, root escapes, missing entries, symlink components, and non-directory entries. Cwd traversal does not follow symlinks.
4. Acquires the mapping write lock and checks that `TypeId::of::<Wasm>()` is absent.
5. Traverses `inner.lfs` from the wrapper's recorded root inode.
6. Returns a no-op guard for `/` because root routing already has the correct behavior.
7. While still holding that lock, calls `inner.add_fd` exactly once with directory rights equivalent to the root preopen and inserts the resulting FD plus the already-normalized root-path hints into the target entry. If insertion cannot complete, it removes that same FD before returning.
8. Returns an RAII guard.

`TargetCwdGuard::drop` acquires the mapping write lock, removes the target mapping, and then removes that entry's exact temporary FD before releasing the lock. Active path calls hold a read lock through inner dispatch, so cleanup waits for them. Protected close/renumber handling ensures the stored FD still names the wrapper-owned inode.

The existing `RUSTC_RUN_LOCK` continues to serialize rustc resets and invocations. The target-keyed mapping prevents Cargo, vfs-shell, LLVM, LSP, and other embedded targets from inheriting rustc's cwd.

## Rustc Spawn Integration

`wasi_ext_spawn` keeps Cargo's cwd bytes and debug trace. For `rustc`:

1. Acquire `RUSTC_RUN_LOCK` as today.
2. Append the forced `--sysroot /sysroot` and linker arguments to the local argv. This is local preparation, not global invocation-state mutation.
3. Extract, normalize, and deduplicate absolute root-path hints from that complete argv.
4. Validate and enter `rustc_opt`'s target cwd with those hints before mutating environment, global arguments, output capture, or child-process state.
5. Install the same prepared argv and environment as today.
6. Inside `catch_unwind(AssertUnwindSafe(...))`, install invocation and child-process state, then reset and execute `rustc_opt` while the cwd guard is alive.
7. On success, restore state through the guards and retain the existing child stdout, stderr, and rustc status. On panic, let both guards restore exact prior state during unwind, then return empty stdout, a bounded `embedded rustc panicked: ...` stderr diagnostic, and deterministic status `101`.
8. Let the cwd guard drop normally after either result to restore routing and remove the temporary FD.

The pure argv extractor recognizes `/` at token start and after path-value boundaries such as `=` and `@`. It covers standalone source paths, `--sysroot`, `--out-dir`, `-Ldependency=`, `--extern=name=`, comma-delimited joined or separate `--emit` values, and `@/response` without reading response files. It normalizes paths to root-relative UTF-8 components, ignores root escapes and root-only values, and deduplicates exact hints.

The outer `std::env::current_dir` / `std::env::set_current_dir` / restore block is removed from the rustc spawn path. The obsolete `virtual_cwd_for_set_current_dir` helper is removed.

If cwd validation fails, `wasi_ext_spawn` returns the existing Cargo-owned status-1 result with a bounded explanatory stderr message and does not invoke rustc. Because validation occurs first, no invocation state requires rollback on this path. A rustc panic is contained before the `extern "C"` boundary; invocation and child state restore through RAII before Cargo receives the bounded status-101 result, and cwd cleanup then follows the normal drop path.

## Construction

During `VIRTUAL_FILE_SYSTEM` initialization:

1. Construct `StandardDynamicLFS` and its root inode as today.
2. Construct `StandardDynamicFileSystem`.
3. Add the root inode as an FD and retain the returned FD.
4. Wrap the filesystem, root inode, and root FD in `CwdAwareFileSystem`.

`plug_fs!` continues receiving `&*VIRTUAL_FILE_SYSTEM`; the wrapper satisfies the same `Wasip1FileSystem` interface.

## Concurrency And Ownership

- The existing filesystem and inode stores are not copied.
- Temporary cwd FDs use the inner filesystem's atomic FD allocator.
- Cwd mappings are keyed by target `TypeId`; names are diagnostic only.
- Path routing holds a mapping read lock through inner dispatch; install and cleanup hold the write lock.
- Close and renumber hold the mapping read lock through protection checks and delegated mutation, preventing races with cwd installation or cleanup.
- Cwd allocation, `path_open_raw`, and renumbering hold the FD-allocation mutex through allocator inspection and inner mutation.
- The wrapper rejects close or renumber operations involving the root FD or an active cwd FD.
- Rustc invocation remains serialized by `RUSTC_RUN_LOCK`.
- Other targets can continue using the root and their explicit FDs while rustc runs.
- Guard cleanup is deterministic on success, validation error, rustc error, or unwind.

## Testing

Unit tests use separate fake `WasmAccessName` target types and an in-memory dynamic LFS to prove:

- A relative path for the mapped rustc target resolves beneath its cwd.
- The same relative path for an unmapped target still resolves from root.
- An absolute path for the mapped target still resolves from root.
- A stripped `/sysroot/...` path stays root-based when `/sysroot` is an argv hint, even if the cwd contains a colliding `sysroot` directory.
- An absolute source path under the cwd stays root-based through its exact argv hint.
- An ordinary relative path still resolves beneath cwd while hints are active.
- A legitimate relative path beginning with the cwd directory name remains cwd-relative without a hint.
- The pure argv extractor covers every supported rustc path-value form, normalization, escape rejection, and deduplication.
- A path using an explicitly opened directory FD is not remapped.
- Both sides of link and rename operations are routed independently.
- An empty cwd returns a no-op guard, allocates no mapping or FD, and preserves root routing.
- A no-op root guard does not allocate or alter routing.
- Missing, file-valued, escaping, and duplicate cwd mappings are rejected.
- Symlink components in a cwd are rejected rather than followed.
- Dropping the guard restores root behavior and removes the temporary FD.
- A routed path call racing guard drop completes before the FD is removed.
- Close and renumber cannot remove, replace, or move protected root/cwd FDs.
- Renumbering onto the allocator's current candidate leaves the destination intact and lets the next allocation skip it.
- Renumbering to `u32::MAX - 1` does not move a low allocator cursor or prevent later cwd/path allocation; destination `u32::MAX` remains rejected.
- A rejected duplicate mapping does not allocate or leak an FD.
- Rustc panic containment observes replacement child stdio while active, restores exact prior `Some` and `None` child states plus invocation state, bounds stderr, and returns status `101`.

The existing Cargo-add E2E is extended to run, in one retained VFS session:

```text
cargo add hello
cargo build -j 1
```

The E2E prepares the wasm32-wasip1 sysroot, proves rustc is invoked for the registry source cwd, rejects `failed to set cwd`, requires successful compilation of `hello`, and requires the shell prompt to return.

Existing local workspace Cargo build, Cargo run, Cargo add/info, Deno bridge, VFS Rust, formatting, build, and artifact checks remain required.

## Acceptance Criteria

- The reported `hello-1.0.4` registry cwd no longer touches the browser-host filesystem.
- Relative rustc filesystem operations resolve from Cargo's virtual cwd.
- Absolute and explicit-directory-FD operations retain existing behavior.
- Cwd state is target-local and restored after every rustc invocation.
- `cargo add hello` followed by `cargo build -j 1` succeeds and returns to the WebShell prompt.
- No WVL, browser shim, Cargo, rustc artifact, or build-script implementation is changed.
