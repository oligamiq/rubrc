# Performance: rustc_opt.wasm runs about 10× faster on plain WASI than inside rubrc (measurements)

https://github.com/oligamiq/rubrc/issues/9

## What this is

Not a bug report: I'd like to share some measurements in case they help with performance work. They are related to #8, which I opened yesterday.

I took rubrc's own `crates/vfs/rustc_opt.wasm` (commit 58a2d87, rustc 1.83.0-dev) and ran it **outside rubrc**, on a plain `wasm32-wasip1-threads` host: no wasi_virt_layer, the same V8 engine. For the same std-only crate (about 7,700 lines), the front end took 1.2 s instead of about 13 s, and a full `-Copt-level=0` build took 2.1 s instead of about 32 s. The result is correct: the backend I built this way answers 76,206 comparison requests exactly like one built inside rubrc.

So rustc 1.83 and WebAssembly seem fast enough; the time appears to go into the runtime layer. Your profiling on `ci/stdlib-cache-validation` found the same cost for rust-analyzer; this adds the numbers for rustc.

## Measurements

Same crate, same flags (`--target wasm32-wasip1 --crate-type cdylib --edition 2021 -Cpanic=abort --emit=obj`), macOS on Apple silicon, `-Ztime-passes`, seconds:

| Phase | Inside rubrc (Chromium 156) | `rustc_opt.wasm` on Node 26 | `rustc_opt.wasm` in Chromium 156 |
|---|---|---|---|
| `type_check_crate` | 4.97 | 0.57 | 0.52 |
| `MIR_borrow_checking` | 5.50 | 0.39 | 0.40 |
| Front end only (`--emit=metadata`) | about 13 | 1.27 | 1.19 |
| `codegen_crate` | 5.21 | 0.88 | – |
| `finish_ongoing_codegen` (LLVM) | 13.21 | 1.70 | – |
| Full build, `-Ccodegen-units=1` | 32.2 | 5.1 | – |
| Full build, `-Ccodegen-units=16` (`--out-dir`) | not measured | 4.3 | 2.1 (wall clock) |
| `llvm wasm-ld` (from `llvm_opt.wasm`) | 0.4–0.5 | 0.1 | 0.1 |

Inside rubrc, more codegen units did not help (at opt-level 1/2: 90 s with one unit, 102 s with more). Outside it, LLVM's worker threads clearly run in parallel. An `-Copt-level=2` build with 16 codegen units takes about 14 s outside rubrc, compared with about 130 s inside.

## Environment

- Inside rubrc: the build deployed on rubrc.pages.dev as of 2026-10-21 (`assets/App-fTdpCUsO.js`, `assets/vfs.core-G3YEEGQv.wasm`), sysroot `rust_wasm/v0.2.0/wasm32-wasip1.tar.br`, Chromium 156 headless (Playwright). Same setup as in #8.
- Outside: `crates/vfs/rustc_opt.wasm` and `llvm_opt.wasm` from the repository at 58a2d87836a1bcb46bafaecf4d03ca78e45db88c, with the same v0.2.0 sysroot.
  - On Node 26: `node:wasi` for the WASI calls, and `worker_threads` for `wasi.thread-spawn` (each thread gets its own instance on the shared `env.memory`, then calls `wasi_thread_start(tid, arg)`).
  - In Chromium: a small JS WASI runtime, one Web Worker per thread, and a file-system worker that the threads call synchronously through `SharedArrayBuffer` + `Atomics.wait`.
  - Neither host transforms the module.
- Caveat: the deployed `vfs.core` contains its own copy of rustc. I compared it with the `rustc_opt.wasm` from the repository (both 1.83.0-dev), not with identical bytes.

## How this relates to your profiling

I saw that `docs/startup-memory-root-cause.md` on `ci/stdlib-cache-validation` already identifies the per-access `__wasip1_vfs_memory_lock_read_acquire` / `_release` calls as the main cost in rust-analyzer. I see the same pattern in rustc's functions in `vfs.core-G3YEEGQv.wasm` (a call before and after each load/store, about 10 million call sites each), so these numbers are an end-to-end measurement of the same effect for rustc: without the layer, the front end is about 10× faster, a full build about 15×, and LLVM's threads run in parallel.

On the design options in that document: the host I used is one data point for the "relocation-free layout" option. Each program (rustc, wasm-ld) gets its own `WebAssembly.Memory`, so no other program's growth can move it and no access needs a lock. The file system lives in a separate worker, and a thread's file call copies its data through a small per-thread `SharedArrayBuffer` slot (with `Atomics.wait` / `notify`). The cost moves from every memory access to file I/O, which in rustc is small compared with the compute.

## A few other observations (same deployed build)

