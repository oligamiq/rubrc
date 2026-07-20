# Rust Source Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load and validate rust-src before reporting VFS readiness so the embedded rust-analyzer can publish and clear live diagnostics against a valid workspace.

**Architecture:** A dedicated VFS event starts a one-shot rust-src bootstrap in the shell session, separate from terminal input. The shell exposes a monotonic four-state result through the generated VFS binding; the worker reports a discriminated readiness result to the application, and the existing two-input LSP gate starts only after successful VFS bootstrap. The host archive loader has a bounded timeout, and the real integration test drives this production path with a cached rust-src archive.

**Tech Stack:** Rust, WIT/wit-bindgen, TypeScript, SolidJS, Deno tests, embedded rust-analyzer Wasm, `@oligami/browser_wasi_shim-threads`.

## Global Constraints

- Change rubrc only; do not modify rust-analyzer, Cargo, rustc, `wasi_virt_layer`, or browser shim artifacts.
- Keep `/sysroot/lib/rustlib/src/rust/library` as `sysroot_src` and require `core/src/lib.rs` before successful readiness.
- Keep `MonacoLanguageClient` as the owner of LSP synchronization and Monaco markers.
- Keep the application-level gate at two inputs: Monaco readiness and settled-successful VFS readiness.
- Preserve the existing WASIFarm async base-call contract: `unknown_fn` promises are awaited by the shared-array-buffer park before the guest import returns.
- Automatic bootstrap must be distinguishable from a manual `load_sysroot rust-src` command.
- Bootstrap state is one-shot and monotonic: `NotStarted -> Loading -> Ready | Failed`.
- A failed or timed-out host archive load must settle application startup without starting rust-analyzer.
- Do not add retries, silently remove `sysroot_src`, or add a third application readiness channel.
- Do not manually edit generated files under `page/src/worker_process/vfs_bindings/`; regenerate them with `bun run vfs:build`.
- Do not stage `crates/vfs/expanded.rs`, `deno.lock`, or `package-lock.json` while completing these tasks.
- Preserve the existing untracked `diff.patch`, `diff2.patch`, and `diff3.patch` files.

## File Structure

- Create `crates/vfs-shell/src/rust_src_bootstrap.rs`: side-effect-free monotonic bootstrap state machine.
- Modify `crates/vfs-shell/src/main.rs`: dedicated shell session event, shared loader invocation, validation, and scalar state export.
- Modify `crates/vfs/src/shell.rs`: scalar import for the shell state query.
- Modify `crates/vfs/src/lib.rs`: dedicated outer event routing and WIT state implementation.
- Modify `crates/vfs/wit/vfs-host.wit`: internal `rust-src-load-state` export.
- Regenerate `page/src/worker_process/vfs_bindings/vfs.js` and `vfs.d.ts` through the build.
- Create `page/src/sysroot_archive.ts`: bounded, side-effect-free rust-src archive loading.
- Create `page/src/sysroot_archive_test.ts`: archive success and timeout tests.
- Modify `lib/src/brotli_stream.ts`: pass an abort signal to uncached network fetches.
- Create `page/src/vfs_readiness.ts`: readiness result type and bootstrap polling.
- Create `page/src/vfs_readiness_test.ts`: success, failure, invalid-state, and ordering tests.
- Modify `page/src/worker_process/util_cmd.ts`: run bootstrap before reporting readiness.
- Modify `page/src/lsp_start_gate.ts`, `lsp_start_gate_test.ts`, and `App.tsx`: settle VFS failure without starting LSP.
- Modify `page/src/xterm.tsx`: use bounded archive loading and assign queues only after success.
- Modify `scripts/sysroot_cache.ts` and `sysroot_cache_test.ts`: cache rust-src archives without forcing target-sysroot extraction layout.
- Finish `scripts/vfs_lsp_diagnostics_test.ts` and `vfs_lsp_diagnostics_worker.ts`: production-path real diagnostics lifecycle test.

---

### Task 1: Monotonic Rust-Source Bootstrap State

**Files:**
- Create: `crates/vfs-shell/src/rust_src_bootstrap.rs`
- Modify: `crates/vfs-shell/src/main.rs:1-15`

