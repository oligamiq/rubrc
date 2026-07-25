# Rubrc

Rubrc runs a WebAssembly-hosted Rust toolchain directly inside a browser worker.

> **Note:** This project is under active pre-release development (v2.0). Some package metadata may still report older versions. It is a work in progress and is not yet ready for general production use. See `RELEASE.md` and the issue tracker for the current status.

**Live Demo:** [Rubrc](https://rubrc.pages.dev/) (v1 is available at [Rubrc v1](https://rubrc.pages.dev/v1/))

## Features

> [!WARNING]
> This project requires `Cross-Origin-Opener-Policy` (COOP) and `Cross-Origin-Embedder-Policy` (COEP) headers to function correctly. You must run it on a properly configured server.

- **Embedded Toolchain**: Run WebAssembly builds of `rustc`, Cargo, `clang`, and `llvm` directly inside the browser.
- **Cargo Support**: Basic library support is available (Note: external dependencies and procedural macros are currently unsupported).
- **Monaco-based Rust Editor**: Includes an embedded `rust-analyzer` language server for LSP functionality and diagnostics. Changes in the editor are synchronized into the virtual filesystem at `/src/main.rs`.
- **Advanced Terminal**: `xterm.js` terminal supporting pipes, multiple sessions, panels, and terminal paste support (Ctrl+V).
- **Custom VFS & Browser Bridge**: A Rust-based Virtual File System bridges the gap to the web. Includes a native `download` command to extract files from the VFS to your local machine, and supports dynamic target sysroot loading.

## Supported Targets
Executable files can currently be generated for the following tested targets:
- `wasm32-wasip1`
- `x86_64-unknown-linux-musl`

*Note: Other targets are known to fail during the linking process.*

## Usage Examples

- **rustc**: `rustc main.rs` *(Note: the embedded `rustc` command automatically appends `--sysroot /sysroot` unless explicitly provided).*
- **cargo**: `cargo build`
- **clang/llvm**: `clang file.c`
- **download**: `download /path/to/file` (Downloads a file from Rubrc's virtual filesystem to the browser. Directory downloads are not currently supported.)

## Architecture

Rubrc runs a WebAssembly-hosted Rust toolchain inside a browser worker. The frontend is a SolidJS application containing a Monaco-based Rust editor and xterm.js terminal interface.

The browser UI communicates with the worker through generated VFS bindings, SharedObject-based proxies, and an LSP transport. Browser-specific operations, including file downloads and additional sysroot loading, are handled through a narrow host bridge (e.g., `call_unknown_fn`).

The backend runtime is assembled with `wasi_virt_layer` from several embedded Wasm modules:
- **`vfs`**: Tool dispatch, virtual filesystem integration, module memory access, and browser host bridging.
- **`vfs-shell`**: Terminal sessions, shell parsing, pipes, and common shell commands.
- **Embedded Tools**: `rustc_opt`, `cargo_opt`, `llvm_opt`, and `lsp_opt` (rust-analyzer).

These modules are invoked directly by the VFS runtime instead of being launched as ordinary OS subprocesses. They retain separate Wasm memory spaces where required, and module boundaries use scalar arguments and explicit memory copies.

## Limitations & Known Issues

- **No OS Subprocesses**: There is no general OS subprocess model; toolchain commands are directly dispatched Wasm modules.
- **Serialized Execution**: While multiple terminal sessions are supported, compiler and Cargo invocations are currently serialized internally (via `CARGO_RUN_LOCK` and `RUSTC_RUN_LOCK`).
- **Singleton Language Server**: A single embedded rust-analyzer instance serves the Monaco editor. Starting another instance from the shell is prevented while the editor's language server is active.
- **Stability Issues**: Commands still occasionally throw errors that can render the session unusable.
- **Performance**: In original v2 development measurements, one tested workflow improved from approximately 61s down to 12s. Actual results depend heavily on the browser, hardware, cache state, and workload. Bugs and performance constraints still exist.

## Building and Running

**Prerequisites**: 
- [Bun](https://bun.sh/) and [Cargo](https://rustup.rs/) installed.
- The `wasi_virt_layer` CLI installed.
- A working `node` environment.
- Required prebuilt Wasm assets (`llvm_opt.wasm`, `rustc_opt.wasm`, `lsp_opt.wasm`, `cargo_opt.wasm`) present in `crates/vfs/`.

1. **Install dependencies**:
   ```bash
   bun install
   ```
2. **Compose VFS & Generate Bindings**:
   Compose the VFS runtime with the prebuilt toolchain modules and generate the TypeScript bindings used by the browser worker:
   ```bash
   bun run vfs:build
   ```
3. **Build the Application**:
   ```bash
   bun run build          # Development build (includes debug logging)
   bun run build:prod     # Production build
   ```

## Special Thanks

### Projects
- [rubri](https://github.com/LyonSyonII/rubri) by [LyonSyonII](https://github.com/LyonSyonII) - Used initially to run on the browser.
- [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) by [bjorn3](https://github.com/bjorn3)
- [browser_wasi_shim-threads](https://github.com/bjorn3/browser_wasi_shim/tree/main/threads#README) by [oligamiq](https://github.com/oligamiq)
- [rust_wasm](https://github.com/oligamiq/rust_wasm) by [oligamiq](https://github.com/oligamiq)

### People
- [bjorn3](https://github.com/bjorn3) - Created the foundation for compiling Rustc to WASI and managing linker relations.
- [oligamiq](https://github.com/oligamiq) - Created Rustc compiled with LLVM Backend to WASI.
- [whitequark](https://github.com/whitequark) - Created the LLVM to WASI.
- [rust-lang](https://github.com/rust-lang) - Created the Rust language.

## Funding
The core projects that this project depends on are all maintained by me (the author), including `browser_wasi_shim-threads`, `rust_wasm`, `shared-object`, and `toolchain-for-building-rustc`. I enabled the LLVM backend for rustc, and ultimately, I aim to make rustc executable in browsers that support WASM and allow cargo to run seamlessly on the web.

If you like or want to use this series of projects, I would appreciate it if you could contribute financially via the sponsor button or Buy Me a Coffee:

<a href="https://buymeacoffee.com/oligami" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 40px !important;width: 145px !important;" ></a>

## License
This project is licensed under the MIT OR Apache-2.0 License.
