# Base-Call OOM Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify the runtime host callback active when browser cold startup reports `base call failed: OutOfMemory`, while preserving production behavior and all memory limits.

**Architecture:** Extend the existing test-build-only `VFS_DEBUG_TRACE` path at the authored `vfs_bindings/inst.ts` adapter used by root and child-thread VFS instances, so sysroot and cargo base calls produce paired request/response/reject events through `traceVfsHostCall`. Add a small console-argument inspector so a cold-start OOM retains the browser Error stack and console location instead of only `message.text()`, and require successful cold startup to observe a real paired sysroot trace.

**Tech Stack:** TypeScript, JavaScript, Deno tests, Vite test builds, Puppeteer, `@oligami/browser_wasi_shim-threads`.

## Global Constraints

- Preserve the dirty worktree and all unrelated changes.
- Do not stage or commit files.
- Keep port 4173 untouched; use port 4174 for browser acceptance.
- Do not modify the 64 MiB base-call allocator, the 8192-page rust-analyzer reserve, or the 32,775-page shared-memory maximum.
- Do not change startup ordering, retry behavior, request count, or readiness semantics.
- Keep all new host-call telemetry behind `import.meta.env.VITE_RUBRC_LSP_TEST === "1"` and use the existing `VFS_DEBUG_TRACE` channel.
- Never retry a base call from the tracing wrapper because base calls may have side effects.

---

### Task 1: Trace The Active Sysroot And Cargo Base-Call Boundary

**Files:**
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs`
- Modify: `page/src/worker_process/vfs_bindings/inst.ts`
- Modify: `page/src/worker_process/util_cmd.ts`
- Verify: `page/src/vfs_debug_trace.ts`
- Test: `page/src/vfs_debug_trace_test.ts`

**Interfaces:**
- Consumes: `traceVfsHostCall<T>(id: number, name: string, emit: (line: string) => void, call: () => T): T` from `page/src/vfs_debug_trace.ts`.
- Produces: worker-instance-local, monotonically numbered test-build trace lines in the existing form `host-call id=<id> name=<name> phase=<request|response|reject>` for `sysrootStartFetch`, `sysrootArchiveGetMeta`, `sysrootReadArchiveChunk`, and `hostRunCargo`.
- Verifies: successful cold startup finds at least one sysroot request whose matching response remains in the existing bounded `VfsDebugTraceCollector` snapshot.

- [x] **Step 1: Replace the dead-path contract with an active-boundary contract**

Replace `test builds trace sysroot and cargo base-call boundaries` in `scripts/lsp_browser_diagnostics_contract_test.ts` with:

```ts
Deno.test("test builds trace active sysroot and cargo base-call boundaries", async () => {
  const adapter = await Deno.readTextFile(
    "page/src/worker_process/vfs_bindings/inst.ts",
  );
  const utilityWorker = await Deno.readTextFile(
    "page/src/worker_process/util_cmd.ts",
  );
  const acceptance = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );

  for (const name of [
    "sysrootStartFetch",
    "sysrootArchiveGetMeta",
    "sysrootReadArchiveChunk",
    "hostRunCargo",
  ]) {
    assert(
      adapter.includes(`"${name}"`),
      `active host-call trace omits ${name}`,
    );
  }
  assert(
    adapter.includes('import.meta.env.VITE_RUBRC_LSP_TEST === "1"') &&
      adapter.includes("tracedHostCallNames.has(name)") &&
      adapter.includes("traceVfsHostCall("),
    "active VFS callbacks do not share the test-build host-call tracer",
  );
  assert(
    !utilityWorker.includes("tracedHostCallNames") &&
      !utilityWorker.includes("traceVfsHostCall("),
    "utility worker retains the superseded dead-path wrapper",
  );
  assert(
    acceptance.includes("traceCollector.snapshot().trace") &&
      acceptance.includes("pairedSysrootCall") &&
      acceptance.includes("cold startup trace omitted a paired sysroot call"),
    "cold browser success does not prove that host-call tracing executed",
  );
});
```

- [x] **Step 2: Run the contract test and confirm RED**

Run:

```bash
deno test --no-lock --allow-read scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: FAIL in `test builds trace active sysroot and cargo base-call boundaries` because `inst.ts` has no test-build tracer and `util_cmd.ts` retains the dead-path wrapper.

