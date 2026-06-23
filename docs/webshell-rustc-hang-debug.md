# WebShell rustc hang debug

Use this harness to reproduce and inspect repeated WebShell `rustc` executions
through the same VFS worker path.

```sh
bun run vfs:debug-rustc-twice
```

The script writes `test_debug.rs` to `/src/main.rs`, preopens
`test_workspace_rustc`, and runs:

```sh
rustc /src/main.rs --sysroot /sysroot --target wasm32-wasip1 -Clinker-flavor=wasm-ld -Clinker=wasm-ld
```

It runs the command twice by default. Override the defaults with:

```sh
VFS_DEBUG_RUNS=2 VFS_DEBUG_TIMEOUT_MS=60000 VFS_DEBUG_THREADS=2 bun run vfs:debug-rustc-twice
```

Sysroot setup:

- The expanded local sysroot at `test_workspace_rustc/sysroot` is removed on
  every run.
- The compressed archive is reused from
  `.rubrc-cache/sysroot/wasm32-wasip1.tar.br` when present.
- If the archive is missing, the harness downloads
  `https://oligamiq.github.io/rust_wasm/v0.2.0/wasm32-wasip1.tar.br`, stores it
  in `.rubrc-cache/sysroot/`, and extracts it into the rustc sysroot layout.
- `.rubrc-cache/` is ignored by git.

Important markers:

- `[vfs-debug-driver] run:N/M:enter ...`: driver sent the command to the
  WebShell.
- `[vfs-debug] command:start ...`: vfs-shell called into the VFS command bridge.
- `[vfs-debug] rustc:_reset:enter/return`: `rustc_opt::_reset` boundary.
- `[vfs-debug] rustc:_start:enter/return`: `rustc_opt::_start` boundary.
- `[vfs-debug] rustc:_main:enter/return`: `rustc_opt::_main` boundary.
- `[vfs-debug] command:return`: VFS command bridge returned to vfs-shell.
- `[vfs-debug-driver] run:N/M:return ...`: driver observed completion for that
  specific run.

If the second run hangs, the last emitted marker identifies the boundary that
did not return. For example, stopping after `run:2/2:enter` and
`rustc:_start:enter` means execution reached `rustc_opt::_start` on the second
run but did not return before timeout.

The harness uses the existing project WASI threads runtime. It does not add new
`Atomics` or `SharedArrayBuffer` usage.

## Fixed (no-shell) dispatch diagnostic

`scripts/test_rustc_fixed.ts` + `scripts/test_rustc_fixed_worker.ts` dispatch
`EVENT_TYPE_DEBUG_FIXED_RUSTC = 1007` directly through `root.dispatch`, bypassing
`vfs_shell_dispatch` (no session open, no char input). The Rust branch
(`crates/vfs/src/lib.rs`, `EVENT_TYPE_DEBUG_FIXED_RUSTC`) calls
`set_rustc_opt_args`, `rustc_opt::_reset()`, and `rustc_opt::_main()` with
`debug-rustc:` markers. Run it with:

```sh
VFS_DEBUG_TIMEOUT_MS=60000 deno run --no-lock -A scripts/test_rustc_fixed.ts
```

### 2026-06-23 run results

Both diagnostics were run back-to-back from a clean sysroot cache hit.

**No-shell (`test_rustc_fixed.ts`):**

```
Prepared test_workspace_rustc/sysroot from cache: .rubrc-cache/sysroot/wasm32-wasip1.tar.br

VFS test failed: CompileError: WebAssembly.compile(): Compiling function #227507 failed: br_table[0] expected type i32, found i64.load of type i64 @+335692682
```

Exit code 1. The worker terminated during `WebAssembly.compile(vfs.core.wasm)`
before any `dispatch` call. No `debug-rustc:` markers were emitted.

**Shell-based (`test_rustc_inspect.ts`, `VFS_DEBUG_RUNS=2`):**

```
Prepared test_workspace_rustc/sysroot from cache: .rubrc-cache/sysroot/wasm32-wasip1.tar.br

VFS test failed: CompileError: WebAssembly.compile(): Compiling function #227507 failed: br_table[0] expected type i32, found i64.load of type i64 @+335692682
```

Exit code 1. Identical failure point — the wasm module never instantiates, so
neither the shell path nor the fixed path is reached.

### Was the 2nd-run hang reproduced?

No. The 2nd-run hang could not be reproduced because `vfs.core.wasm` does not
compile. Both the no-shell and shell-based harnesses fail at
`WebAssembly.compile()` with the same error before any dispatch occurs. The last
emitted line in both runs is the sysroot preparation log; no `rustc:` or
`debug-rustc:` debug markers appear.

### Root-cause pointer: malformed wasm, not a dispatch hang

The compile failure is a genuine wasm validation error, not a V8 quirk.
`wasm-tools validate --features threads vfs.core.wasm` (an independent
Rust validator) reports the same defect:

```
error: func 227507 failed to validate
Caused by:
    0: type mismatch: expected i32, found i64 (at offset 0x1402438f)
```

Inspecting function #227507 with `rubrc-wasm-inspect` (range
`335689799..335693213`) shows the offending sequence at the reported offset:

```
0x1402438a: I64Load { memarg: MemArg { align: 3, offset: 304, memory: 0 } }
0x1402438e: Nop
0x1402438f: BrTable { targets: BrTable { count: 16, default: 55, targets: [...] } }
```

A `br_table` consumes its branch index from the stack, which must be `i32`. Here
the top of stack is an `i64` produced by the preceding `I64Load`, so validation
rejects the function. This is a codegen/type error in the ported
`rustc_opt`/`llvm_opt` body (function #227507 in a module with 227k+ functions),
not in the small `EVENT_TYPE_DEBUG_FIXED_RUSTC` dispatch arm added in
`crates/vfs/src/lib.rs` (that arm is a handful of `debug_trace` + function calls
and does not contain a `br_table`).

### What this tells us

1. The current `vfs.core.wasm` artifact (446 MB, rebuilt 2026-06-23 22:19) is
   invalid and cannot be instantiated by either Deno/V8 or `wasm-tools`. The
   2nd-run hang investigation is blocked until the wasm builds and validates.
2. The defect is a `br_table` fed an `i64` discriminant in function #227507,
   deep in the ported compiler code. It must be fixed (or the wasm rebuilt from
   a known-good toolchain/source revision) before either diagnostic can run.
3. Because neither harness reaches dispatch, the original question — "is the
   hang in the shell layer or below it in `rustc_opt`/WVL?" — remains
   unanswered. Once the wasm compiles, re-run both harnesses and compare the
   last marker before timeout as described above.