1. After one rustc panic, every later `rustc` in the same session panics at once ("lock was already held", `rustc_errors/src/lib.rs:957` or `rustc_span/src/hygiene.rs:376`) until the page is reloaded.
2. A crashing thread hangs the command instead of failing it (the allocation case is #8). Ending the whole command with an error when any thread traps or aborts would help.
3. `--crate-type rlib` with doc comments panics in pulldown-cmark (`strings.rs:70`, `Utf8Error { valid_up_to: 0 }`, during `resolver_for_lowering_raw`). `cdylib` is not affected. I haven't checked this outside rubrc.
4. `-Copt-level=2` with 16 codegen units needs more than 16 threads at once: with a pool of 16, rustc panicked with "failed to spawn work thread … WouldBlock"; 32 were enough. Only relevant if rubrc limits the thread count.
5. `-Cincremental` fails at once with "file locks not supported on this platform" (`rustc_data_structures::flock` uses its `unsupported` implementation on WASI). I patched that function in the binary as an experiment; then `create_dir_all` for the session directory succeeded in rubrc's VFS, but the following `read_dir` and `File::create` inside it returned ENOENT. I couldn't find out why without a tracing build.
6. rustc ends with a trap (`unreachable`) after reporting compile errors, not with exit code 1, so hosts have to treat "trap + error diagnostics" as a normal failed build.

## Thanks

rubrc made it possible to try Rust in the browser at all, and its rustc and LLVM builds are what made these measurements possible. If more details would help (exact flags, the disassembly, or how I set up threads on Node), I'm happy to add them.

## Comment by oligamiq at 2026-10-24T08:01:23Z

Thank you.

### A.

Could you provide more details about the measurements?

As I understand it, I agree that running a WASI module locally should be significantly faster.

The main reason is that implementing the WASI runtime in JavaScript introduces considerable overhead when crossing the boundary between JS and Wasm. This was the main reason why v1 of this project took around a minute to run. In v2, which uses `wasi_virt_layer`, we reduced that to approximately 13 seconds by moving most of the runtime into Wasm.

JavaScript functions called from Wasm must be synchronous, which is part of the problem. Although I've postponed addressing this, one idea for improving performance is to use ring buffers for stdout and similar streams.

For these reasons, I find it hard to believe that `rustc_opt.wasm in Chromium 156` is as fast as the results in `Measurements` suggest.

### B.

I think that would improve performance if we could implement it. However, Safari does not support Wasm multiple memories.

Since `wasi_virt_layer` itself already supports multiple memories, I believe adding an option to switch between the two modes in `rubrc` would improve performance.

### C.

**1, 2, and 6.**

Panic handling is quite complicated and involves performance trade-offs, so the implementation is not yet complete (some unexpected behavior remains).

However, I do want to ensure that a command failure does not affect the terminal session.

**3.**

I wasn't aware of this issue at all, so I don't know the details.

**4.**

Determining the appropriate thread pool size is tricky. The temporary workaround is to increase it.

It would also be possible to make the pool grow automatically by changing the `own-memory` flag in `wasi_virt_layer` and adjusting the code accordingly, but this would introduce additional memory access overhead.

**5.**

I vaguely remember that there was an older version in which `create_dir_all` failed, but nothing else comes to mind. I don't know the details.

---

I'm currently focusing on resolving the issue where `rust-analyzer` takes more than a minute to start. Once that is under control, I'd like to work on these issues as well.

Also, I'm sorry for the confusion, but please note that the version currently deployed on Pages is different from the code on the main branch.

## Comment by AnselmSchaefer at 2026-10-25T08:06:31Z

Thank you for the detailed answer!
                                                                                
Here is why I think the numbers are plausible. A JS WASI runtime costs time per WASI call, not per instruction. rustc makes few WASI calls: it reads the rlibs and sources in large chunks, writes a few files and prints little. Type checking, borrow checking and LLVM are pure computation inside the module and never cross into JS. This is also why Chromium and Node give almost the same numbers: both use V8 and run the unmodified module.                           
                                                                                
In vfs.core-G3YEEGQv.wasm, rustc's own funtions call __wasip1_vfs_memory_lock_read_acquire / _release around loads and stores (about 10 million call sites). That cost sits inside the computation itself. It would explain why type_check_crate (4.97 s vs. 0.52 s) and LLVM (13.2 s vs. 1.7 s) are both about 10× slower inside rubrc, even though neither phase does much I/O.                                                                     
                                                                                
The simplest check needs no JS runtime: run crates/vfs/rustc_opt.wasm with wasmtime (-W threads=y,shared-memory=y -S threads=y, sysroot mounted with --dir) and compare -Ztime-passes with rubrc for the same crate.               
                                                                                
On Safari: this layout doesn't need multiple memories. Each program is a normal instance with its own single memory, and the file system lives in a separate worker. So an option in rubrc to switch between the two modes sounds great to me.                                                                  
                                                                                
Thanks for the note about Pages vs. main. If you tell me which branch or commit to use, I can repeat the measurements against a local build of it once your rust-analyzer work is done.

