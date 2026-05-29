# Design Spec: LSP Integration with monaco-languageclient

**Date:** 2026-05-29
**Status:** Draft
**Topic:** Integrating a WebAssembly-based Language Server (LSP) into the Rubrc environment using `monaco-languageclient`.

## 1. Background & Motivation
Rubrc currently provides a WebAssembly-based compiler and shell environment. To improve the developer experience, we want to integrate a Language Server Protocol (LSP) provider (e.g., `rust-analyzer` compiled to WASM) to provide features like autocomplete, go-to-definition, and diagnostics directly in the Monaco editor.

## 2. Scope & Impact
- **In-Scope:**
    - Integration of `lsp_opt.wasm` into the `vfs` Rust crate.
    - Implementing a communication bridge between Monaco (Main Thread) and the LSP (VFS Worker).
    - Setting up `monaco-languageclient` in the SolidJS frontend.
    - Synchronizing editor content with the VFS for the LSP to consume.
- **Out-of-Scope:**
    - Building the LSP WASM itself (assuming `lsp_opt.wasm` is already available).
    - Implementing advanced VSCode-specific features not supported by `monaco-languageclient`'s standard mode.

## 3. Proposed Solution: Embedded LSP Session (Approach 1)

The LSP will run as a persistent service within the existing VFS Web Worker. It will share the same virtualized filesystem as the compiler and shell.

### 3.1. Architecture Components

#### A. VFS Rust Layer (`crates/vfs`)
- **LSP Lifecycle:** The LSP is instantiated as a persistent module. It runs in a dedicated thread from the `THREAD_POOL`.
- **Virtual Pipes:**
    - **Stdin:** A thread-safe buffer that receives data from the `dispatch` function.
    - **Stdout/Stderr:** Intercepted writes that call `terminal_write` with a reserved `LSP_SESSION_ID`.
- **Linking:** `lsp_opt.wasm` is linked using `import_wasm!` and plugged into the filesystem.

#### B. Worker Bridge (`page/src/worker_process/util_cmd.ts`)
- **Multiplexing:** The worker differentiates between terminal traffic and LSP traffic based on the `sessionId`.
- **Reserved ID:** `LSP_SESSION_ID = 0xFFFFFFFF`.
- **Event Handling:**
    - Incoming `input_string` for `LSP_SESSION_ID` is dispatched to the VFS.
    - Outgoing `terminalWrite` for `LSP_SESSION_ID` is routed to a dedicated LSP message handler.

#### C. Frontend Layer (`page/src/`)
- **Monaco Environment:** Uses `@codingame/monaco-vscode-api` to provide a VSCode-compatible environment.
- **Language Client:** `monaco-languageclient` is configured with a custom `MessageReader` and `MessageWriter`.
- **Connection:** Uses the existing `SharedObject` system to send/receive JSON-RPC messages.

### 3.2. Data Flow
1. **Request:** Monaco -> `MessageWriter` -> `SharedObject (input_string)` -> Worker -> `dispatch` -> VFS -> LSP Stdin.
2. **Response:** LSP Stdout -> VFS -> `terminal_write` -> Worker -> `SharedObject (ls_id)` -> Monaco -> `MessageReader`.

## 4. Alternatives Considered
- **Dedicated Worker:** Rejected to avoid complex cross-worker VFS synchronization.
- **Virtualized Sidecar:** Rejected as it adds complexity to WASI pipe management without clear benefits over the embedded approach.

## 5. Implementation Plan (Phased)
- **Phase 1:** Rust-side integration of `lsp_opt.wasm` and basic pipe implementation.
- **Phase 2:** Worker-side routing and "Echo" test to verify communication.
- **Phase 3:** Frontend setup with `monaco-languageclient` and VSCode API.
- **Phase 4:** Content synchronization (writing editor changes to VFS).

## 6. Verification & Testing
- **Unit Tests:** Verify the virtual pipe implementation in the VFS crate.
- **Integration Test:** Verify that a `initialize` LSP request from the UI receives a valid response from the WASM LSP.
- **Manual Test:** Confirm autocomplete works in the Monaco editor.

## 7. Migration & Rollback
- The LSP feature will be gated behind a configuration flag or only enabled when the "Full Tools" feature is active.
- Rollback involves disabling the LSP initialization in the VFS and reverted UI changes to `solid-monaco`.
