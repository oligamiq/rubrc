# Embedded Rustc Virtual Cwd Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route embedded `rustc_opt` relative filesystem operations through Cargo's Rust-side virtual cwd so `cargo add hello` followed by `cargo build -j 1` succeeds in one WebShell session.

**Architecture:** Wrap the existing shared `StandardDynamicFileSystem` in a rubrc-owned `CwdAwareFileSystem`. The wrapper retains root identity, installs a temporary directory FD plus explicit argv-derived root-path hints keyed by the embedded target's `TypeId`, holds routing locks through inner calls, and restores the mapping through RAII. `wasi_ext_spawn` prepares the complete local rustc argv, extracts hints before libc destroys absolute intent, validates cwd before changing global invocation state, and runs rustc while the guard is alive.

**Tech Stack:** Rust, `wasi_virt_layer` dynamic filesystem APIs, `parking_lot::RwLock`, Deno TypeScript E2E harness, Bun build scripts.

## Global Constraints

- Change rubrc only.
- Do not modify `wasi_virt_layer`, browser shim libraries, Cargo, rustc artifacts, or build-script execution.
- Continue using the shared `StandardDynamicLFS` and global open-FD table.
- Preserve absolute paths, explicit directory FDs, and unmapped target behavior.
- Use `TypeId`, not `Wasm::NAME`, as target identity.
- Hold the cwd mapping lock through every routed path call and protected close/renumber mutation.
- Serialize temporary cwd allocation, `path_open_raw`, and renumbering with one FD-allocation mutex.
- Reserve FD `u32::MAX`; return `ERRNO_MFILE` instead of allowing `next_fd` to wrap.
- Return `wasip1::ERRNO_NOTCAPABLE` for attempts to close or renumber the root FD or an active cwd FD.
- Treat an empty cwd as a no-op that preserves root routing and allocates no mapping or FD; reject invalid non-empty UTF-8, unsupported prefixes, root escapes, missing components, symlink components, and non-directory components.
- Treat `/` as a no-allocation guard only after rejecting an existing mapping for the same target.
- Restore cwd mapping, temporary FD, environment, arguments, output capture, and child stdio on every exit path.
- The acceptance sequence is exactly `cargo add hello` then `cargo build -j 1` in one retained VFS session.
- Require the standalone `--vfs-unwind` flag on `vfs:build`, `vfs:build:prod`,
  and `vfs:build-debug` so the outer VFS can unwind to its panic handler and
  return status `101`.
- Do not add `--wasm-unwind`; embedded target artifacts remain unchanged. This
  is root build configuration, not a rustc or Cargo artifact source change.

## File Structure

- Modify `crates/vfs/src/lib.rs`: define the wrapper and guard, delegate/intercept WASI filesystem methods, construct the wrapped global filesystem, integrate cwd validation into rustc spawn, and add focused Rust tests.
- Modify `package.json`: enable `--vfs-unwind` for development, production, and debug VFS builds.
- Add `scripts/vfs_unwind_config_test.ts`: parse root `package.json` and enforce the standalone flag on all three VFS build commands.
- Use `scripts/vfs_debug_cargo_add_test.ts` unchanged to run the two-command acceptance sequence and assert registry-cwd compilation and prompt recovery.
- Do not modify `scripts/vfs_debug_cargo_pipe_test.ts`: use it unchanged as local-workspace regression coverage.

---

### Task 1: Target-Aware Filesystem Wrapper

**Files:**
- Modify: `crates/vfs/src/lib.rs:1-8,720-760`
- Test: `crates/vfs/src/lib.rs` in a new `cwd_aware_fs_tests` module before the existing `http_tests` module

**Interfaces:**
- Consumes: the existing concrete `StandardDynamicFileSystem<LFS>`, `StandardDynamicLFS`, `WasmAccess`, `WasmAccessName`, `WasmPathAccess`, `InodeId`, and raw WASI filesystem method signatures.
- Produces: `CwdAwareFileSystem<F>`, `TargetCwdGuard<'a, F>`, `CwdAwareFileSystem::new(inner, root_inode, root_fd)`, and `enter_target_cwd::<Wasm>(&[u8], Vec<Vec<String>>) -> Result<TargetCwdGuard<'_, F>, String>`.

- [ ] **Step 1: Add direct-memory target types and a fresh filesystem fixture**

Add test-only target types with host-pointer memory behavior. Give `MappedWasm` and `SameNameWasm` the same `NAME` to prove that routing uses `TypeId`.