- [x] **Step 3: Add the test-build trace wrapper at the authored VFS adapter**

In `page/src/worker_process/vfs_bindings/inst.ts`, add this import after the existing protocol import:

```ts
import { traceVfsHostCall } from "../../vfs_debug_trace.ts";
```

Add this constant before `custom_instantiate`:

```ts
const tracedHostCallNames = new Set([
  "sysrootStartFetch",
  "sysrootArchiveGetMeta",
  "sysrootReadArchiveChunk",
  "hostRunCargo",
]);
```

At the start of `custom_instantiate`, before constructing `imports`, add:

```ts
  const debugTraceEnabled = import.meta.env.VITE_RUBRC_LSP_TEST === "1";
  let hostCallId = 0;
  const tracedCallUnknownFn = (idx: number, unknown: unknown): unknown => {
    const name =
      typeof unknown === "object" && unknown !== null
        ? (unknown as { name?: unknown }).name
        : undefined;
    if (
      debugTraceEnabled &&
      typeof name === "string" &&
      tracedHostCallNames.has(name)
    ) {
      return traceVfsHostCall(
        ++hostCallId,
        name,
        (line) => console.debug("[vfs-stall-trace]", line),
        () => call_unknown_fn(idx, unknown),
      );
    }
    return call_unknown_fn(idx, unknown);
  };
```

Replace only the four relevant `call_unknown_fn(0, ...)` calls in the `Downloader` and `Lsp` imports with `tracedCallUnknownFn(0, ...)`. Leave download, child-process, HTTP, and terminal forwarding on `call_unknown_fn` directly. For example:

```ts
const res = tracedCallUnknownFn(0, {
  name: "sysrootArchiveGetMeta",
  args: {},
}) as SysrootArchiveMetaResponse;
```

In `page/src/worker_process/util_cmd.ts`, remove `traceVfsHostCall` from the import, delete `tracedHostCallNames` and `hostCallId`, and remove the traced branch after `terminalWrite` so the callback ends with:

```ts
      }
      return animal.call_unknown_fn(idx, unknown);
```

Keep `debugTraceEnabled` and `emitDebugTrace` in `util_cmd.ts` because the bounded VFS trace pump still uses them. Do not edit generated `vfs_bindings/thread_spawn.ts`, and do not add a catch or retry around `call_unknown_fn`.

- [x] **Step 4: Require a real paired sysroot trace on successful cold startup**

In `measureColdStartup`, after reading `timings` and before checking `browserErrors`, add:

```js
    const trace = traceCollector.snapshot().trace;
    const pairedSysrootCall = Array.from(
      trace.matchAll(
        /host-call id=(\d+) name=(sysrootStartFetch|sysrootArchiveGetMeta|sysrootReadArchiveChunk) phase=request/g,
      ),
    ).some(([, id, name]) =>
      trace.includes(`host-call id=${id} name=${name} phase=response`),
    );
    if (!pairedSysrootCall) {
      throw new Error("cold startup trace omitted a paired sysroot call");
    }
```

This reuses the bounded collector and stores no payloads or second trace history. It proves the built browser path executed the instrumentation rather than only containing dead code.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run:

```bash
deno test --no-lock --allow-read scripts/lsp_browser_diagnostics_contract_test.ts page/src/vfs_debug_trace_test.ts
```

Expected: all contract and host-trace tests PASS. Existing tests must continue to prove exact return/error identity and payload omission.

---

### Task 2: Preserve Cold-Start OOM Console Details

