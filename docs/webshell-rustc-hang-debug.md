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