```rust
#[cfg(test)]
mod cwd_aware_fs_tests {
    use super::*;
    use std::sync::{LazyLock, mpsc};
    use std::time::Duration;
    use wasi_virt_layer::memory::{WasmAccessName, WasmAccessRaw};

    macro_rules! direct_memory_wasm {
        ($name:ident, $display_name:literal) => {
            #[derive(Debug)]
            struct $name;

            impl WasmAccessName for $name {
                const NAME: &'static str = $display_name;
            }

            impl WasmAccessRaw for $name {
                fn memcpy_raw(offset: *mut u8, src: *const u8, len: usize) {
                    unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
                }

                fn memcpy_to_raw(offset: *mut u8, src: *const u8, len: usize) {
                    unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
                }

                fn _main_raw() -> wasip1::Errno { wasip1::ERRNO_SUCCESS }
                fn _reset_raw() {}
                fn _start_raw() {}

                fn memory_director_raw(ptr: isize) -> isize { ptr }
            }
        };
    }

    direct_memory_wasm!(MappedWasm, "same-name");
    direct_memory_wasm!(SameNameWasm, "same-name");
    direct_memory_wasm!(UnmappedWasm, "unmapped");

    type TestLfs = StandardDynamicLFS<ShellVirtualStdIO>;
    type TestFs = CwdAwareFileSystem<StandardDynamicFileSystem<TestLfs>>;

    struct Fixture {
        fs: TestFs,
        root_fd: Fd,
        explicit_fd: Fd,
    }

    fn fixture() -> Fixture {
        let lfs = TestLfs::new();
        let root = lfs.add_preopen(".");
        lfs.add_file(root, "shared.txt", b"root".to_vec()).unwrap();
        let cwd = lfs.add_dir(root, "cwd").unwrap();
        lfs.add_file(cwd, "shared.txt", b"cwd-value".to_vec()).unwrap();
        lfs.add_dir(cwd, "source").unwrap();
        lfs.add_dir(cwd, "destination").unwrap();
        let explicit = lfs.add_dir(root, "explicit").unwrap();
        lfs.add_file(explicit, "shared.txt", b"explicit-value".to_vec()).unwrap();
        lfs.add_file(root, "plain-file", Vec::new()).unwrap();
        lfs.add_symlink(root, "symlink-to-cwd", "cwd").unwrap();

        let inner = StandardDynamicFileSystem::new(lfs);
        let root_fd = inner.add_fd(root, !0, !0);
        let explicit_fd = inner.add_fd(explicit, !0, !0);
        Fixture {
            fs: CwdAwareFileSystem::new(inner, root, root_fd),
            root_fd,
            explicit_fd,
        }
    }

    fn stat_size<Wasm: WasmAccess + WasmAccessName + 'static>(
        fs: &TestFs,
        fd: Fd,
        path: &[u8],
    ) -> u64 {
        let mut stat: wasip1::Filestat = unsafe { std::mem::zeroed() };
        assert_eq!(
            fs.path_filestat_get_raw::<Wasm>(
                fd,
                wasip1::LOOKUPFLAGS_SYMLINK_FOLLOW,
                path.as_ptr(),
                path.len(),
                &mut stat,
            ),
            wasip1::ERRNO_SUCCESS,
        );
        stat.size
    }
```

- [ ] **Step 2: Write failing routing tests**

Add tests with these exact assertions. Use file sizes `4`, `9`, and `14` to distinguish root, cwd, and explicit-directory results.

```rust
#[test]
fn routes_only_relative_root_fd_paths_for_the_mapped_target() {
    let fixture = fixture();
    let guard = fixture.fs.enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new()).unwrap();
    assert_eq!(stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"), 9);
    assert_eq!(stat_size::<UnmappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"), 4);
    assert_eq!(stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"/shared.txt"), 4);
    assert_eq!(stat_size::<MappedWasm>(&fixture.fs, fixture.explicit_fd, b"shared.txt"), 14);
    drop(guard);
}

Add focused tests proving that an explicit `sysroot` hint preserves root routing despite a colliding cwd directory, an exact absolute source hint under cwd stays root-based, plain `src/lib.rs` still routes through cwd, and a relative path beginning with the cwd directory name is not root-based without a hint. Add a pure `rustc_root_path_hints` test covering standalone source, forced `--sysroot`, `--out-dir`, `-Ldependency=`, `--extern=name=`, comma-delimited `--emit`, and `@/response` forms, plus normalization, root-escape rejection, and deduplication.

#[test]
fn target_identity_does_not_depend_on_display_name() {
    let fixture = fixture();
    let _guard = fixture.fs.enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new()).unwrap();
    assert_eq!(stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"), 9);
    assert_eq!(stat_size::<SameNameWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"), 4);
}

#[test]
fn link_and_rename_route_both_directory_path_pairs() {
    let fixture = fixture();
    let _guard = fixture.fs.enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new()).unwrap();
    let source = b"shared.txt";
    let link = b"linked.txt";
    assert_eq!(
        fixture.fs.path_link_raw::<MappedWasm>(
            fixture.root_fd,
            0,
            source.as_ptr(),
            source.len(),
            fixture.explicit_fd,
            link.as_ptr(),
            link.len(),
        ),
        wasip1::ERRNO_SUCCESS,
    );
    let renamed = b"source/renamed.txt";
    assert_eq!(
        fixture.fs.path_rename_raw::<MappedWasm>(
            fixture.explicit_fd,
            link.as_ptr(),
            link.len(),
            fixture.root_fd,
            renamed.as_ptr(),
            renamed.len(),
        ),
        wasip1::ERRNO_SUCCESS,
    );
    assert_eq!(stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, renamed), 9);
}
```

Add lifecycle and descriptor tests before production code as part of the same RED phase:

