# Embedded Rustc Virtual Cwd Design

## Problem

Cargo downloads and extracts registry crates into rubrc's Rust-side `VIRTUAL_FILE_SYSTEM`. When Cargo invokes embedded rustc for a registry crate, it supplies a cwd such as:

```text
/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/hello-1.0.4
```

`wasi_ext_spawn` currently calls the outer VFS module's `std::env::set_current_dir`. That outer module is not plugged into `VIRTUAL_FILE_SYSTEM`; it sees the browser-host preopen instead. Registry files created by embedded Cargo exist only in the Rust-side LFS, so the outer lookup returns `ENOENT` before rustc runs.

The local root build does not expose the bug because `/` is explicitly exempted from the outer `set_current_dir` call.

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
}
```

`TargetCwdEntry` stores `Wasm::NAME` for diagnostics and the temporary cwd FD for routing. `TypeId::of::<Wasm>()`, not the display name, is the target identity; two target types may legally expose the same name.

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

The wrapper uses `TypeId::of::<Wasm>()` to look up the active cwd FD for the calling embedded target and retains `WasmAccessName::NAME` only for diagnostics. It uses `WasmPathAccess` to inspect the guest path without copying or modifying guest memory.

A directory FD is remapped only when all conditions hold:

1. The calling target has an active cwd mapping.
2. The incoming directory FD equals the wrapper's recorded root preopen FD.
3. The guest path is relative; its first component is not the root component.

Absolute paths remain rooted at the original root FD. Paths relative to an explicitly opened directory FD remain relative to that FD. Targets without an active mapping behave exactly like the inner filesystem.

Empty or malformed paths are forwarded to the inner filesystem, which retains ownership of WASI error semantics.

Each intercepted path method holds the target-cwd read lock from lookup through completion of the delegated inner filesystem call. Guard cleanup requires the write lock, so it cannot remove a temporary FD after routing has selected it but before the inner filesystem reads it. Two-directory operations hold one read guard while routing and dispatching both path pairs.

The wrapper also intercepts `fd_close_raw` and `fd_renumber_raw`. Each operation holds the target-cwd read lock from the protected-FD check through completion of any delegated inner mutation. The recorded root FD and every active temporary cwd FD are protected from close, replacement, and renumbering while owned by the wrapper. Attempts return a deterministic WASI error without mutating the inner FD map. All other FD operations delegate unchanged.

## Cwd Lifecycle

The wrapper exposes a rubrc-internal operation that resolves a virtual directory path from the LFS root and installs it for one target:

```rust
fn enter_target_cwd<Wasm>(&self, cwd: &[u8]) -> Result<TargetCwdGuard<'_, F>, String>
where
    Wasm: WasmAccessName + 'static;
```

The operation:

1. Decodes and normalizes the Cargo cwd.
2. Rejects invalid UTF-8, unsupported prefixes, root escapes, missing entries, symlink components, and non-directory entries. Cwd traversal does not follow symlinks.
3. Returns a no-op guard for `/` because root routing already has the correct behavior.
4. Traverses `inner.lfs` from the wrapper's recorded root inode.
5. Acquires the mapping write lock and checks that `TypeId::of::<Wasm>()` is absent.
6. While still holding that lock, calls `inner.add_fd` exactly once with directory rights equivalent to the root preopen and inserts the resulting FD into the target entry. If insertion cannot complete, it removes that same FD before returning.
7. Returns an RAII guard.

`TargetCwdGuard::drop` acquires the mapping write lock, removes the target mapping, and then removes that entry's exact temporary FD before releasing the lock. Active path calls hold a read lock through inner dispatch, so cleanup waits for them. Protected close/renumber handling ensures the stored FD still names the wrapper-owned inode.

The existing `RUSTC_RUN_LOCK` continues to serialize rustc resets and invocations. The target-keyed mapping prevents Cargo, vfs-shell, LLVM, LSP, and other embedded targets from inheriting rustc's cwd.

## Rustc Spawn Integration

`wasi_ext_spawn` keeps Cargo's cwd bytes and debug trace. For `rustc`:

1. Acquire `RUSTC_RUN_LOCK` as today.
2. Validate and enter `rustc_opt`'s target cwd before mutating environment, arguments, output capture, or child-process state.
3. Install environment and arguments as today.
4. Reset and execute `rustc_opt` while the cwd guard is alive.
5. Restore environment, arguments, output capture, and child-process state as today.
6. Let the cwd guard drop to restore routing and remove the temporary FD.

The outer `std::env::current_dir` / `std::env::set_current_dir` / restore block is removed from the rustc spawn path. The obsolete `virtual_cwd_for_set_current_dir` helper is removed.

If cwd validation fails, `wasi_ext_spawn` returns the existing Cargo-owned status-1 result with a bounded explanatory stderr message and does not invoke rustc. Because validation occurs first, no invocation state requires rollback on this path. State changed after validation remains covered by existing restoration plus focused RAII guards where an unwind could otherwise bypass cleanup.

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
- The wrapper rejects close or renumber operations involving the root FD or an active cwd FD.
- Rustc invocation remains serialized by `RUSTC_RUN_LOCK`.
- Other targets can continue using the root and their explicit FDs while rustc runs.
- Guard cleanup is deterministic on success, validation error, rustc error, or unwind.

## Testing

Unit tests use separate fake `WasmAccessName` target types and an in-memory dynamic LFS to prove:

- A relative path for the mapped rustc target resolves beneath its cwd.
- The same relative path for an unmapped target still resolves from root.
- An absolute path for the mapped target still resolves from root.
- A path using an explicitly opened directory FD is not remapped.
- Both sides of link and rename operations are routed independently.
- A no-op root guard does not allocate or alter routing.
- Missing, file-valued, escaping, and duplicate cwd mappings are rejected.
- Symlink components in a cwd are rejected rather than followed.
- Dropping the guard restores root behavior and removes the temporary FD.
- A routed path call racing guard drop completes before the FD is removed.
- Close and renumber cannot remove, replace, or move protected root/cwd FDs.
- A rejected duplicate mapping does not allocate or leak an FD.

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
