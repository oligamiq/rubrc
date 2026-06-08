# LSP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a WebAssembly-based Language Server (LSP) into the Rubrc environment to provide autocomplete and diagnostics in the Monaco editor.

**Architecture:** The LSP (`lsp_opt.wasm`) will run as an embedded persistent service within the VFS Web Worker. Communication uses the existing `dispatch` (Main -> Worker) and `terminalWrite` (Worker -> Main) mechanisms with a reserved `LSP_SESSION_ID`.

**Tech Stack:** Rust (WASI), TypeScript (SolidJS), `monaco-languageclient`, `@codingame/monaco-vscode-api`.

---

### Task 1: Define LSP Constants and Types

**Files:**
- Modify: `page/src/worker_process/util_cmd.ts`
- Modify: `crates/vfs/src/lib.rs`

- [ ] **Step 1: Add LSP_SESSION_ID constant to JS worker**
Add `const LSP_SESSION_ID = 0xFFFFFFFF;` at the top of `page/src/worker_process/util_cmd.ts`.

- [ ] **Step 2: Add LSP_SESSION_ID and EVENT_TYPE_LSP to Rust VFS**
In `crates/vfs/src/lib.rs`, define:
```rust
const LSP_SESSION_ID: u32 = 0xFFFFFFFF;
const EVENT_TYPE_LSP: u32 = 6;
```

- [ ] **Step 3: Commit constants**
```bash
git add page/src/worker_process/util_cmd.ts crates/vfs/src/lib.rs
git commit -m "feat: define LSP session and event type constants"
```

### Task 2: Implement LSP Stdio Bridge in Rust

**Files:**
- Modify: `crates/vfs/src/lib.rs`
- Modify: `crates/vfs/src/shell.rs`

- [ ] **Step 1: Create thread-safe Stdin buffer for LSP**
In `crates/vfs/src/lib.rs`, add a lazy ring buffer for LSP input:
```rust
static LSP_STDIN: std::sync::LazyLock<parking_lot::Mutex<Vec<u8>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(Vec::new()));
```

- [ ] **Step 2: Update ShellVirtualStdIO to handle LSP output**
In `crates/vfs/src/lib.rs`, modify `ShellVirtualStdIO::write` to detect `LSP_SESSION_ID` and route to `bridge::Terminal::terminal_write`.

- [ ] **Step 3: Implement Stdin read for LSP**
In `crates/vfs/src/lib.rs`, modify `ShellVirtualStdIO::read` to pull from `LSP_STDIN` when the current session is `LSP_SESSION_ID`.

- [ ] **Step 4: Update dispatch to handle EVENT_TYPE_LSP**
In `crates/vfs/src/lib.rs`, update `dispatch` to push data into `LSP_STDIN` when `event_type == EVENT_TYPE_LSP`.

- [ ] **Step 5: Commit Rust bridge**
```bash
git add crates/vfs/src/lib.rs crates/vfs/src/shell.rs
git commit -m "feat: implement Rust-side LSP stdio bridge"
```

### Task 3: Link and Initialize LSP WASM

**Files:**
- Modify: `crates/vfs/src/lib.rs`

- [ ] **Step 1: Import LSP WASM module**
Add `import_wasm!(lsp_opt);` in `crates/vfs/src/lib.rs`.

- [ ] **Step 2: Plug LSP into virtualized layers**
Update `plug_fs!`, `plug_env!`, `plug_random!`, `plug_poll!`, `plug_thread!`, and `plug_clock!` to include `lsp_opt`.

- [ ] **Step 3: Spawn LSP thread on first dispatch**
In `dispatch`, if `session_id == LSP_SESSION_ID` and LSP isn't running, spawn a new virtual thread that calls `lsp_opt::main`.

- [ ] **Step 4: Commit LSP linking**
```bash
git add crates/vfs/src/lib.rs
git commit -m "feat: link and initialize lsp_opt.wasm"
```

### Task 4: Worker-side Message Routing

**Files:**
- Modify: `page/src/worker_process/util_cmd.ts`

- [ ] **Step 1: Add LSP message handler to terminalWrite callback**
Intercept messages with `sessionId === LSP_SESSION_ID` and route them to a new `SharedObject` for the LSP.

- [ ] **Step 2: Add input_string handler for LSP**
Ensure `input_string` SharedObject correctly passes `LSP_SESSION_ID` and the new `EVENT_TYPE_LSP` to `vfs_root.dispatch`.

- [ ] **Step 3: Commit worker changes**
```bash
git add page/src/worker_process/util_cmd.ts
git commit -m "feat: route LSP messages in worker process"
```

### Task 5: Frontend Dependencies and Setup

**Files:**
- Modify: `page/package.json`
- Modify: `page/src/App.tsx`

- [ ] **Step 1: Install monaco-languageclient and VSCode API**
Run: `bun add monaco-languageclient @codingame/monaco-vscode-api` in `page/`.

- [ ] **Step 2: Initialize VSCode API in App.tsx**
Import and call `initialize` from `@codingame/monaco-vscode-api` before editor mount.

- [ ] **Step 3: Commit dependencies**
```bash
git add page/package.json page/src/App.tsx
git commit -m "chore: add monaco-languageclient dependencies"
```

### Task 6: Implement LSP Connection Bridge

**Files:**
- Create: `page/src/lsp_bridge.ts`

- [ ] **Step 1: Implement MessageReader and MessageWriter**
Create a bridge that uses `SharedObject` to communicate with the worker's LSP session.

- [ ] **Step 2: Export createLspConnection function**
Provide a way to instantiate the language client with this bridge.

- [ ] **Step 3: Commit bridge implementation**
```bash
git add page/src/lsp_bridge.ts
git commit -m "feat: implement LSP connection bridge"
```

### Task 7: Enable Language Client in UI

**Files:**
- Modify: `page/src/App.tsx`

- [ ] **Step 1: Instantiate LanguageClient on editor mount**
In `handleMount`, call the bridge to start the LSP client for the Rust language.

- [ ] **Step 2: Sync editor changes to VFS**
Ensure `handleEditorChange` writes the updated content to the VFS path that the LSP expects (e.g., `/tmp/main.rs`).

- [ ] **Step 3: Commit UI integration**
```bash
git add page/src/App.tsx
git commit -m "feat: enable language client in Monaco editor"
```