```rust
#[test]
fn empty_cwd_is_a_no_op_that_preserves_root_routing() {
    let fixture = fixture();
    let next_fd = fixture.fs.next_fd.load(Ordering::SeqCst);
    let fd_count = fixture.fs.fd_map.len();
    let guard = fixture.fs.enter_target_cwd::<MappedWasm>(b"", Vec::new()).unwrap();
    assert!(guard.target_id.is_none());
    assert!(guard.cwd_fd.is_none());
    assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), next_fd);
    assert_eq!(fixture.fs.fd_map.len(), fd_count);
    assert!(!fixture.fs.target_cwds.read().contains_key(&TypeId::of::<MappedWasm>()));
    assert_eq!(stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"), 4);
}

#[test]
fn rejects_invalid_cwd_without_allocating_an_fd() {
    for cwd in [
        b"/missing".as_slice(), b"/plain-file", b"/../escape",
        b"/symlink-to-cwd", &[0xff],
    ] {
        let fixture = fixture();
        let next_fd = fixture.fs.next_fd.load(Ordering::SeqCst);
        let fd_count = fixture.fs.fd_map.len();
        assert!(fixture.fs.enter_target_cwd::<MappedWasm>(cwd, Vec::new()).is_err());
        assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), next_fd);
        assert_eq!(fixture.fs.fd_map.len(), fd_count);
    }
}

#[test]
fn root_duplicate_drop_and_protected_descriptors_preserve_ownership() {
    let fixture = fixture();
    let initial_next = fixture.fs.next_fd.load(Ordering::SeqCst);
    let initial_count = fixture.fs.fd_map.len();
    drop(fixture.fs.enter_target_cwd::<MappedWasm>(b"/", Vec::new()).unwrap());
    assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), initial_next);
    assert_eq!(fixture.fs.fd_map.len(), initial_count);

    let guard = fixture.fs.enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new()).unwrap();
    let cwd_fd = fixture.fs.target_cwds.read()[&TypeId::of::<MappedWasm>()].cwd_fd;
    let next_after_first = fixture.fs.next_fd.load(Ordering::SeqCst);
    let count_after_first = fixture.fs.fd_map.len();
    assert!(fixture.fs.enter_target_cwd::<MappedWasm>(b"/", Vec::new()).is_err());
    assert!(fixture.fs.enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new()).is_err());
    assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), next_after_first);
    assert_eq!(fixture.fs.fd_map.len(), count_after_first);
    for fd in [fixture.root_fd, cwd_fd] {
        assert_eq!(fixture.fs.fd_close_raw::<MappedWasm>(fd), wasip1::ERRNO_NOTCAPABLE);
        assert_eq!(fixture.fs.fd_renumber_raw::<MappedWasm>(fd, 100), wasip1::ERRNO_NOTCAPABLE);
        assert_eq!(fixture.fs.fd_renumber_raw::<MappedWasm>(100, fd), wasip1::ERRNO_NOTCAPABLE);
        assert!(fixture.fs.fd_map.contains_key(&fd));
    }
    drop(guard);
    assert!(!fixture.fs.fd_map.contains_key(&cwd_fd));
    assert_eq!(stat_size::<MappedWasm>(&fixture.fs, fixture.root_fd, b"shared.txt"), 4);
}

#[test]
fn renumber_onto_next_fd_leaves_allocation_to_skip_the_destination() {
    let fixture = fixture();
    let destination = fixture.fs.next_fd.load(Ordering::SeqCst);
    assert_eq!(
        fixture.fs.fd_renumber_raw::<MappedWasm>(fixture.explicit_fd, destination),
        wasip1::ERRNO_SUCCESS,
    );
    assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), destination);
    let guard = fixture.fs.enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new()).unwrap();
    let cwd_fd = fixture.fs.target_cwds.read()[&TypeId::of::<MappedWasm>()].cwd_fd;
    assert_eq!(cwd_fd, destination + 1);
    assert!(fixture.fs.fd_map.contains_key(&destination));
    assert!(fixture.fs.fd_map.contains_key(&cwd_fd));
    drop(guard);
}

#[test]
fn renumber_near_max_does_not_exhaust_low_fd_allocation() {
    let fixture = fixture();
    let initial_next = fixture.fs.next_fd.load(Ordering::SeqCst);
    let destination = u32::MAX - 1;
    assert_eq!(
        fixture.fs.fd_renumber_raw::<MappedWasm>(fixture.explicit_fd, destination),
        wasip1::ERRNO_SUCCESS,
    );
    assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), initial_next);
    assert!(fixture.fs.enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new()).is_ok());
    assert!(fixture.fs.fd_map.contains_key(&destination));
}

#[test]
fn descriptor_exhaustion_never_wraps_the_allocator() {
    let fixture = fixture();
    assert_eq!(
        fixture.fs.fd_renumber_raw::<MappedWasm>(fixture.explicit_fd, u32::MAX),
        wasip1::ERRNO_MFILE,
    );
    assert!(fixture.fs.fd_map.contains_key(&fixture.explicit_fd));

    fixture.fs.next_fd.store(u32::MAX, Ordering::SeqCst);
    assert!(fixture.fs.enter_target_cwd::<MappedWasm>(b"/cwd", Vec::new()).is_err());
    assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), u32::MAX);

    let path = b"new-file";
    let mut opened = 0;
    assert_eq!(
        fixture.fs.path_open_raw::<MappedWasm>(
            fixture.root_fd,
            0,
            path.as_ptr(),
            path.len(),
            wasip1::OFLAGS_CREAT,
            !0,
            !0,
            0,
            &mut opened,
        ),
        wasip1::ERRNO_MFILE,
    );
    assert_eq!(fixture.fs.next_fd.load(Ordering::SeqCst), u32::MAX);
}
```

Add one more assertion path for unprotected close: allocate an FD for a non-root inode, require `fd_close_raw::<MappedWasm>` to return `ERRNO_SUCCESS`, and require `fd_map` not to contain it afterward.

Add this deterministic routed-call race test. `BlockingWasm` consumes the one-shot channel control only on its first memory load, so later path bytes copy normally:

