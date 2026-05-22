# Rubrc Project Overview

## Project Type
Code Project (Rust & TypeScript/JavaScript)

## Project Overview
Rubrc is a port of the `rustc` compiler to WebAssembly, designed to run directly in the browser using WASI (WebAssembly System Interface). The project includes a custom virtual file system (VFS) written in Rust, and uses LLVM for backend compilation.

Key targets: `wasm32-wasip1` and `x86_64-unknown-linux-musl`.

## Architecture & Workspaces
- **`/crates/vfs`**: The Rust-based virtual file system and mock implementations.
- **`/lib`**: Shared TypeScript/JavaScript library code.
- **`/page`**: The frontend web application (Vite, SolidJS, xterm.js) that runs the compiler in a web worker.

## Building and Running
The project uses `bun` as the primary package manager and task runner.
- **Build All**: `bun run build`
- **Build VFS**: `bun run vfs:build` (compiles the Rust VFS to WASI and prepares the TypeScript bindings).

## Development Conventions
- **Package Manager**: `bun` (and `cargo` for Rust).
- **Linter/Formatter**: `Biome` is used for JavaScript/TypeScript code formatting.
- **Commit Rule (`inst.ts`)**: When modifying `page/src/worker_process/vfs_bindings/inst.ts`, the changes **MUST** be committed with a `wip` message.

## `xterm.tsx` and `unknown_fn` Relationship
The WebAssembly `vfs` component makes host calls via a custom `call_unknown_fn` callback. This is passed down from the UI layer to the worker process.
- **`inst.ts`**: Defines `call_unknown_fn` to intercept specific WebAssembly component imports (e.g., `downloadFileStart`, `downloadFileChunk`, `sysrootStartFetch`).
- **`xterm.tsx`**: Provides the actual implementation of `unknown_fn`. It listens for these specific host calls (like "downloadFileStart" and "downloadFileChunk") to handle bridging between the WebAssembly worker and the browser's UI/downloads layer, aggregating chunks of data to perform actions like saving a file to the user's local filesystem.
- Even when `xterm.tsx` exposes `async` handlers, invocations routed through `inst.ts` and `call_unknown_fn` behave synchronously at the boundary visible to the WebAssembly component. Therefore, async operations on the UI side should be designed with care, especially when interacting with streaming or stateful resources.

# Commands added directly by the user
BE sure to COMPLY with and take this into account
- Do not use Atomics and SharedArrayBuffer
- There is no way you would run `bun run vfs:truebuild`
- Calling Rust functions from inside JavaScript functions that are invoked by Rust is prohibited.
- In WIT, the use of list is prohibited
- The file layer is split into two layers: one in Rust and one on the Web. File access in the VFS crate is reflected on the Web side, while file access in the vfs-shell crate is reflected in Rust-side file access.