**Interfaces:**
- Produces: `RustSrcLoadState::{NotStarted, Loading, Ready, Failed}` and `RustSrcBootstrap::{new, state, begin, finish}`.
- Consumes: only `std::sync::atomic`; no VFS, host bridge, or shell global state.

- [ ] **Step 1: Write the failing state-machine tests**

Create `crates/vfs-shell/src/rust_src_bootstrap.rs` with the tests first:

```rust
#[cfg(test)]
mod tests {
    use super::{RustSrcBootstrap, RustSrcLoadState};

    #[test]
    fn bootstrap_transitions_once_to_ready() {
        let state = RustSrcBootstrap::new();
        assert_eq!(state.state(), RustSrcLoadState::NotStarted);
        assert!(state.begin());
        assert_eq!(state.state(), RustSrcLoadState::Loading);
        state.finish(true);
        assert_eq!(state.state(), RustSrcLoadState::Ready);
        assert!(!state.begin());
        state.finish(false);
        assert_eq!(state.state(), RustSrcLoadState::Ready);
    }

    #[test]
    fn bootstrap_transitions_once_to_failed() {
        let state = RustSrcBootstrap::new();
        assert!(state.begin());
        state.finish(false);
        assert_eq!(state.state(), RustSrcLoadState::Failed);
        assert!(!state.begin());
        state.finish(true);
        assert_eq!(state.state(), RustSrcLoadState::Failed);
    }
}
```

Add `mod rust_src_bootstrap;` near the imports in `main.rs`.

- [ ] **Step 2: Run the test to verify RED**

Run: `rustc --edition=2021 --test crates/vfs-shell/src/rust_src_bootstrap.rs -o /tmp/opencode/rust_src_bootstrap_test && /tmp/opencode/rust_src_bootstrap_test`

Expected: FAIL because `RustSrcBootstrap` and `RustSrcLoadState` are undefined.

- [ ] **Step 3: Implement the minimal state machine**

Add above the tests in `rust_src_bootstrap.rs`:

```rust
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum RustSrcLoadState {
    NotStarted = 0,
    Loading = 1,
    Ready = 2,
    Failed = 3,
}

pub struct RustSrcBootstrap {
    state: AtomicU8,
}

impl RustSrcBootstrap {
    pub const fn new() -> Self {
        Self { state: AtomicU8::new(RustSrcLoadState::NotStarted as u8) }
    }

    pub fn state(&self) -> RustSrcLoadState {
        match self.state.load(Ordering::Acquire) {
            0 => RustSrcLoadState::NotStarted,
            1 => RustSrcLoadState::Loading,
            2 => RustSrcLoadState::Ready,
            3 => RustSrcLoadState::Failed,
            _ => unreachable!("invalid rust-src bootstrap state"),
        }
    }

    pub fn begin(&self) -> bool {
        self.state
            .compare_exchange(
                RustSrcLoadState::NotStarted as u8,
                RustSrcLoadState::Loading as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub fn finish(&self, ready: bool) {
        let target = if ready {
            RustSrcLoadState::Ready
        } else {
            RustSrcLoadState::Failed
        } as u8;
        let _ = self.state.compare_exchange(
            RustSrcLoadState::Loading as u8,
            target,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}
```

- [ ] **Step 4: Run tests and formatting**

Run: `rustc --edition=2021 --test crates/vfs-shell/src/rust_src_bootstrap.rs -o /tmp/opencode/rust_src_bootstrap_test && /tmp/opencode/rust_src_bootstrap_test && cargo fmt --check -p vfs-shell`

Expected: 2 focused tests PASS and formatting check PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/vfs-shell/src/main.rs crates/vfs-shell/src/rust_src_bootstrap.rs
git commit -m "test(vfs): define rust source bootstrap state"
```

---

### Task 2: Dedicated Guest Bootstrap Event And State Binding

**Files:**
- Modify: `crates/vfs-shell/src/main.rs:540-639,760-859`
- Modify: `crates/vfs/src/shell.rs:9-28`
- Modify: `crates/vfs/src/lib.rs:24-29,343-470`
- Modify: `crates/vfs/wit/vfs-host.wit:43-57`
- Create: `scripts/vfs_rust_src_bootstrap_test.ts`
- Regenerate: `page/src/worker_process/vfs_bindings/vfs.js`
- Regenerate: `page/src/worker_process/vfs_bindings/vfs.d.ts`

**Interfaces:**
- Consumes: Task 1 `RustSrcBootstrap` and `RustSrcLoadState`.
- Produces: outer event `EVENT_TYPE_BOOTSTRAP_RUST_SRC = 8`, shell event `BootstrapRustSrc = 6`, and generated JS method `rustSrcLoadState(): number`.

- [ ] **Step 1: Add a failing event and binding contract test**

Create `scripts/vfs_rust_src_bootstrap_test.ts`:

```ts
const shell = await Deno.readTextFile("crates/vfs-shell/src/main.rs");
const vfs = await Deno.readTextFile("crates/vfs/src/lib.rs");
const wit = await Deno.readTextFile("crates/vfs/wit/vfs-host.wit");