```rust
type RouteBlock = (mpsc::Sender<()>, mpsc::Receiver<()>);
static ROUTE_BLOCK: LazyLock<parking_lot::Mutex<Option<RouteBlock>>> =
    LazyLock::new(|| parking_lot::Mutex::new(None));

#[derive(Debug)]
struct BlockingWasm;

impl WasmAccessName for BlockingWasm {
    const NAME: &'static str = "blocking";
}

impl WasmAccessRaw for BlockingWasm {
    fn memcpy_raw(offset: *mut u8, src: *const u8, len: usize) {
        unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
    }

    fn memcpy_to_raw(offset: *mut u8, src: *const u8, len: usize) {
        let block = ROUTE_BLOCK.lock().take();
        if let Some((entered, release)) = block {
            entered.send(()).unwrap();
            release.recv().unwrap();
        }
        unsafe { std::ptr::copy_nonoverlapping(src, offset, len) };
    }

    fn _main_raw() -> wasip1::Errno { wasip1::ERRNO_SUCCESS }
    fn _reset_raw() {}
    fn _start_raw() {}
    fn memory_director_raw(ptr: isize) -> isize { ptr }
}

#[test]
fn routed_call_holds_lock_until_inner_dispatch_finishes() {
    let fixture = fixture();
    let guard = fixture.fs.enter_target_cwd::<BlockingWasm>(b"/cwd", Vec::new()).unwrap();
    let cwd_fd = fixture.fs.target_cwds.read()[&TypeId::of::<BlockingWasm>()].cwd_fd;
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *ROUTE_BLOCK.lock() = Some((entered_tx, release_rx));

    let (path_tx, path_rx) = mpsc::channel();
    let (drop_started_tx, drop_started_rx) = mpsc::channel();
    let (drop_finished_tx, drop_finished_rx) = mpsc::channel();
    let mut write_was_available = false;
    let mut drop_finished_early = false;

    std::thread::scope(|scope| {
        scope.spawn(|| {
            let path = b"shared.txt";
            let mut stat: wasip1::Filestat = unsafe { std::mem::zeroed() };
            let errno = fixture.fs.path_filestat_get_raw::<BlockingWasm>(
                fixture.root_fd,
                wasip1::LOOKUPFLAGS_SYMLINK_FOLLOW,
                path.as_ptr(),
                path.len(),
                &mut stat,
            );
            path_tx.send(errno).unwrap();
        });

        if let Err(error) = entered_rx.recv_timeout(Duration::from_secs(1)) {
            let _ = release_tx.send(());
            panic!("routed call did not inspect the path: {error}");
        }
        write_was_available = fixture.fs.target_cwds.try_write().is_some();
        scope.spawn(move || {
            drop_started_tx.send(()).unwrap();
            drop(guard);
            drop_finished_tx.send(()).unwrap();
        });
        let drop_started = drop_started_rx.recv_timeout(Duration::from_secs(1));
        if drop_started.is_ok() {
            drop_finished_early = drop_finished_rx
                .recv_timeout(Duration::from_millis(50))
                .is_ok();
        }
        let release_result = release_tx.send(());
        let path_result = path_rx.recv_timeout(Duration::from_secs(1));
        let drop_finished = if drop_started.is_ok() && !drop_finished_early {
            Some(drop_finished_rx.recv_timeout(Duration::from_secs(1)))
        } else {
            None
        };

        assert!(drop_started.is_ok());
        assert!(release_result.is_ok());
        assert_eq!(path_result.unwrap(), wasip1::ERRNO_SUCCESS);
        assert!(drop_finished.is_some_and(|result| result.is_ok()));
    });

    assert!(!write_was_available);
    assert!(!drop_finished_early);
    assert!(!fixture.fs.fd_map.contains_key(&cwd_fd));
}
```

- [ ] **Step 3: Run the routing tests to verify they fail**

Run:

```bash
cargo test -p vfs cwd_aware_fs_tests -- --nocapture
```

Expected: compilation fails because `CwdAwareFileSystem` and `enter_target_cwd` do not exist.

- [ ] **Step 4: Implement wrapper state, cwd traversal, and RAII cleanup**

Add imports for `TypeId`, `HashMap`, `Deref`, `WasmPathAccess`, and the WVL dynamic filesystem bounds. Use this concrete state and lifecycle:

```rust
#[derive(Debug)]
struct TargetCwdEntry {
    target_name: &'static str,
    cwd_fd: Fd,
    root_path_hints: Vec<Vec<String>>,
}

#[derive(Debug)]
pub struct CwdAwareFileSystem<F> {
    inner: F,
    root_inode: InodeId,
    root_fd: Fd,
    target_cwds: parking_lot::RwLock<HashMap<TypeId, TargetCwdEntry>>,
    fd_allocation: parking_lot::Mutex<()>,
}

impl<F> CwdAwareFileSystem<F> {
    fn new(inner: F, root_inode: InodeId, root_fd: Fd) -> Self {
        Self {
            inner,
            root_inode,
            root_fd,
            target_cwds: parking_lot::RwLock::new(HashMap::new()),
            fd_allocation: parking_lot::Mutex::new(()),
        }
    }
}

impl<F> Deref for CwdAwareFileSystem<F> {
    type Target = F;
    fn deref(&self) -> &Self::Target { &self.inner }
}

pub struct TargetCwdGuard<'a, F> {
    fs: &'a CwdAwareFileSystem<F>,
    target_id: Option<TypeId>,
    cwd_fd: Option<Fd>,
}
```