**Files:**
- Modify: `scripts/lsp_browser_console_error.mjs`
- Modify: `scripts/lsp_browser_console_error_test.ts`
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs`

**Interfaces:**
- Produces: `inspectConsoleArguments(args): Promise<unknown[]>` from `scripts/lsp_browser_console_error.mjs`.
- Consumes: Puppeteer `ConsoleMessage.args()` handles whose `evaluate(visitor)` method resolves to a serializable value or rejects.
- Preserves: the original `base call failed: OutOfMemory` classification even when an argument cannot be inspected.

- [x] **Step 1: Add failing unit tests for console argument inspection**

Change the import in `scripts/lsp_browser_console_error_test.ts` to:

```ts
import {
  inspectConsoleArguments,
  shouldSuppressOptionalMetadataNotFound,
} from "./lsp_browser_console_error.mjs";
```

Append these tests:

```ts
Deno.test("console argument inspection preserves Error details", async () => {
  const details = await inspectConsoleArguments([
    {
      evaluate(visitor: (value: unknown) => unknown) {
        return Promise.resolve(visitor(new TypeError("base transport failed")));
      },
    },
  ]);

  const error = details[0] as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  assert(error.name === "TypeError", "console Error name was lost");
  assert(
    error.message === "base transport failed",
    "console Error message was lost",
  );
  assert(typeof error.stack === "string", "console Error stack was lost");
});

Deno.test("console argument inspection reports an uninspectable handle", async () => {
  const details = await inspectConsoleArguments([
    {
      evaluate() {
        return Promise.reject(new Error("detached handle"));
      },
    },
  ]);

  assert(
    details[0] ===
      "uninspectable console argument: Error: detached handle",
    "argument inspection failure hid its stable description",
  );
});
```

- [x] **Step 2: Add a failing integration contract for the cold OOM path**

Append this test to `scripts/lsp_browser_diagnostics_contract_test.ts`:

```ts
Deno.test("cold-start OOM includes inspected console details", async () => {
  const source = await Deno.readTextFile(
    "scripts/lsp_browser_diagnostics_test.mjs",
  );
  const oomIndex = source.indexOf(
    'text.includes("base call failed: OutOfMemory")',
  );
  const detailsIndex = source.indexOf(
    "inspectConsoleArguments(message.args())",
    oomIndex,
  );
  const locationIndex = source.indexOf(
    "message.location()",
    detailsIndex,
  );
  const rejectIndex = source.indexOf(
    "rejectColdStartupFatal(",
    detailsIndex,
  );

  assert(oomIndex >= 0, "cold-start OOM detection is missing");
  assert(
    detailsIndex > oomIndex && rejectIndex > detailsIndex,
    "cold-start OOM rejects before preserving console argument details",
  );
  assert(
    locationIndex > detailsIndex && locationIndex < rejectIndex,
    "cold-start OOM detail omits the console source location",
  );
});
```

- [x] **Step 3: Run both tests and confirm RED**

Run:

```bash
deno test --no-lock --allow-read scripts/lsp_browser_console_error_test.ts scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: FAIL because `inspectConsoleArguments` is not exported and the cold OOM path rejects from `message.text()` alone.

- [x] **Step 4: Implement the console argument inspector**

Append this code to `scripts/lsp_browser_console_error.mjs`:

```js
function describeInspectionError(error) {
  try {
    if (error instanceof Error) {
      return error.message === ""
        ? error.name
        : `${error.name}: ${error.message}`;
    }
    return String(error);
  } catch {
    return "Unknown";
  }
}

export async function inspectConsoleArguments(args) {
  return Promise.all(
    args.map(async (argument) => {
      try {
        return await argument.evaluate((value) =>
          value instanceof Error
            ? {
                name: value.name,
                message: value.message,
                stack: value.stack,
              }
            : String(value),
        );
      } catch (error) {
        return `uninspectable console argument: ${describeInspectionError(error)}`;
      }
    }),
  );
}
```

This helper must resolve one output for every input handle. It must not expose arbitrary object payloads; non-Error values are stringified in the browser context.

- [x] **Step 5: Use inspected details before rejecting cold startup**

Change the import in `scripts/lsp_browser_diagnostics_test.mjs` to:

```js
import {
  inspectConsoleArguments,
  shouldSuppressOptionalMetadataNotFound,
} from "./lsp_browser_console_error.mjs";
```

Replace the current cold-start OOM block with:

```js
      if (text.includes("base call failed: OutOfMemory")) {
        void inspectConsoleArguments(message.args()).then((details) => {
          const location = message.location();
          rejectColdStartupFatal(
            new Error(
              `fatal cold-start transport error at ${location.url}:${location.lineNumber}:${location.columnNumber}: ${text}; details=${JSON.stringify(details)}`,
            ),
          );
        });
      }
```