if (!shell.includes("BootstrapRustSrc = 6")) {
  throw new Error("dedicated shell bootstrap event is missing");
}
if (!shell.includes("vfs_shell_rust_src_load_state")) {
  throw new Error("shell bootstrap state export is missing");
}
if (!vfs.includes("EVENT_TYPE_BOOTSTRAP_RUST_SRC: u32 = 8")) {
  throw new Error("outer bootstrap event is missing");
}
if (!wit.includes("export rust-src-load-state: func() -> u32;")) {
  throw new Error("WIT bootstrap state export is missing");
}
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `deno run --allow-read scripts/vfs_rust_src_bootstrap_test.ts`

Expected: FAIL with `dedicated shell bootstrap event is missing`.

- [ ] **Step 3: Add the dedicated shell event and bootstrap execution**

In `main.rs`, add `BootstrapRustSrc = 6` to `SessionEventType`, add the matching `SessionEvent` variant and `from_raw` arm, and define:

```rust
const RUST_SRC_CORE: &str = "/sysroot/lib/rustlib/src/rust/library/core/src/lib.rs";
static RUST_SRC_BOOTSTRAP: rust_src_bootstrap::RustSrcBootstrap =
    rust_src_bootstrap::RustSrcBootstrap::new();

#[unsafe(no_mangle)]
pub extern "C" fn vfs_shell_rust_src_load_state() -> u32 {
    RUST_SRC_BOOTSTRAP.state() as u32
}
```

Handle `SessionEvent::BootstrapRustSrc` in `run_session_loop` by using the existing `handle_parallel` path, not terminal input:

```rust
SessionEvent::BootstrapRustSrc => {
    if !RUST_SRC_BOOTSTRAP.begin() {
        continue;
    }
    let command_stdin = CommandStdin {
        rx: Arc::clone(&rx_arc),
        cancellation_token: cancellation_token.clone(),
        buffer: Vec::new(),
    };
    let results = handle_parallel(
        vec!["load_sysroot rust-src".to_string()],
        Box::new(command_stdin),
        Box::new(SessionStdout::new(session_id)),
        Arc::clone(&session_reg),
        cancellation_token.clone(),
    );
    let ready = results.iter().all(Result::is_ok) && Path::new(RUST_SRC_CORE).is_file();
    RUST_SRC_BOOTSTRAP.finish(ready);
    if !ready {
        writeln!(stdout, "rust-src bootstrap failed: missing {RUST_SRC_CORE}").unwrap();
    }
}
```

Add `BootstrapRustSrc` as a no-op/continue arm wherever exhaustive `SessionEvent` matches do not execute session commands, including `CommandStdin::read`.

- [ ] **Step 4: Route the outer VFS event and expose state through WIT**

In `crates/vfs/src/shell.rs`, import the scalar state getter:

```rust
pub fn vfs_shell_rust_src_load_state() -> u32;
```

In `crates/vfs/src/lib.rs`, add:

```rust
const EVENT_TYPE_BOOTSTRAP_RUST_SRC: u32 = 8;
const SHELL_EVENT_BOOTSTRAP_RUST_SRC: u32 = 6;
```

Handle it before the fallback terminal dispatch:

```rust
} else if event_type == EVENT_TYPE_BOOTSTRAP_RUST_SRC {
    unsafe {
        crate::shell::vfs_shell_dispatch(
            session_id,
            SHELL_EVENT_BOOTSTRAP_RUST_SRC,
            0,
            0,
        );
    }
    return;
}
```

Add to `crates/vfs/wit/vfs-host.wit`:

```wit
export rust-src-load-state: func() -> u32;
```

Implement the generated trait method on `Wit`:

```rust
fn rust_src_load_state() -> u32 {
    unsafe { crate::shell::vfs_shell_rust_src_load_state() }
}
```

- [ ] **Step 5: Verify Rust behavior and regenerate bindings**

Run: `rustc --edition=2021 --test crates/vfs-shell/src/rust_src_bootstrap.rs -o /tmp/opencode/rust_src_bootstrap_test && /tmp/opencode/rust_src_bootstrap_test && deno run --allow-read scripts/vfs_rust_src_bootstrap_test.ts && bun run vfs:build`

Expected: Rust tests PASS, build exits 0, and generated `vfs.d.ts` contains `rustSrcLoadState(): number`.

Run: `deno eval 'const text = await Deno.readTextFile("page/src/worker_process/vfs_bindings/vfs.d.ts"); if (!text.includes("rustSrcLoadState(): number")) Deno.exit(1)'`

Expected: exit 0.

- [ ] **Step 6: Commit source and generated binding changes**

```bash
git add crates/vfs-shell/src/main.rs crates/vfs/src/shell.rs crates/vfs/src/lib.rs crates/vfs/wit/vfs-host.wit scripts/vfs_rust_src_bootstrap_test.ts page/src/worker_process/vfs_bindings/vfs.js page/src/worker_process/vfs_bindings/vfs.d.ts
git commit -m "feat(vfs): expose rust source bootstrap state"
```

Do not add `crates/vfs/expanded.rs` or generated `vfs.core.wasm`.

---

### Task 3: Bounded Host Archive Loading

**Files:**
- Create: `page/src/sysroot_archive.ts`
- Create: `page/src/sysroot_archive_test.ts`
- Modify: `lib/src/brotli_stream.ts:48-75`
- Modify: `page/src/xterm.tsx:332-436`

**Interfaces:**
- Produces: `SysrootArchiveEntry` and `loadSysrootArchive(triple, options?)`.
- Consumes: existing `fetch_compressed_stream` and `parseTar`; no VFS or SharedObject state.

- [ ] **Step 1: Write failing archive-loader tests**

Create `page/src/sysroot_archive_test.ts`:

```ts
import { loadSysrootArchive } from "./sysroot_archive.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("sysroot archive returns complete entries atomically", async () => {
  const entries = await loadSysrootArchive("rust-src", {
    timeoutMs: 100,
    fetchStream: async () => new ReadableStream<Uint8Array>(),
    parse: async (_stream, visit) => {
      visit({ name: "core/src/lib.rs", data: new Uint8Array([1]), type: "file" });
    },
  });
  assert(entries.length === 1, "missing archive entry");
  assert(new TextDecoder().decode(entries[0].name) === "core/src/lib.rs", "wrong name");
  assert(!entries[0].isDirectory, "file marked as directory");
});

Deno.test("sysroot archive rejects at the bounded timeout", async () => {
  let signal: AbortSignal | undefined;
  let rejected = false;
  try {
    await loadSysrootArchive("rust-src", {
      timeoutMs: 1,
      fetchStream: (_url, currentSignal) => {
        signal = currentSignal;
        return new Promise<ReadableStream<Uint8Array>>((_resolve, reject) => {
          currentSignal.addEventListener("abort", () => reject(currentSignal.reason));
        });
      },
      parse: async () => {},
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("timed out");
  }
  assert(rejected, "timeout did not reject");
  assert(signal?.aborted, "timed-out fetch was not aborted");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `deno test --allow-read page/src/sysroot_archive_test.ts`

Expected: FAIL because `sysroot_archive.ts` does not exist.

- [ ] **Step 3: Implement atomic archive loading**

Create `page/src/sysroot_archive.ts` with these public contracts:

```ts
export type SysrootArchiveEntry = {
  name: Uint8Array;
  data: Uint8Array;
  isDirectory: boolean;
};

type ArchiveFile = { name: string; data?: Uint8Array; type?: string };
type ArchiveOptions = {
  timeoutMs?: number;
  fetchStream?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>;
  parse?: (
    stream: ReadableStream<Uint8Array>,
    visit: (file: ArchiveFile) => void,
  ) => Promise<void>;
};