Keep the existing concrete `type LFS = StandardDynamicLFS<ShellVirtualStdIO>` alias immediately before these definitions. Implement `enter_target_cwd` for `CwdAwareFileSystem<StandardDynamicFileSystem<LFS>>`; this feature has one shared LFS/open-FD representation, so do not add unused generic bounds or a second filesystem abstraction.

The implementation must perform these operations in order:

1. Return a guard with `target_id: None` and `cwd_fd: None` for empty input without acquiring the mapping lock or allocating an FD.
2. Decode non-empty input with `std::str::from_utf8`; reject invalid UTF-8.
3. Normalize `Path::components()` for cwd traversal: ignore `RootDir` and `CurDir`, retain each `Normal` as an owned UTF-8 component, pop for `ParentDir`, reject an empty-stack pop, and reject `Prefix`.
4. Acquire `target_cwds.write()` before inspecting filesystem state, and retain it through traversal, duplicate checking, FD allocation, and insertion. This excludes wrapper-routed path mutations during validation; direct `.lfs` mutation callers do not rename or remove Cargo registry directories during the serialized rustc spawn path.
5. Reject an existing `TypeId::of::<Wasm>()` before handling normalized root.
6. Traverse from `self.root_inode` through `self.lfs.read_dir(inode)`, matching each normal UTF-8 component exactly. Check `self.lfs.metadata(child).filetype`; reject `FILETYPE_SYMBOLIC_LINK` and every type other than `FILETYPE_DIRECTORY`.
7. Return a guard with `target_id: None` and `cwd_fd: None` for normalized root.
8. Acquire `fd_allocation` after the mapping write lock, advance `inner.next_fd` past occupied `fd_map` keys, and reject with `"file descriptor table exhausted"` before `u32::MAX` can be allocated. Call `self.add_fd(inode, !0, !0)` exactly once, insert `TargetCwdEntry { target_name: Wasm::NAME, cwd_fd, root_path_hints }`, and return the active guard.

Implement `Drop` so an active guard acquires the write lock, removes the same `TypeId`, verifies the recorded FD matches, removes that FD while still locked, and leaves root no-op guards unchanged.

- [ ] **Step 5: Implement all `Wasip1FileSystem` methods**

Implement the trait for `CwdAwareFileSystem<StandardDynamicFileSystem<LFS>>`. Every method must use the exact WVL bound:

```rust
Wasm: WasmAccess + WasmAccessName + 'static
```

Add a routing helper that receives an already-held read guard. Normalize the guest's normal-component sequence through `WasmPathAccess::<Wasm>` without assuming guest pointers are host pointers. Keep the original root FD only when that sequence equals or descends from an active root-path hint; otherwise remap relative root-FD paths to cwd. Directly rooted, empty, and malformed paths keep the original FD so the inner filesystem owns their semantics; explicit directory FDs are unchanged. Remove the automatic cwd-prefix exception completely because a legitimate relative path can begin with the cwd directory name.

Document the unavoidable limitation: wasi-libc emits identical root-FD plus relative-byte calls for relative and absolute paths, so absolute paths not represented in argv cannot be preserved under the rubrc-only/no-WVL/no-artifact constraint.

`CwdAwareFileSystem` also carries a rubrc-owned workaround for the pinned WVL dynamic filesystem's append-only `fd_write_raw`. Although `fd_seek_raw` updates the descriptor cursor, WVL ignores it when writing. This breaks rustc's rlib/rmeta archive metadata backpatching and leaves corrupt metadata that the next rustc reports as E0786. The wrapper must delegate fd 0/1/2 unchanged and use the LFS `fd_pwrite_raw` guest-memory path at the current cursor for dynamic descriptors. Remove this override once the pinned WVL fixes `StandardDynamicFileSystem::fd_write_raw` to honor its cursor.

For all ten path methods, acquire one `target_cwds.read()` guard and retain it until the delegated inner call returns:

```text
path_create_directory_raw
path_filestat_get_raw
path_filestat_set_times_raw
path_link_raw
path_open_raw
path_readlink_raw
path_remove_directory_raw
path_rename_raw
path_symlink_raw
path_unlink_file_raw
```

Route both pairs independently in `path_link_raw` and `path_rename_raw`. Route only `(fd, new_path)` in `path_symlink_raw`; `old_path` remains unchanged link contents.

For `fd_close_raw`, hold the read lock through both the protected-FD scan and delegated close. For `fd_renumber_raw`, hold the mapping read lock, then `fd_allocation`, while checking source/destination and delegating. Return `wasip1::ERRNO_NOTCAPABLE` if `root_fd` or any active `cwd_fd` is involved. Return `wasip1::ERRNO_MFILE` when `to == u32::MAX`. Do not advance `inner.next_fd` after renumbering; `prepare_fd_allocation` skips any occupied candidate under `fd_allocation` immediately before each later cwd or path allocation.

For `path_open_raw`, hold the mapping read lock and then `fd_allocation` through allocator inspection and inner dispatch. Advance `next_fd` past occupied keys and return `ERRNO_MFILE` without calling the inner filesystem if the next value is `u32::MAX`. This lock order is mandatory everywhere: mapping lock first, allocation mutex second.

Delegate these nineteen methods directly with unchanged arguments and return values:

```text
fd_write_raw, fd_pwrite_raw, fd_advise_raw, fd_allocate_raw,
fd_datasync_raw, fd_sync_raw, fd_tell_raw, fd_fdstat_set_flags_raw,
fd_fdstat_set_rights_raw, fd_filestat_set_size_raw,
fd_filestat_set_times_raw, fd_readdir_raw, fd_prestat_get_raw,
fd_prestat_dir_name_raw, fd_filestat_get_raw, fd_fdstat_get_raw,
fd_read_raw, fd_pread_raw, fd_seek_raw
```

