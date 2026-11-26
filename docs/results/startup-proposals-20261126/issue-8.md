# # rustc hangs forever (no output, 0% CPU) when it needs more than 256 MiB: its region is fixed and allocation failures end LLVM's thread silently

https://github.com/oligamiq/rubrc/issues/8

## Summary

When rustc inside rubrc needs more than about 256 MiB of heap, it never finishes: no error, no exit code, and the
shell prompt never comes back. This happens, for example, when compiling a crate of about 1,400–7,700 lines at
`-Copt-level=0`. The same crates build at `-Copt-level=s` (which needs less memory), and native rustc 1.83 builds
them in a second or two.

As far as I can tell from the built module, there are two problems:

1. **rustc's memory region is reserved once per command at 4096 pages (256 MiB).** rustc's own `memory.grow`
   (its `sbrk`) fails with ENOMEM beyond the base of the next program's region, although the shared memory has
   plenty of room left (maximum 32775 pages in the JS, 65536 declared by the module).
2. **The failure is silent.** LLVM's codegen thread gets `bad_alloc` (in `-fno-exceptions` mode, so it aborts),
   the thread ends without any output, and rustc's codegen coordinator waits forever for its result. The
   command never returns.

Raising the reservation from 4096 to 8191 pages (a 6-constant binary patch, details below) makes these builds
finish in about 31–33 s.

## Environment

- rubrc from https://rubrc.pages.dev/ as of 2026-10-21: `assets/App-fTdpCUsO.js`,
  `assets/vfs.core-G3YEEGQv.wasm` (manifest: `originalSize` 384235902, `compressedSize` 55915173),
  sysroot `rust_wasm/v0.2.0/wasm32-wasip1.tar.br`. rustc 1.83.0-dev, LLD 19.
- The `producers` section of `vfs.core` says: rustc 1.98.0-nightly (c397dae80 2026-07-02),
  clang 22.1.0-wasi-sdk, wit-component 0.246.1, wit-bindgen-rust 0.55.0.
- Chromium 156 (headless, Playwright), macOS on Apple silicon.
- I run a self-hosted mirror of that build. It has small JS-only patches (hooks for terminal output and
  downloads, no rust-analyzer, sysroot from the same origin) that don't touch `vfs.core` or the workers.
  I haven't reproduced it on rubrc.pages.dev directly, but nothing in the analysis depends on the mirror.

## Reproduction

A generated, std-only crate (about 1,400 lines) is enough. Generator (Node):

```js
// node gen.mjs 100 lib.rs
import { writeFileSync } from "node:fs";
const [n, out] = [Number(process.argv[2]), process.argv[3]];
let src = "use std::collections::{BTreeMap, HashMap};\nuse std::fmt::Write;\n\n";
for (let i = 0; i < n; i++) {
    src += `pub fn f${i}(input: &[(String, u64)]) -> String {
    let mut by_key: HashMap<String, Vec<u64>> = HashMap::new();
    for (key, value) in input.iter().filter(|(k, _)| !k.is_empty()) {
        by_key.entry(format!("{}-{}", key, ${i})).or_default().push(value.wrapping_mul(${i + 1}));
    }
    let sorted: BTreeMap<_, _> = by_key.into_iter().map(|(k, v)| (k, v.iter().sum::<u64>())).collect();
    let mut out = String::new();
    for (k, v) in &sorted {
        let _ = write!(out, "{}={};", k.to_uppercase(), v);
    }
    out.chars().rev().filter(|c| c.is_alphanumeric()).take(${50 + (i % 30)}).collect()
}