const BASE_URL = "https://oligamiq.github.io/rust_wasm/v0.2.0";

export async function loadSysrootArchive(
  triple: string,
  options: ArchiveOptions = {},
): Promise<SysrootArchiveEntry[]> {
  const controller = new AbortController();
  const operation = (async () => {
    const fetchStream = options.fetchStream ?? (await import("../../lib/src/brotli_stream.ts")).fetch_compressed_stream;
    const parse = options.parse ?? (await import("../../lib/src/parse_tar.ts")).parseTar;
    const stream = await fetchStream(
      `${BASE_URL}/${triple}.tar.br`,
      controller.signal,
    );
    const entries: SysrootArchiveEntry[] = [];
    await parse(stream, (file) => {
      entries.push({
        name: new TextEncoder().encode(file.name),
        data: file.data ?? new Uint8Array(),
        isDirectory: file.type === "directory",
      });
    });
    return entries;
  })();
  // Promise.race observes this rejection; the explicit handler also documents
  // that an abort after timeout must never become an unhandled rejection.
  void operation.catch(() => undefined);
  const timeoutMs = options.timeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new Error(`sysroot archive ${triple} timed out after ${timeoutMs}ms`);
            reject(error);
            controller.abort(error);
          },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

Change `fetch_compressed_stream` in `lib/src/brotli_stream.ts` to accept the same optional signal without changing existing callers:

```ts
export const fetch_compressed_stream = async (
  url: string | URL | globalThis.Request,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> => {
  let response: Response | undefined;
  if ("caches" in globalThis) {
    const cache = await caches.open("rubrc-assets-v1");
    response = await cache.match(url);
    if (!response) {
      response = await fetch(url, { signal });
      if (response.ok) await cache.put(url, response.clone());
    }
  } else {
    response = await fetch(url, { signal });
  }
  if (!response.ok) throw new Error("Failed to fetch wasm");
  if (!response.body) throw new Error("No body in response");
  return response.body.pipeThrough(await get_brotli_decompress_stream());
};
```

- [ ] **Step 4: Use the helper without exposing partial queues**

In `xterm.tsx`, type the queue with `SysrootArchiveEntry`, import `loadSysrootArchive`, and replace the dynamic fetch/parse block with:

```ts
} else if (unknown.name === "sysrootStartFetch") {
  const triple = unknown.args.triple;
  sysroot_queue = [];
  current_sysroot_file = null;
  try {
    sysroot_queue = await loadSysrootArchive(triple);
  } catch (error) {
    console.error(`Failed to fetch ${triple}`, error);
  }
  return {};
```

Update metadata reads to use `current_sysroot_file.isDirectory`.

- [ ] **Step 5: Run tests, type checks, and formatting**

Run: `deno test --allow-read page/src/sysroot_archive_test.ts && deno fmt --check lib/src/brotli_stream.ts page/src/sysroot_archive.ts page/src/sysroot_archive_test.ts page/src/xterm.tsx && bun run --cwd page build`

Expected: 2 tests PASS, formatting PASS, page build exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/src/brotli_stream.ts page/src/sysroot_archive.ts page/src/sysroot_archive_test.ts page/src/xterm.tsx
git commit -m "feat(vfs): bound rust source archive loading"
```

---

### Task 4: Settled VFS Readiness Result

**Files:**
- Create: `page/src/vfs_readiness.ts`
- Create: `page/src/vfs_readiness_test.ts`
- Modify: `page/src/worker_process/util_cmd.ts:330-386,477-486`
- Modify: `page/src/lsp_start_gate.ts:3-54`
- Modify: `page/src/lsp_start_gate_test.ts:7-56`
- Modify: `page/src/App.tsx:31-60`

**Interfaces:**
- Produces: `VfsReadyResult = { ok: true } | { ok: false; error: string }`, `waitForRustSrcBootstrap(root, sleep?)`, and `LspStartGate.setVfsResult(result)`.
- Consumes: Task 2 `root.rustSrcLoadState()` and outer event 8.

- [ ] **Step 1: Write failing readiness polling tests**

Create `page/src/vfs_readiness_test.ts`:

```ts
import { waitForRustSrcBootstrap } from "./vfs_readiness.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("rust-src bootstrap dispatches once and settles ready", async () => {
  const states = [0, 1, 2];
  const calls: string[] = [];
  const result = await waitForRustSrcBootstrap({
    dispatch(session, event, arg1, arg2) {
      calls.push(`${session}:${event}:${arg1}:${arg2}`);
    },
    rustSrcLoadState() {
      return states.shift() ?? 2;
    },
  }, async () => {});
  assert(result.ok, "ready result failed");
  assert(calls.join(",") === "0:8:0:0", "bootstrap dispatched incorrectly");
});

