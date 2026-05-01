# Implementation Plan: Integrate Rust VFS, Flush Mechanisms, and Fully Embedded Command Execution

## Objective
Fully utilize the `vfs` Rust crate with `StandardDynamicFileSystem` as the core file system.
We will move the entire command parsing and execution logic into Rust. Per user request, **all existing Wasm tools (`lsr`, `tre`, `rustc`, and `clang`) will be embedded directly into the Rust VFS layer using `import_wasm!`**. This means Rust will natively execute not only `ls` and `tree`, but also `rustc` and `clang`, without returning control to TypeScript for their execution.
We will use the bulk flush functions (`flush-to-vfs` and `flush-from-vfs`) to synchronize the state between the TS environment and the Rust VFS.

## Key Files & Context
- `crates/vfs/wit/mai.wit`: Interface definition.
- `crates/vfs/src/lib.rs`: Rust implementation of VFS, global state management, flush logic, and `run_command` logic incorporating all tools.
- `page/src/cmd_parser.ts`: Refactored to delegate parsing to Rust and handle the pre/post flush operations.
- `page/src/worker_process/util_cmd.ts`: TS logic to use generated bindings and execute external/dynamic commands.

## Implementation Steps

### 1. Update WIT Interface
Modify `crates/vfs/wit/mai.wit` to expose the `file-entry` record, flush functions, and the command parser. Since `rustc` and `clang` are now handled natively, they are removed from the `command-request` variant:
```wit
package hello:host;

world init {
  record file-entry {
    path: string,
    content: list<u8>,
  }

  // Instructs TS how to proceed after Rust parses a command
  variant command-request {
    handled, // Rust executed it internally (ls, tree, echo, rustc, clang, llvm)
    download(string),
    exec-file(tuple<string, list<string>>), // path, args
    not-found(string),
  }

  export flush-to-vfs: func(files: list<file-entry>);
  export flush-from-vfs: func() -> list<file-entry>;
  export run-command: func(args: list<string>) -> command-request;

  export init: func();
  export main: func();
}
```

### 2. Implement Rust Logic
Update `crates/vfs/src/lib.rs`:
- **Embed All Wasms:** Add `import_wasm!(rustc);` and `import_wasm!(clang);` alongside `lsr` and `tre`.
- **Update Macros:** Include all imported wasms in `plug_fs!`, `plug_env!`, `plug_process!`, `plug_args!`, and `wrap_unreachable!`:
  - `plug_fs!(get_vfs(), lsr, tre, rustc, clang);`
- **Flush Mechanisms:**
  - `flush_to_vfs`: Recreate directories via `add_dir` and write data using `add_file` or update content.
  - `flush_from_vfs`: Traverse the VFS recursively, converting all file nodes into a `Vec<file-entry>` and returning it.
- **Command Parser (`run_command`):**
  - Execute `ls` and `tree` using `lsr::_start() / _main()` and `tre::_start() / _main()`.
  - Execute `rustc` using `rustc::_start() / _main()`.
  - Execute `clang`, `llvm`, and `llvm_tools` using `clang::_start() / _main()`.
  - For `echo`, print directly.
  - Return `handled` for all the above.
  - For `download` and file paths (`/`), return the respective variants.

### 3. Build & Bindings (`wasi_virt_layer` CLI)
- **Preparation:** Ensure `rustc.wasm` and `clang.wasm` are available locally before building, as `wasi_virt_layer` will need to bundle them. We may need to download them via a pre-build script.
- **Build Script:** Run `cargo wasi_virt_layer build` in `crates/vfs`.
- Copy the generated JS bindings and the (now much larger) bundled Wasm from the output `dist` folder into `page/src/worker_process/vfs_bindings/`.

### 4. Refactor TypeScript
- **State Synchronization (The "Flush" Lifecycle):**
  - **Before Command Execution:** Extract valid `WASIFarmAnimal` files into an array of `file-entry` objects, call `flushToVfs(files)`.
  - **Execute Command:** TS calls `runCommand(args)` from the bindings. Since `rustc` and `clang` are handled internally, TS just waits for the call to finish.
  - **After Command Execution:** Call `flushFromVfs()`. TS updates its `WASIFarmAnimal` memory with any new/modified files (like compiled `.wasm` outputs from `rustc`).
- **Command Parser:** Refactor `cmd_parser.ts` to coordinate this flush lifecycle and handle the remaining external `command-request` variants (`download`, `exec-file`).
- **Worker Cleanups:** Remove now-redundant network fetching and manual instantiation logic for `rustc.wasm` and `clang.wasm` in TS (`rustc.ts`, `llvm.ts`).

## Verification & Testing
- Download `rustc.wasm` and `clang.wasm` locally and run the build script.
- Verify `flush_to_vfs` maps TS files into the Rust VFS.
- Run `ls`, `tree`, `rustc`, and `clang` natively in Rust; verify they reflect synced files and correctly execute using the embedded Wasms.
- Confirm compiled outputs from `rustc` are successfully extracted back to TS via `flush_from_vfs`.