Do not remove the existing `browserErrors.push(text)` behavior. The primary failure must contain both the original OOM text and the inspected details.

- [x] **Step 6: Run focused tests and confirm GREEN**

Run:

```bash
deno test --no-lock --allow-read scripts/lsp_browser_console_error_test.ts scripts/lsp_browser_diagnostics_contract_test.ts page/src/vfs_debug_trace_test.ts
```

Expected: all tests PASS.

---

### Task 3: Build And Verify Browser Diagnostics

**Files:**
- Verify: `page/src/worker_process/vfs_bindings/inst.ts`
- Verify: `page/src/worker_process/util_cmd.ts`
- Verify: `scripts/lsp_browser_console_error.mjs`
- Verify: `scripts/lsp_browser_diagnostics_test.mjs`
- Verify: all startup-progress files covered by the focused suite

**Interfaces:**
- Consumes: the test-build host-call trace and cold OOM detail capture from Tasks 1 and 2.
- Produces: either a complete browser success marker or an OOM failure containing the active host-call boundary and Error stack.

- [x] **Step 1: Run the focused diagnostics tests**

Run:

```bash
deno test --no-lock --allow-read scripts/lsp_browser_console_error_test.ts scripts/lsp_browser_diagnostics_contract_test.ts page/src/vfs_debug_trace_test.ts
```

Expected: all tests PASS.

- [x] **Step 2: Run the focused startup-progress suite**

Run:

```bash
deno test --no-lock --allow-read page/src/rust_analyzer_readiness_test.ts page/src/rust_lsp_client_test.ts page/src/startup_coordinator_test.ts page/src/startup_overlay_progress_test.ts page/src/lsp_start_gate_test.ts page/src/lsp_test_api_state_test.ts scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: all tests PASS with zero failures.

- [x] **Step 3: Run a fresh full browser acceptance with sufficient outer time**

Run:

```bash
RUBRC_LSP_BROWSER_PORT=4174 bun run test:lsp-browser
```

Allow at least 40 minutes for page build, 451 MB VFS compression, rust-src preparation, and browser acceptance. Do not use port 4173.

Expected normal result: exit 0 and final line:

```text
browser displayed and cleared rust-analyzer markers
```

If the nondeterministic OOM recurs, do not retry it blindly. Confirm the failure output includes either a rejected call or a final unmatched request, plus the fatal location and details:

```text
host-call id=<id> name=<callback> phase=<request-or-reject>
fatal cold-start transport error at <url>:<line>:<column>
details=[{"name":"...","message":"base call failed: OutOfMemory","stack":"..."}]
```

An OOM run is valid diagnostic evidence for this observability task only when it identifies the callback boundary and retains the Error stack. It remains a failing browser acceptance and must be reported as such.

- [x] **Step 4: Check formatting without rewriting files**

Run:

```bash
bun x @biomejs/biome@1.9.1 format page/src/worker_process/vfs_bindings/inst.ts page/src/worker_process/util_cmd.ts scripts/lsp_browser_console_error.mjs scripts/lsp_browser_console_error_test.ts scripts/lsp_browser_diagnostics_contract_test.ts scripts/lsp_browser_diagnostics_test.mjs
```

Expected: all listed files are already formatted and no files are rewritten.

- [x] **Step 5: Check diff integrity and inspect only scoped changes**

Run:

```bash
git diff --check
git diff -- page/src/worker_process/vfs_bindings/inst.ts page/src/worker_process/util_cmd.ts scripts/lsp_browser_console_error.mjs scripts/lsp_browser_console_error_test.ts scripts/lsp_browser_diagnostics_contract_test.ts scripts/lsp_browser_diagnostics_test.mjs docs/superpowers/specs/2026-09-02-base-call-oom-diagnostics-design.md docs/superpowers/plans/2026-09-02-base-call-oom-diagnostics.md
```

Expected: `git diff --check` prints nothing. The scoped diff contains only test-build tracing, console detail capture, tests, and documentation; unrelated dirty-worktree changes remain untouched.