`;
}
src += `#[no_mangle]\npub extern "C" fn run(seed: u64) -> usize {\n    let input = vec![("a".to_string(), seed)];\n    let mut total = 0;\n`;
for (let i = 0; i < n; i++) src += `    total += f${i}(&input).len();\n`;
src += "    total\n}\n";
writeFileSync(out, src);
```

Put the file into the VFS (for example as `/build1/src/lib.rs`) and run in rubrc's shell:

```
rustc /build1/src/lib.rs --sysroot /sysroot --target wasm32-wasip1 --crate-type cdylib --crate-name repro --edition 2021 -Copt-level=0 -Ccodegen-units=1 -Cpanic=abort --emit=obj -o /build1/repro.o
```

**Expected:** an object file after roughly 30 s, or an "out of memory" error.
**Actual:** after a while (here 30–55 s) the command waits forever: no output, no prompt, and the browser's CPU use drops
to 0%. With `-Copt-level=s` the same command finishes.

(With `n = 100` the native object file is about 3.7 MB; native rustc 1.83 needs about 1.2 s.)

## Analysis

The module has no name section, so the function numbers below refer to `vfs.core-G3YEEGQv.wasm` (the index
space includes the 40 imported functions; they match the `$funcN` names in Chrome DevTools). I named
functions through the panic locations and strings they reference.

### 1. It is a deadlock, not slow compilation

During the hang the Chromium processes use 0% CPU. Pausing every worker via the DevTools protocol shows
8 `thread_spawn` workers:

- 5 are idle in the thread pool (`$func825 < $func469 < $func460 < $func777 < wasi_thread_start`);
- 3 are rustc threads, all blocked in `__vfs_atomic_wait32` (via `$func199231`, std's futex wait):
  - rustc's main thread: `__wasip1_vfs_rustc_opt___main_void` → … → `$func89263`
    (rustc_codegen_ssa `back/write.rs`, `join_worker_thread` / `finish_ongoing_codegen`) → channel receive;
  - the codegen coordinator: `$func89174` (`back/write.rs:1439`, `start_executing_work`) → channel receive;
  - one more std thread waiting on a condvar (probably the jobserver helper).

There is no LLVM worker thread any more, so the coordinator waits for a result that never arrives.

### 2. The LLVM worker ran out of memory

A breakpoint on the failure branch of rustc's `sbrk` replacement (`$func195780`, offset `0xe8e6531`) fires
twice, in the LLVM worker thread, right before the hang. The failing thread's stack (selected frames):

```
$func195780   rustc's memory.grow replacement → returns -1, errno 48 (ENOMEM)
$func195741   malloc
$func89921    operator new → "bad_alloc was thrown in -fno-exceptions mode"
$func111579   SelectionDAG: "Instruction Selection and Scheduling", "DAG Combining 1", "Type Legalization", …
$func114333 / $func128968 / $func129010   LLVM pass manager (RunPass, OptFunction, OptModule)
$func88714    rustc_codegen_llvm back/write.rs:63 (object_file, "Bad FileType.")
$func89173    rustc_codegen_ssa codegen worker (codegen_module_optimize, …)
$func195497   std thread start
```

No JS exception or wasm trap reaches the debugger ("pause on all exceptions" stays quiet). The thread just ends.
I assume the abort is turned into a thread exit by the virt layer
(`__wasip1_virt_layer_rustc_opt_handle_thread_exit` / `…_set_unreachable_flag`), but I haven't traced that part.

### 3. Why the limit is 256 MiB

`$func195780` (rustc's `memory.grow`) does, in essence:

```
new_pages = own_pages (i32 at 1092148) + delta
limit     = (base of lsp_opt (i32 at 1092516) - base of rustc_opt (i32 at 1092528)) >> 16
if new_pages > limit: errno = 48; return -1
```

So rustc can grow only inside its region. The region itself is grown only in `$func583`, which runs once per
command (called via `$func70` from `vfs_execute_command`):

```
if own_pages (1092148) < 4096:
    grow rustc's region by (4096 - own_pages) pages      ; via $func251402, which moves lsp/cargo/shell up
```

Breakpoints on the six region-grow functions (`$func251400` … `$func251405`: host, llvm_opt, rustc_opt,
lsp_opt, cargo_opt, vfs_shell) confirm that during the whole failing compile only this one grow of rustc's
region happens, at the start of the command. Nothing grows the region when rustc's `sbrk` fails.

Raising the overall memory maximum (the `WebAssembly.Memory({ initial: 1032, maximum: 32775, shared: true })`
in `util_cmd-*.js`, up to the module's declared 65536) therefore makes no difference.

### 4. Measured peak

With the reservation raised to 8191 pages (below), I logged the page count after every successful `sbrk` of rustc:

| Crate | `-Copt-level=0` peak | Result with 4096 pages | Result with 8191 pages |
|---|---|---|---|
| Generated crate above (about 1,400 lines) | 6461 pages (404 MiB) | hangs | rustc 31 s |
| A real std-only crate (about 7,700 lines) | 4947 pages (309 MiB) | hangs | rustc 33 s (`-Copt-level=s`: 105 s) |

## Workaround (binary patch)

`$func583` contains `i32.const 4096` six times as 2-byte LEB128 (`41 80 20`): four for the reservation and two
for its error message. Replacing all six with 8191 (`41 ff 3f`) keeps the function's size, so nothing else in the
module changes. After repacking (brotli) and updating the manifest, both crates above build. The new
`compressedSize` also changes the IndexedDB cache key (`?etag=<compressedSize>`), so browsers load the patched
module.

8191 is simply the largest value with the same encoding length. It isn't a proposal for the right default.

## Suggestions

1. **Let rustc's region grow on demand.** When rustc's `sbrk` would exceed the region, grow the region (like
   `$func583` does at command start) instead of returning ENOMEM. Alternatives: a larger default, or making it
   configurable (an environment variable or a per-tool setting).
2. **Don't fail silently.** If a thread of a program aborts (or traps), end the whole command with an error and a
   message such as "memory allocation failed" instead of ending only that thread. Then the shell prompt comes back
   and the user sees what happened. Today it looks like a hang, and it takes a debugger to find out.

I'm happy to test a fix or provide more traces.