Deno.test("rust-src bootstrap settles failed", async () => {
  const result = await waitForRustSrcBootstrap({
    dispatch() {},
    rustSrcLoadState: () => 3,
  }, async () => {});
  assert(!result.ok && result.error.includes("core/src/lib.rs"), "wrong failure");
});

Deno.test("rust-src bootstrap rejects an invalid guest state", async () => {
  const result = await waitForRustSrcBootstrap({
    dispatch() {},
    rustSrcLoadState: () => 99,
  }, async () => {});
  assert(!result.ok && result.error.includes("99"), "invalid state accepted");
});
```

Append a gate failure test to `lsp_start_gate_test.ts`:

```ts
Deno.test("failed VFS readiness settles without starting LSP", () => {
  let starts = 0;
  const gate = new LspStartGate<object>(async () => {
    starts++;
    return { async dispose() {} };
  });
  gate.setMonaco({});
  gate.setVfsResult({ ok: false, error: "rust-src failed" });
  gate.setVfsResult({ ok: true });
  assert(starts === 0, "failed VFS bootstrap started LSP");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `deno test --allow-read page/src/vfs_readiness_test.ts page/src/lsp_start_gate_test.ts`

Expected: FAIL because the readiness module and `setVfsResult` do not exist.

- [ ] **Step 3: Implement polling and result types**

Create `page/src/vfs_readiness.ts`:

```ts
export type VfsReadyResult = { ok: true } | { ok: false; error: string };

type BootstrapRoot = {
  dispatch(sessionId: number, eventType: number, arg1: number, arg2: number): void;
  rustSrcLoadState(): number;
};

const BOOTSTRAP_EVENT = 8;

export async function waitForRustSrcBootstrap(
  root: BootstrapRoot,
  sleep: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 50)),
): Promise<VfsReadyResult> {
  root.dispatch(0, BOOTSTRAP_EVENT, 0, 0);
  while (true) {
    const state = root.rustSrcLoadState();
    if (state === 2) return { ok: true };
    if (state === 3) {
      return {
        ok: false,
        error: "rust-src bootstrap failed: missing /sysroot/lib/rustlib/src/rust/library/core/src/lib.rs",
      };
    }
    if (state !== 0 && state !== 1) {
      return { ok: false, error: `rust-src bootstrap returned invalid state ${state}` };
    }
    await sleep();
  }
}
```

- [ ] **Step 4: Make the gate consume a one-shot result**

Replace `vfsReady` with `vfsResult: VfsReadyResult | undefined`, import the type, and replace `setVfsReady` with:

```ts
setVfsResult(result: VfsReadyResult): void {
  if (this.vfsResult !== undefined) return;
  this.vfsResult = result;
  this.tryStart();
}
```

Change the `tryStart` guard to require `this.vfsResult?.ok === true`. Update existing tests to call `setVfsResult({ ok: true })`.

- [ ] **Step 5: Wire bootstrap and discriminated readiness**

In `util_cmd.ts`, after creating and resizing session 0 and before `vfs_ready`, call:

```ts
const rustSrcResult = await waitForRustSrcBootstrap(vfs_root);
```

The shell already prints the validation failure to session 0. Do not write the
same error through `terminal` a second time.

Change the proxy signature and call to:

```ts
const vfs_ready = new SharedObjectRef(ctx.vfs_ready_id).proxy<
  (result: VfsReadyResult) => Promise<void>
>();
await vfs_ready(rustSrcResult);
```

In `App.tsx`, consume the result while keeping terminal controls available:

```ts
const sharedReady = new SharedObject((result: VfsReadyResult) => {
  setIsReady(true);
  lspGate.setVfsResult(result);
  if (!result.ok) console.error(result.error);
}, props.ctx.vfs_ready_id);
```

- [ ] **Step 6: Run tests and build**

Run: `deno test --allow-read page/src/vfs_readiness_test.ts page/src/lsp_start_gate_test.ts && deno fmt --check page/src/vfs_readiness.ts page/src/vfs_readiness_test.ts page/src/lsp_start_gate.ts page/src/lsp_start_gate_test.ts page/src/worker_process/util_cmd.ts page/src/App.tsx && bun run --cwd page build`

Expected: all focused tests PASS, formatting PASS, page build exits 0.

- [ ] **Step 7: Commit**

```bash
git add page/src/vfs_readiness.ts page/src/vfs_readiness_test.ts page/src/lsp_start_gate.ts page/src/lsp_start_gate_test.ts page/src/worker_process/util_cmd.ts page/src/App.tsx
git commit -m "feat(lsp): wait for rust source readiness"
```

---

### Task 5: Cached Rust-Source Integration Fixture

**Files:**
- Modify: `scripts/sysroot_cache.ts:3-82,155-195`
- Modify: `scripts/sysroot_cache_test.ts:1-165`
- Modify: `scripts/vfs_lsp_diagnostics_test.ts`
- Modify: `scripts/vfs_lsp_diagnostics_worker.ts`

**Interfaces:**
- Produces: `prepareCachedArchive({ triple, cacheDir?, url?, deps? })` returning `{ archive, source, cacheArchive, url }`, and a real invalid-to-valid diagnostics command.
- Consumes: Tasks 2-4 dedicated event, state query, host rust-src entry protocol, and LSP `MessageChannel` forwarding.

- [ ] **Step 1: Add a failing generic archive-cache test**

Add to `scripts/sysroot_cache_test.ts`:

```ts
Deno.test("prepareCachedArchive caches rust-src without target layout", async () => {
  const calls: string[] = [];
  const result = await prepareCachedArchive({
    triple: "rust-src",
    cacheDir: ".cache/sysroot",
    deps: {
      exists: async () => false,
      remove: async () => {},
      mkdir: async (path) => { calls.push(`mkdir:${path}`); },
      readFile: async () => new Uint8Array(),
      writeFile: async (path) => { calls.push(`write:${path}`); },
      rename: async (from, to) => { calls.push(`rename:${from}:${to}`); },
      fetchBytes: async () => new Uint8Array([7]),
      extractTarBr: async () => { throw new Error("must not extract"); },
    },
  });
  if (result.cacheArchive !== ".cache/sysroot/rust-src.tar.br") throw new Error("wrong cache path");
  if (result.archive[0] !== 7) throw new Error("wrong archive bytes");
  if (calls.some((call) => call.startsWith("extract:"))) throw new Error("archive was extracted");
});
```

- [ ] **Step 2: Run the cache test to verify RED**

Run: `deno test --allow-read scripts/sysroot_cache_test.ts`

Expected: FAIL because `prepareCachedArchive` is not exported.

- [ ] **Step 3: Extract generic cache preparation**

Add `prepareCachedArchive` to `sysroot_cache.ts` and make `prepareCachedSysroot` delegate its cache read/download work to it:

```ts
export async function prepareCachedArchive(
  options: Pick<Partial<SysrootCacheOptions>, "triple" | "cacheDir" | "url" | "deps"> = {},
): Promise<{ archive: Uint8Array; source: SysrootCacheSource; cacheArchive: string; url: string }> {
  const triple = options.triple ?? DEFAULT_TRIPLE;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const cacheArchive = `${cacheDir}/${triple}.tar.br`;
  const url = options.url ?? `${DEFAULT_BASE_URL}/${triple}.tar.br`;
  const deps = options.deps ?? denoSysrootCacheDeps;
  await deps.mkdir(cacheDir);
  if (await deps.exists(cacheArchive)) {
    return { archive: await deps.readFile(cacheArchive), source: "cache", cacheArchive, url };
  }
  const archive = await deps.fetchBytes(url);
  await deps.writeFile(`${cacheArchive}.tmp`, archive);
  await deps.rename(`${cacheArchive}.tmp`, cacheArchive);
  return { archive, source: "download", cacheArchive, url };
}
```

Preserve the existing `prepareCachedSysroot` call order asserted by its tests:
call `deps.remove(paths.expandedSysroot)` first, then call
`prepareCachedArchive`, then create `paths.sysrootLibDir` and extract. Do not
change the existing expected call sequence except for internal delegation.

- [ ] **Step 4: Serve cached rust-src through the parent host bridge**

In `vfs_lsp_diagnostics_test.ts`, prepare the cached `rust-src` archive and keep
its bytes in memory. Make the parent `unknown_fn` async. On the first
`sysrootStartFetch("rust-src")`, decompress and parse those bytes before the
callback resolves, cache immutable entry templates, and clone them into the
active queue. This exercises the same awaited async base-call contract as
production. Implement `sysrootGetNextFileMeta`, `sysrootReadFileName`, and
chunked `sysrootReadFileChunk` exactly like `xterm.tsx`; do not prepopulate
rust-src in the preopen.

Retain the existing `MessageChannel`: spawned-worker `terminalWrite` callbacks must post `{ session_id, data }` to the diagnostics worker, while main-worker callbacks continue feeding the same decoder directly.

- [ ] **Step 5: Drive production bootstrap before initialize**

In `vfs_lsp_diagnostics_worker.ts`, after `animal.start(root)` and memory setup:

```ts
root.dispatch(0, 3, 0, 0);
const rustSrcResult = await waitForRustSrcBootstrap(root, async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
});
if (!rustSrcResult.ok) throw new Error(rustSrcResult.error);
```

Then retain the real sequence: `initialize`, `initialized`, invalid `didOpen`, error `publishDiagnostics`, valid full-text `didChange`, and an error-free publication. Remove temporary per-message diagnostic logging before GREEN.

- [ ] **Step 6: Run cache and real integration tests**

Run: `deno test --allow-read scripts/sysroot_cache_test.ts && deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts`

Expected: cache tests PASS and integration exits 0 with `rust-analyzer published and cleared diagnostics`.

- [ ] **Step 7: Format and commit**

Run: `deno fmt --check scripts/sysroot_cache.ts scripts/sysroot_cache_test.ts scripts/vfs_lsp_diagnostics_test.ts scripts/vfs_lsp_diagnostics_worker.ts`

Expected: formatting check PASS.

```bash
git add scripts/sysroot_cache.ts scripts/sysroot_cache_test.ts scripts/vfs_lsp_diagnostics_test.ts scripts/vfs_lsp_diagnostics_worker.ts
git commit -m "test(lsp): verify diagnostics with rust source"
```

---

### Task 6: Regression And Browser Handoff Verification

**Files:**
- Verify only; do not add generated or lock files.

**Interfaces:**
- Consumes: Tasks 1-5 complete rust-src readiness path.
- Produces: a reviewed, verified baseline for Task 7 of `docs/superpowers/plans/2026-07-19-rust-analyzer-live-diagnostics.md`.

- [ ] **Step 1: Run focused Rust and Deno tests**

Run:

```bash
rustc --edition=2021 --test crates/vfs-shell/src/rust_src_bootstrap.rs -o /tmp/opencode/rust_src_bootstrap_test && /tmp/opencode/rust_src_bootstrap_test
deno run --allow-read scripts/vfs_rust_src_bootstrap_test.ts
```

Expected: every command exits 0.

- [ ] **Step 2: Rebuild and rerun the real server**

Run: `bun run vfs:build && deno run --no-lock -A scripts/vfs_lsp_diagnostics_test.ts && bun run --cwd page build`

Expected: all commands exit 0; integration prints `rust-analyzer published and cleared diagnostics`.

- [ ] **Step 3: Inspect generated and unrelated changes**

Run: `git status --short && git diff --stat && git diff --check`

Expected: no whitespace errors; `crates/vfs/expanded.rs`, `deno.lock`, and `package-lock.json` remain unstaged and uncommitted.

- [ ] **Step 4: Request code review**

Review the complete diff from `0f2a62e0` through `HEAD`, focusing on one-shot state transitions, host timeout settlement, worker cleanup, generated binding consistency, and real-test production parity. Resolve all blocking findings with focused tests before continuing.

- [ ] **Step 5: Continue the original live-diagnostics plan**

Resume at Task 7, Browser Marker Acceptance Test, in `docs/superpowers/plans/2026-07-19-rust-analyzer-live-diagnostics.md`. Do not repeat Task 6 there; this plan's real integration test supersedes it.