Use direct calls such as:

```rust
fn fd_sync_raw<Wasm: WasmAccess + WasmAccessName + 'static>(
    &self,
    fd: Fd,
) -> wasip1::Errno {
    self.inner.fd_sync_raw::<Wasm>(fd)
}
```

Do not add wrapper-side tracking for FDs returned by `path_open_raw`; the cwd FD is the only temporary descriptor owned by this wrapper.

- [ ] **Step 6: Wrap the global filesystem and retain root identity**

Change the static construction to retain both root inode and root FD:

```rust
pub static VIRTUAL_FILE_SYSTEM: std::sync::LazyLock<
    CwdAwareFileSystem<StandardDynamicFileSystem<LFS>>,
> = std::sync::LazyLock::new(|| {
    let lfs = StandardDynamicLFS::new();
    let root_inode = lfs.add_preopen(".");
    if let Ok(bin_inode) = lfs.add_dir(root_inode, "bin") {
        let _ = lfs.add_file(bin_inode, "cargo", b"#!/bin/sh\nexit 0\n".to_vec());
    }
    LFS_ROOT.store(root_inode, std::sync::atomic::Ordering::SeqCst);
    let vfs = StandardDynamicFileSystem::new(lfs);
    let root_fd = vfs.add_fd(root_inode, !0, !0);
    CwdAwareFileSystem::new(vfs, root_inode, root_fd)
});
```

Leave `plug_fs!(&*VIRTUAL_FILE_SYSTEM, ...)` and every existing `.lfs`, `.add_fd`, and `.remove_fd` caller unchanged; `Deref` preserves those accesses.

- [ ] **Step 7: Run routing tests and fix only wrapper defects**

Run:

```bash
cargo test -p vfs cwd_aware_fs_tests -- --nocapture
```

Expected: routing tests pass. Existing tests may still pass even though lifecycle edge cases are added in Task 2.

- [ ] **Step 8: Commit the wrapper foundation**

```bash
git add crates/vfs/src/lib.rs
git commit -m "feat(vfs): route embedded target paths from cwd"
```

---

### Task 2: Spawn Integration and State Restoration

**Files:**
- Modify: `crates/vfs/src/lib.rs:80-173,1044-1197`
- Test: `crates/vfs/src/lib.rs` in focused invocation-state tests

**Interfaces:**
- Consumes: `CwdAwareFileSystem::enter_target_cwd::<rustc_opt>`, `TargetCwdGuard`, `RUSTC_RUN_LOCK`, `VIRTUAL_SHELL_ENV`, `command::VIRTUAL_ARGS`, `CARGO_OUTPUT`, and `CHILD_PROCESS_STDIO`.
- Produces: `rustc_root_path_hints(&[String]) -> Vec<Vec<String>>`, validation-before-mutation rustc spawning, panic containment with status `101`, and unwind-safe restoration helpers for mutable invocation state.

- [ ] **Step 1: Write failing tests for invocation-state restoration**

Extract the mutable rustc invocation state into a small RAII owner used only after cwd validation. Add a focused invocation helper that owns that state and child stdio inside `std::panic::catch_unwind(std::panic::AssertUnwindSafe(...))`. Tests first acquire `RUSTC_RUN_LOCK`, seed non-default environment, args, output capture, and child stdio, then panic while the helper is active. Assertions inside each panic closure must prove replacement child stdio is installed before panic. One test starts with a sentinel `Some(ChildProcessStdio)` and asserts that exact prior state is restored. A second starts from `None` and asserts unwind restores `None`. Assert the outer `CARGO_OUTPUT.stdout` sentinel separately from child stdout, and assert bounded panic stderr plus status `101`.

Use exact sentinel values:

```rust
let sentinel_env = vec!["SENTINEL_ENV=1".to_string()];
let sentinel_args = vec!["sentinel-rustc".to_string()];
let sentinel_stdout = b"outer-output".to_vec();
let sentinel_cwd = b"/outer".to_vec();
```

Add this pure helper for cwd validation failure formatting and assert its returned stderr is bounded to `MAX_CHILD_ERROR_BYTES`, status is `1`, and constructing the error does not alter any of those sentinels:

```rust
fn bounded_rustc_cwd_error(cwd: &[u8], error: &str) -> Vec<u8> {
    let mut stderr = format!(
        "failed to set virtual cwd `{}`: {error}",
        String::from_utf8_lossy(cwd),
    ).into_bytes();
    stderr.truncate(MAX_CHILD_ERROR_BYTES);
    stderr
}
```

- [ ] **Step 2: Run restoration tests to verify they fail**

Run:

```bash
cargo test -p vfs invocation_state -- --nocapture
```

Expected: compilation fails because the invocation-state guard/helper does not exist, or the unwind test exposes current non-RAII restoration.

- [ ] **Step 3: Make child stdio and rustc invocation state unwind-safe**

Replace manual install/restore sequences with private guards. The child stdio guard must:

1. Save the previous `CHILD_PROCESS_STDIO` value and install the new one in its constructor.
2. Expose a finish method that drains current stdout/stderr and restores the previous value.
3. Restore the previous value in `Drop` if finish was not called.

The rustc invocation-state guard must:

1. Save and install `VIRTUAL_SHELL_ENV`, `command::VIRTUAL_ARGS`, and `CARGO_OUTPUT` only after cwd validation succeeds.
2. Restore all three in `Drop`.
3. Be declared after the cwd guard so Rust's reverse drop order restores invocation state before removing cwd routing.

Retain the existing successful output behavior of `with_child_process_stdio`; only replace its manual restoration internals with the child guard.

The invocation helper must preserve successful child stdout/stderr and `RUSTC_EXIT_STATUS`. If its closure panics, both guards restore while unwinding to the helper's catch point; the helper then returns empty stdout, bounded `embedded rustc panicked: ...` stderr, and status `101` instead of allowing a panic to reach `wasi_ext_spawn`'s `extern "C"` boundary.

- [ ] **Step 4: Integrate virtual cwd into `wasi_ext_spawn`**

After the non-rustc branch and `RUSTC_RUN_LOCK` acquisition:

```rust
argv.push("--sysroot".to_string());
argv.push("/sysroot".to_string());
argv.push("-Clinker-flavor=wasm-ld".to_string());
argv.push("-Clinker=wasm-ld".to_string());
let root_path_hints = rustc_root_path_hints(&argv);

if !cwd.is_empty() {
    debug_trace(&format!(
        "wasi-ext-spawn:virtual-cwd {}",
        String::from_utf8_lossy(&cwd)
    ));
}

let cwd_guard = match VIRTUAL_FILE_SYSTEM
    .enter_target_cwd::<rustc_opt>(&cwd, root_path_hints)
{
    Ok(guard) => guard,
    Err(error) => {
        let stderr = bounded_rustc_cwd_error(&cwd, &error);
        write_cargo_owned_spawn_result(
            Vec::new(), stderr, 1,
            out_exit_code, out_stdout_ptr, out_stdout_len,
            out_stderr_ptr, out_stderr_len,
        );
        return 0;
    }
};
```

The pure extractor recognizes absolute values at token start and after `=` or `@`, stops each comma-delimited joined or separate `--emit` value, normalizes to root-relative components, rejects root escapes/root-only values, and deduplicates. It does not read response files. Then call the panic-containing invocation helper, which installs the same prepared argv and child stdio around `run_rustc`. On success, preserve status/output. On panic, restore invocation/child state before returning bounded stderr and status `101`. Finally drop `cwd_guard` normally.

Delete `virtual_cwd_for_set_current_dir` and delete all use of outer `std::env::current_dir`, `std::env::set_current_dir`, and cwd restoration from the rustc spawn path. Do not change host cwd handling in `host_run_cargo`.

- [ ] **Step 5: Run Rust formatting and tests**

Run:

```bash
cargo fmt --all -- --check
cargo test -p vfs
```

Expected: formatting check passes and all VFS Rust tests pass, including routing, validation, descriptor protection, cleanup race, and invocation-state restoration.

- [ ] **Step 6: Commit spawn integration**

```bash
git add crates/vfs/src/lib.rs
git commit -m "fix(vfs): apply Cargo cwd to embedded rustc"
```

---

### Task 3: Registry Dependency Build Acceptance

**Files:**
- Modify: `scripts/vfs_debug_cargo_add_test.ts:1-154`
- Test: `scripts/vfs_debug_cargo_add_test.ts`
- Regression test unchanged: `scripts/vfs_debug_cargo_pipe_test.ts`

**Interfaces:**
- Consumes: the rebuilt VFS bindings containing Task 2 and existing `prepareCachedSysroot`, `buildPreopenDirectory`, HTTP bridge, child bridge, and retained shell worker.
- Produces: one-session acceptance coverage for registry extraction and rustc execution from `hello-1.0.4`'s virtual cwd.

- [ ] **Step 1: Strengthen the E2E first**

Replace the default command list with:

```ts
const commands = Deno.args.length === 0
  ? [
    ["cargo", "add", "hello"],
    ["cargo", "build", "-j", "1"],
  ]
  : [["cargo", ...Deno.args]];
```

Set `runs: commands.length`. Import `buildPreopenDirectory` and `prepareCachedSysroot`, remove the unused `Directory` and `PreopenDirectory` imports, prepare `./test_workspace_cargo_add/sysroot`, build the `/` preopen, remove the temporary host tree in `finally`, and set `filesystemRoot = preopen.dir`. Add `allocator_size: 100 * 1024 * 1024` to the farm options.

Replace the metadata assertion with all of these default-mode checks:

```ts
if (
  !/\[vfs-debug\] wasi-ext-spawn:virtual-cwd \/\.cargo\/registry\/src\/index\.crates\.io-[^/\s]+\/hello-1\.0\.4/.test(
    result.output,
  )
) {
  console.error("rustc did not receive the hello registry source cwd");
  Deno.exit(1);
}
if (!/Compiling hello v1\.0\.4/.test(result.output)) {
  console.error("Cargo did not compile hello v1.0.4");
  Deno.exit(1);
}
if (!result.output.includes("Finished `dev` profile")) {
  console.error("Cargo did not report a successful dev build");
  Deno.exit(1);
}
if (result.output.includes("failed to set cwd") || result.output.includes("failed to set virtual cwd")) {
  console.error("registry build failed to apply its virtual cwd");
  Deno.exit(1);
}
```

Keep the existing `Adding hello` check. Require both driver return markers and a prompt after the final `command:return`:

```ts
for (const marker of [
  "[vfs-debug-driver] run:1/2:return cargo add hello",
  "[vfs-debug-driver] run:2/2:return cargo build -j 1",
]) {
  if (!result.output.includes(marker)) {
    console.error(`missing retained-session marker: ${marker}`);
    Deno.exit(1);
  }
}
```

- [ ] **Step 2: Rebuild VFS bindings**

Run:

```bash
bun run vfs:build
```

Expected: the VFS wasm and generated bindings build successfully. Review generated diffs and retain only files normally tracked by this repository's VFS build workflow.

- [ ] **Step 3: Run the registry acceptance test**

Run:

```bash
deno run --no-lock -A scripts/vfs_debug_cargo_add_test.ts
```

Expected: `cargo add hello` returns, rustc receives the `hello-1.0.4` registry cwd, `Compiling hello v1.0.4` and `Finished dev profile` appear, no cwd error appears, the second command returns, and the shell prompt reappears.

- [ ] **Step 4: Run local workspace, Cargo, and bridge regressions**

Run:

```bash
deno test --no-lock -A scripts/vfs_unwind_config_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_run_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_info_test.ts
deno test --no-lock -A scripts/vfs_child_process_bridge_test.ts scripts/vfs_child_process_import_test.ts scripts/vfs_http_bridge_test.ts scripts/vfs_http_import_test.ts
cargo fmt --all -- --check
cargo test -p vfs
bun run --cwd lib build
bun run --cwd page build
bun run vfs:build:prod
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
cmp -s dist/vfs.core.wasm page/src/worker_process/vfs_bindings/vfs.core.wasm
git diff --check
```

Expected: the unwind configuration test, local workspace build, Cargo run/info,
child/HTTP bridge tests, Rust tests, both application builds, and the production
VFS build pass; both generated VFS wasm artifacts validate and are
byte-identical; formatting/diff checks report no errors. Build-script execution
remains intentionally untested and unchanged because it is outside the approved
scope.

- [ ] **Step 5: Inspect the final scope**

Run:

```bash
git status --short
git diff --stat HEAD~2
git diff HEAD~2 -- crates/vfs/src/lib.rs scripts/vfs_debug_cargo_add_test.ts
```

Expected: source changes are limited to the two planned files. `bun run vfs:build` may refresh ignored local artifacts for E2E execution, but no generated artifact is added to the commit. There are no changes under `wasi_virt_layer`, browser shim packages, Cargo/rustc wasm inputs, or build-script execution code. Existing unrelated untracked scratch files remain untouched.

- [ ] **Step 6: Commit the acceptance coverage**

Stage only the E2E source file and inspect the staged path before committing:

```bash
git add scripts/vfs_debug_cargo_add_test.ts
git diff --cached --name-only
git commit -m "test(vfs): build registry dependency from virtual cwd"
```

Expected staged path: only `scripts/vfs_debug_cargo_add_test.ts`. Never stage generated bindings, unrelated scratch files, or pre-existing user changes.

---

### Task 4: Outer VFS Panic Unwinding

**Files:**

- Modify `package.json`: add the standalone `--vfs-unwind` flag to
  `vfs:build`, `vfs:build:prod`, and `vfs:build-debug`.
- Add `scripts/vfs_unwind_config_test.ts`: enforce outer-module unwinding on
  all three VFS build commands without enabling embedded-target unwinding.
- Modify this plan and
  `docs/superpowers/specs/2026-07-17-embedded-rustc-cwd-design.md`: document
  the build and verification requirements.

- [ ] **Step 1: Add and run the focused configuration test first**

```bash
deno test --no-lock -A scripts/vfs_unwind_config_test.ts
```

Expected RED: `vfs:build must include standalone --vfs-unwind`.

- [ ] **Step 2: Enable unwind only for the outer VFS module**

Add `--vfs-unwind` to all development, production, and debug VFS build
commands. Do not add `--wasm-unwind`; rustc, Cargo, and every other embedded
target artifact remain unchanged.

- [ ] **Step 3: Run build and integration verification**

```bash
deno test --no-lock -A scripts/vfs_unwind_config_test.ts
bun run vfs:build
deno run --no-lock -A scripts/vfs_debug_cargo_add_test.ts
deno run --no-lock -A scripts/vfs_debug_cargo_add_test.ts build -j 1
deno run --no-lock -A scripts/vfs_debug_cargo_pipe_test.ts
bun run vfs:build:prod
wasm-tools validate dist/vfs.core.wasm
wasm-tools validate page/src/worker_process/vfs_bindings/vfs.core.wasm
cmp -s dist/vfs.core.wasm page/src/worker_process/vfs_bindings/vfs.core.wasm
deno fmt --check scripts/vfs_unwind_config_test.ts
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/usr/bin/clang cargo test -p vfs
cargo fmt -p vfs -- --check
git diff --check
```

Expected: RED/GREEN is recorded; development and production builds, all three
E2Es, config/Rust/format checks, and both wasm validations pass; the copied page
wasm is byte-identical to `dist/vfs.core.wasm`.

- [ ] **Step 4: Commit only the build-integration change**

```bash
git add package.json scripts/vfs_unwind_config_test.ts \
  docs/superpowers/specs/2026-07-17-embedded-rustc-cwd-design.md \
  docs/superpowers/plans/2026-07-17-embedded-rustc-cwd.md
git diff --cached --name-only
git commit -m "build(vfs): enable panic unwinding"
```

Expected staged paths: exactly the four files listed above. Do not stage WVL,
browser libraries, build-script execution, generated artifacts, or embedded
rustc/Cargo wasm inputs.
