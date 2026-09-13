# Rust-Analyzer Startup Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show elapsed time, poll count, and observed crate labels while rust-analyzer waits for its crate graph, without changing startup readiness behavior.

**Architecture:** Add an immutable observation event to the existing crate-graph polling loop and forward it through project activation into `StartupCoordinator`. The coordinator owns the overlay snapshot, while the browser test API retains the latest production event after the overlay advances to semantic warming or ready. Presentation remains a pure formatting concern consumed by `StartupOverlay`.

**Tech Stack:** TypeScript, SolidJS, Deno tests, Bun/Vite, Puppeteer browser acceptance.

## Global Constraints

- Keep the crate-graph readiness timeout at exactly 300,000 ms.
- Keep the production crate-graph polling interval at exactly 5,000 ms.
- Readiness continues to require `rubrc_main`, `core`, `alloc`, and `std`.
- Do not change request ordering, cancellation, disposal, rust-analyzer configuration, or memory limits.
- Progress observers are telemetry only; their exceptions must not affect startup.
- Ignore progress from stale generations, aborted startup, and non-`project-activating` phases.
- Clear overlay task progress at `semantic-warming` and `ready`, but retain it on `failed`.
- Retain the latest production progress event in the test API without issuing another crate-graph request.
- Do not add test-only LSP response hooks to production code.
- Work in the current checkout. Do not stage or commit changes.

---

## File Structure

- `page/src/rust_analyzer_readiness.ts`: owns polling, required-label extraction, timing, and immutable progress emission.
- `page/src/rust_lsp_startup.ts`: forwards the readiness observer through project activation.
- `page/src/rust_lsp_client.ts`: connects the concrete staged session to project activation.
- `page/src/startup_coordinator.ts`: owns current-generation project progress in `StartupSnapshot`.
- `page/src/App.tsx`: preserves the coordinator callback across the animation-frame adapter.
- `page/src/startup_overlay_progress.ts`: pure text formatting for crate-graph progress.
- `page/src/StartupOverlay.tsx`: renders structured progress for running and failed Project tasks.
- `page/src/lsp_test_api_state.ts`: defines retained startup progress visible to browser tests.
- `page/src/lsp_test_api.ts`: records the exact production event from coordinator snapshots.
- `scripts/lsp_browser_diagnostics_test.mjs`: validates the built artifact receives and renders production polling data.
- Existing adjacent test files verify each boundary before its implementation changes.

---

### Task 1: Emit Immutable Readiness Progress

**Files:**
- Modify: `page/src/rust_analyzer_readiness_test.ts:1-102`
- Modify: `page/src/rust_analyzer_readiness.ts:1-389`

**Interfaces:**
- Consumes: existing `nodeLabels(dot: string): Set<string>`, `isContentModified(error: unknown): boolean`, `now()`, `graphSleep()`, and `awaitPhaseOperation(...)` behavior.
- Produces: exported `CrateGraphProgress` and `waitForCrateGraph(signal, observeProgress?)`.

- [ ] **Step 1: Add failing tests for attempts, timing, labels, and immutability**

Change the test import to:

```ts
import {
  type CrateGraphProgress,
  RustAnalyzerReadiness,
} from "./rust_analyzer_readiness.ts";
```

Add:

```ts
Deno.test("crate graph progress numbers attempts and filters required labels in stable order", async () => {
  let now = 100;
  const responses = [
    graph(`${stdNode}\n  _4 [label="serde"];\n${coreNode}`),
    graph(
      `${stdNode}\n${allocNode}\n${mainNode}\n${coreNode}\n` +
        '  _4 [label="serde"];',
    ),
  ];
  const progress: CrateGraphProgress[] = [];
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(): Promise<R> {
        return responses.shift() as R;
      },
    },
    uri,
    {
      now: () => now,
      sleep: async () => {
        now += 5_000;
      },
      timeoutMs: 20_000,
    },
  );

  await readiness.waitForCrateGraph(
    new AbortController().signal,
    (event) => progress.push(event),
  );

  assert(progress.length === 2, `emitted ${progress.length} progress events`);
  assert(progress[0].attempt === 1, "first attempt was not numbered one");
  assert(progress[1].attempt === 2, "second attempt was not numbered two");
  assert(progress[0].elapsedMs === 0, `wrong first elapsed: ${progress[0].elapsedMs}`);
  assert(progress[1].elapsedMs === 5_000, `wrong second elapsed: ${progress[1].elapsedMs}`);
  assert(
    progress[0].remainingMs === 20_000 && progress[1].remainingMs === 15_000,
    `wrong remaining times: ${progress.map((event) => event.remainingMs)}`,
  );
  assert(progress[0].labels.join(",") === "core,std", `unstable partial labels: ${progress[0].labels}`);
  assert(
    progress[1].labels.join(",") === "rubrc_main,core,alloc,std",
    `unstable ready labels: ${progress[1].labels}`,
  );
  assert(!progress[0].ready, "partial graph was reported ready");
  assert(progress[1].ready, "complete graph was reported incomplete");
  assert(Object.isFrozen(progress[0]), "progress event is mutable");
  assert(Object.isFrozen(progress[0].labels), "progress labels are mutable");
});
```

- [ ] **Step 2: Add failing tests for retry and observer isolation**

```ts
Deno.test("ContentModified emits incomplete crate graph progress before retry", async () => {
  let requests = 0;
  let now = 0;
  const progress: CrateGraphProgress[] = [];
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(): Promise<R> {
        requests++;
        if (requests === 1) throw { code: -32801, message: "Content modified" };
        return graph(`${mainNode}\n${coreNode}\n${allocNode}\n${stdNode}`) as R;
      },
    },
    uri,
    {
      now: () => now,
      sleep: async () => {
        now += 5_000;
      },
      timeoutMs: 20_000,
    },
  );

  await readiness.waitForCrateGraph(
    new AbortController().signal,
    (event) => progress.push(event),
  );

  assert(requests === 2, `issued ${requests} graph requests`);
  assert(progress.length === 2, `emitted ${progress.length} progress events`);
  assert(
    progress[0].attempt === 1 && progress[0].labels.length === 0 && !progress[0].ready,
    `wrong ContentModified progress: ${JSON.stringify(progress[0])}`,
  );
  assert(progress[1].attempt === 2 && progress[1].ready, "retry did not report readiness");
});

Deno.test("crate graph progress observer failures cannot interrupt readiness", async () => {
  let requests = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(): Promise<R> {
        requests++;
        return graph(
          requests === 1
            ? mainNode
            : `${mainNode}\n${coreNode}\n${allocNode}\n${stdNode}`,
        ) as R;
      },
    },
    uri,
    { sleep: async () => {} },
  );

  await readiness.waitForCrateGraph(
    new AbortController().signal,
    () => {
      throw new Error("observer failed");
    },
  );

  assert(requests === 2, `observer stopped readiness after ${requests} requests`);
});

Deno.test("ordinary crate graph failures do not emit progress", async () => {
  const expected = new Error("crate graph request failed");
  let events = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest(): Promise<never> {
        throw expected;
      },
    },
    uri,
  );

  const caught = await readiness.waitForCrateGraph(
    new AbortController().signal,
    () => events++,
  ).then(() => undefined, (error) => error);

  assert(caught === expected, "ordinary graph error identity changed");
  assert(events === 0, `ordinary error emitted ${events} progress events`);
});
```

- [ ] **Step 3: Run the focused test and confirm the API is missing**

Run:

```sh
deno test --no-lock page/src/rust_analyzer_readiness_test.ts
```

Expected: FAIL because `CrateGraphProgress` is not exported and `waitForCrateGraph` accepts only one argument.

- [ ] **Step 4: Add stable required-label extraction and the progress type**

Add near the public types:

```ts
export type CrateGraphProgress = {
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly labels: readonly string[];
  readonly ready: boolean;
};

type CrateGraphProgressObserver = (progress: CrateGraphProgress) => void;

const REQUIRED_CRATE_LABELS: readonly string[] = Object.freeze([
  "rubrc_main",
  "core",
  "alloc",
  "std",
]);
```

Replace the boolean-only label check with:

```ts
const requiredCrateLabels = (dot: unknown): readonly string[] => {
  if (typeof dot !== "string") return Object.freeze([]);
  const labels = nodeLabels(dot);
  return Object.freeze(
    REQUIRED_CRATE_LABELS.filter((label) => labels.has(label)),
  );
};
```

- [ ] **Step 5: Emit progress from the existing polling loop**

Change the method signature to:

```ts
async waitForCrateGraph(
  signal: AbortSignal,
  observeProgress?: CrateGraphProgressObserver,
): Promise<void>
```

Preserve the existing request, timeout, abort, disposal, and sleep calls. Add `startedAt`, increment `attempt` immediately before each request, emit empty incomplete labels after `ContentModified`, and emit filtered labels after valid graph responses. Add this private helper and call it only after `checkActive(signal)`:

```ts
private emitCrateGraphProgress(
  observer: CrateGraphProgressObserver | undefined,
  attempt: number,
  startedAt: number,
  deadline: number,
  labels: readonly string[],
  ready: boolean,
): void {
  const observedAt = this.now();
  const progress = Object.freeze({
    attempt,
    elapsedMs: observedAt - startedAt,
    remainingMs: Math.max(0, deadline - observedAt),
    labels,
    ready,
  });
  try {
    observer?.(progress);
  } catch {
    // Progress observers are telemetry only.
  }
}
```

The complete response branch must use:

```ts
const labels = requiredCrateLabels(dot);
const ready = labels.length === REQUIRED_CRATE_LABELS.length;
this.emitCrateGraphProgress(
  observeProgress,
  attempt,
  startedAt,
  deadline,
  labels,
  ready,
);
if (ready) {
  this.crateGraphReady = true;
  this.diagnosticsVersion = undefined;
  return;
}
```

The `ContentModified` branch must first call `checkActive(signal)`, then use:

```ts
this.emitCrateGraphProgress(
  observeProgress,
  attempt,
  startedAt,
  deadline,
  Object.freeze([]),
  false,
);
```

- [ ] **Step 6: Run readiness tests**

Run:

```sh
deno test --no-lock page/src/rust_analyzer_readiness_test.ts
```

Expected: all readiness tests PASS, including existing timeout, late-settlement, abort, and disposal cases.

---

### Task 2: Forward Progress Through Project Activation

**Files:**
- Modify: `page/src/rust_lsp_client_test.ts:517-555`
- Modify: `page/src/rust_lsp_startup.ts:1-123`
- Modify: `page/src/rust_lsp_client.ts:172-205`
- Modify: `page/src/startup_coordinator.ts:32-40`
- Modify: `page/src/App.tsx:134-145`

**Interfaces:**
- Consumes: `CrateGraphProgress` and `waitForCrateGraph(signal, observeProgress?)` from Task 1.
- Produces: `reportProjectProgress(progress: CrateGraphProgress): void` on `RustProjectActivation` and as the fourth `StagedAnalyzerSession.activateProject` callback.

- [ ] **Step 1: Extend the activation-order test first**

In the existing project activation order test, define:

```ts
const graphProgress: CrateGraphProgress = Object.freeze({
  attempt: 1,
  elapsedMs: 5_000,
  remainingMs: 295_000,
  labels: Object.freeze(["rubrc_main", "core"]),
  ready: false,
});
```

Make its readiness fake emit the exact object:

```ts
waitForCrateGraph: async (
  _signal: AbortSignal,
  observeProgress?: (progress: CrateGraphProgress) => void,
) => {
  order.push("crate graph request");
  observeProgress?.(graphProgress);
  order.push("crate graph ready");
},
```

Add this activation field:

```ts
reportProjectProgress: (progress) => {
  assert(progress === graphProgress, "activation cloned project progress");
  order.push("project progress:1");
},
```

Require this order before the VFS write:

```ts
"didChangeConfiguration(full settings)",
"crate graph request",
"project progress:1",
"crate graph ready",
"VFS write complete",
```

In each remaining `activateRustProject({...})` test object, insert this field beside
`semanticWarming` so the fixture explicitly opts out of telemetry:

```ts
reportProjectProgress: () => {},
```

- [ ] **Step 2: Run the activation test and confirm forwarding is absent**

Run:

```sh
deno test --no-lock --allow-read page/src/rust_lsp_client_test.ts
```

Expected: FAIL because `RustProjectActivation` has no progress callback and readiness does not receive it.

- [ ] **Step 3: Extend `RustProjectActivation` and call readiness with the observer**

Import the type in `rust_lsp_startup.ts`:

```ts
import type { CrateGraphProgress } from "./rust_analyzer_readiness.ts";
```

Use this readiness signature and activation field:

```ts
readiness: {
  waitForCrateGraph(
    signal: AbortSignal,
    observeProgress?: (progress: CrateGraphProgress) => void,
  ): Promise<void>;
  noteDocumentChanged(version: number): void;
  waitForSemanticReadiness(model: TModel, signal: AbortSignal): Promise<void>;
};
reportProjectProgress(progress: CrateGraphProgress): void;
```

Pass the observer through the existing abort wrapper:

```ts
await awaitWithAbort(
  readiness.waitForCrateGraph(signal, reportProjectProgress),
  signal,
);
```

- [ ] **Step 4: Extend the staged-session interface and concrete session**

Import `CrateGraphProgress` into `startup_coordinator.ts` and change the method to:

```ts
activateProject(
  model: StartupModel,
  signal: AbortSignal,
  semanticWarming: () => void,
  reportProjectProgress: (progress: CrateGraphProgress) => void,
): Promise<void>;
```

In `rust_lsp_client.ts`, accept `reportProjectProgress` as the fourth callback and include it in the existing `activateRustProject` object literal:

```ts
activateProject: async (
  activationModel,
  activationSignal,
  semanticWarming,
  reportProjectProgress,
) => {
  analyzerConfiguration.activateProject();
  await activateRustProject({
    initializedModel: model,
    model: activationModel as Monaco.editor.ITextModel,
    signal: activationSignal,
    uri: mainUri,
    writeMain: (content) =>
      writeAndRecordWorkspace("/src/main.rs", content),
    client,
    readiness,
    sync,
    setModelLanguage: (currentModel, language) =>
      monaco.editor.setModelLanguage(
        currentModel as Monaco.editor.ITextModel,
        language,
      ),
    semanticWarming,
    reportProjectProgress,
  });
  signal.throwIfAborted();
  activationSignal.throwIfAborted();
  recordAnalyzerTestReadiness(
    testGeneration,
    (activationModel as Monaco.editor.ITextModel).getVersionId(),
  );
},
```

- [ ] **Step 5: Preserve the callback through the App animation-frame adapter**

Change the adapter to:

```ts
activateProject: async (
  activationModel,
  activationSignal,
  warming,
  reportProjectProgress,
) => {
  await yieldAnimationFrame(activationSignal);
  await session.activateProject(
    activationModel,
    activationSignal,
    warming,
    reportProjectProgress,
  );
},
```

- [ ] **Step 6: Run the focused activation suite**

Run:

```sh
deno test --no-lock --allow-read page/src/rust_lsp_client_test.ts
```

Expected: PASS with the progress callback between crate-graph request and VFS write, while all existing abort-order tests remain green.

---

### Task 3: Publish Guarded Coordinator Progress

**Files:**
- Modify: `page/src/startup_coordinator_test.ts:19-61,186-264,429-583`
- Modify: `page/src/startup_coordinator.ts:18-125,196-288`

**Interfaces:**
- Consumes: fourth `StagedAnalyzerSession.activateProject` callback from Task 2.
- Produces: optional `projectProgress?: CrateGraphProgress` on startup task snapshots.

- [ ] **Step 1: Update coordinator test helpers and add a progress factory**

Import `CrateGraphProgress`, update every fake session's `activateProject` signature to accept the fourth callback, and add:

```ts
const crateProgress = (
  attempt: number,
  labels: readonly string[],
  ready = false,
): CrateGraphProgress =>
  Object.freeze({
    attempt,
    elapsedMs: attempt * 5_000,
    remainingMs: 300_000 - attempt * 5_000,
    labels: Object.freeze([...labels]),
    ready,
  });
```

The default fake may ignore the callback:

```ts
async activateProject(
  _model,
  _signal,
  semanticWarming,
  _reportProjectProgress,
) {
  order.push("activate:start");
  semanticWarming();
  order.push("activate:ready");
},
```

- [ ] **Step 2: Add failing publication, clearing, and failure tests**

Add:

```ts
Deno.test("coordinator publishes project progress and clears it after crate graph activation", async () => {
  const entered = deferred<void>();
  const activation = deferred<void>();
  let semanticWarming!: () => void;
  let reportProjectProgress!: (progress: CrateGraphProgress) => void;
  const session = fakeSession([], {
    async activateProject(_model, _signal, warming, report) {
      semanticWarming = warming;
      reportProjectProgress = report;
      entered.resolve();
      await activation.promise;
    },
  });
  const coordinator = new StartupCoordinator(immediateDependencies(session));
  const startup = coordinator.start({ getValue: () => "edited" });
  await entered.promise;

  const before = coordinator.snapshot();
  const progress = crateProgress(3, ["rubrc_main", "core"]);
  reportProjectProgress(progress);
  const during = coordinator.snapshot();
  const projectDuring = during.tasks.find((task) => task.id === "project");

  assert(before !== during, "project progress did not publish a snapshot");
  assert(projectDuring?.projectProgress === progress, "project progress identity changed");
  assert(projectDuring?.state === "running", "Project task stopped running");

  semanticWarming();
  assertEquals(coordinator.snapshot().phase, "semantic-warming", "warming phase missing");
  assertEquals(
    coordinator.snapshot().tasks.find((task) => task.id === "project")
      ?.projectProgress,
    undefined,
    "semantic warming retained crate graph progress",
  );

  activation.resolve();
  await startup;
  assertEquals(coordinator.snapshot().phase, "ready", "startup did not finish");
  assertEquals(
    coordinator.snapshot().tasks.find((task) => task.id === "project")
      ?.projectProgress,
    undefined,
    "ready snapshot restored crate graph progress",
  );
});

Deno.test("coordinator preserves the last project progress when activation fails", async () => {
  const original = new Error("crate graph timed out after 300000ms");
  const progress = crateProgress(24, ["rubrc_main", "core", "alloc"]);
  const coordinator = new StartupCoordinator(
    immediateDependencies(
      fakeSession([], {
        async activateProject(
          _model,
          _signal,
          _semanticWarming,
          reportProjectProgress,
        ) {
          reportProjectProgress(progress);
          throw original;
        },
      }),
    ),
  );

  const caught = await coordinator.start({ getValue: () => "edited" }).then(
    () => undefined,
    (error) => error,
  );
  const snapshot = coordinator.snapshot();
  const project = snapshot.tasks.find((task) => task.id === "project");

  assert(caught === original, "activation failure identity changed");
  assertEquals(snapshot.phase, "failed", "failure phase missing");
  assertEquals(project?.state, "failed", "Project task did not fail");
  assert(project?.projectProgress === progress, "failure discarded project progress");
  assertEquals(snapshot.error, original.message, "timeout message changed");
});
```

- [ ] **Step 3: Add a failing late-progress guard test**

Add this test using the existing `deferred`, `fakeSession`, and
`immediateDependencies` helpers:

```ts
Deno.test("coordinator ignores project progress after abort and generation disposal", async () => {
  for (const cancellation of ["abort", "dispose"] as const) {
    const entered = deferred<void>();
    const activation = deferred<void>();
    let reportProjectProgress!: (progress: CrateGraphProgress) => void;
    const coordinator = new StartupCoordinator(
      immediateDependencies(
        fakeSession([], {
          async activateProject(
            _model,
            _signal,
            _semanticWarming,
            report,
          ) {
            reportProjectProgress = report;
            entered.resolve();
            await activation.promise;
          },
        }),
      ),
    );
    const startup = coordinator.start({ getValue: () => "edited" }).catch(
      () => {},
    );
    await entered.promise;

    let disposal: Promise<void> | undefined;
    if (cancellation === "abort") {
      coordinator.abort(new Error("startup aborted"));
    } else {
      disposal = coordinator.dispose();
    }

    const cancelledSnapshot = coordinator.snapshot();
    reportProjectProgress(crateProgress(9, ["rubrc_main", "core"]));
    assert(
      coordinator.snapshot() === cancelledSnapshot,
      `${cancellation} accepted late project progress`,
    );

    activation.resolve();
    await startup;
    await disposal;
  }
});
```

- [ ] **Step 4: Run coordinator tests and confirm task progress is absent**

Run:

```sh
deno test --no-lock page/src/startup_coordinator_test.ts
```

Expected: FAIL because startup tasks have no `projectProgress` and the fourth callback is not supplied.

- [ ] **Step 5: Add the task field and guarded publisher**

Add to the task shape:

```ts
projectProgress?: CrateGraphProgress;
```

Pass the callback from `#run`:

```ts
await analyzer.activateProject(
  model,
  signal,
  () => this.#setPhase(generation, "semantic-warming"),
  (progress) => this.#reportProjectProgress(generation, progress),
);
```

Add:

```ts
#reportProjectProgress(
  generation: number,
  projectProgress: CrateGraphProgress,
): void {
  if (
    generation !== this.#generation ||
    this.#controller.signal.aborted ||
    this.#snapshot.phase !== "project-activating"
  ) return;

  const tasks = this.#snapshot.tasks.map((task) =>
    task.id === "project"
      ? { ...task, state: "running" as const, projectProgress }
      : task
  );
  this.#publish(freezeSnapshot(generation, this.#snapshot.phase, tasks));
}
```

- [ ] **Step 6: Clear progress only after successful crate-graph activation**

In `taskStateForPhase`, after deriving `state`, add:

```ts
const clearProjectProgress =
  task.id === "project" &&
  (phase === "semantic-warming" || phase === "ready");

if (
  task.state === state &&
  (!clearProjectProgress || task.projectProgress === undefined)
) return task;

return {
  ...task,
  state,
  ...(clearProjectProgress ? { projectProgress: undefined } : {}),
};
```

Do not alter `#setFailed`; its existing task spread preserves `projectProgress` while changing running tasks to failed.

- [ ] **Step 7: Run coordinator tests**

Run:

```sh
deno test --no-lock page/src/startup_coordinator_test.ts
```

Expected: PASS for publication, semantic/ready clearing, failure retention, abort suppression, disposal suppression, and existing snapshot immutability tests.

---

### Task 4: Format and Render Project Progress

**Files:**
- Create: `page/src/startup_overlay_progress.ts`
- Create: `page/src/startup_overlay_progress_test.ts`
- Modify: `page/src/StartupOverlay.tsx:1-66`
- Modify: `page/src/lsp_start_gate_test.ts:293-322`

**Interfaces:**
- Consumes: startup task `projectProgress` from Task 3.
- Produces: `presentProjectProgress(progress): { summary: string; detail: string }` and stable `data-startup-task` markup.

- [ ] **Step 1: Write failing pure presentation tests**

Create `startup_overlay_progress_test.ts`:

```ts
import type { CrateGraphProgress } from "./rust_analyzer_readiness.ts";
import { presentProjectProgress } from "./startup_overlay_progress.ts";

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
};

const progress = (
  labels: readonly string[],
  elapsedMs = 125_999,
): CrateGraphProgress => ({
  attempt: 24,
  elapsedMs,
  remainingMs: 174_001,
  labels,
  ready: labels.length === 4,
});

Deno.test("project progress presentation renders partial crate discovery", () => {
  const presentation = presentProjectProgress(
    progress(["rubrc_main", "core", "alloc"]),
  );
  assertEquals(presentation.summary, "125s · poll 24 · crates 3/4", "wrong summary");
  assertEquals(
    presentation.detail,
    "rubrc_main, core, alloc · waiting: std",
    "wrong partial detail",
  );
});

Deno.test("project progress presentation renders retry and readiness", () => {
  assertEquals(
    presentProjectProgress(progress([], 5_000)).detail,
    "waiting: rubrc_main, core, alloc, std",
    "empty graph detail is ambiguous",
  );
  assertEquals(
    presentProjectProgress(
      progress(["rubrc_main", "core", "alloc", "std"], 130_000),
    ).detail,
    "rubrc_main, core, alloc, std",
    "ready graph retained a waiting label",
  );
});
```

- [ ] **Step 2: Run the presentation test and confirm the module is missing**

Run:

```sh
deno test --no-lock page/src/startup_overlay_progress_test.ts
```

Expected: FAIL because `startup_overlay_progress.ts` does not exist.

- [ ] **Step 3: Implement the pure formatter**

Create `startup_overlay_progress.ts`:

```ts
import type { CrateGraphProgress } from "./rust_analyzer_readiness.ts";

const REQUIRED_CRATE_LABELS = ["rubrc_main", "core", "alloc", "std"] as const;

export type ProjectProgressPresentation = {
  summary: string;
  detail: string;
};

export function presentProjectProgress(
  progress: CrateGraphProgress,
): ProjectProgressPresentation {
  const waiting = REQUIRED_CRATE_LABELS.filter(
    (label) => !progress.labels.includes(label),
  );
  const summary = `${Math.floor(progress.elapsedMs / 1_000)}s · poll ${progress.attempt} · crates ${progress.labels.length}/${REQUIRED_CRATE_LABELS.length}`;
  const found = progress.labels.join(", ");
  const detail = waiting.length === 0
    ? found
    : found.length === 0
    ? `waiting: ${waiting.join(", ")}`
    : `${found} · waiting: ${waiting.join(", ")}`;
  return { summary, detail };
}
```

- [ ] **Step 4: Run presentation tests**

Run:

```sh
deno test --no-lock page/src/startup_overlay_progress_test.ts
```

Expected: both tests PASS.

- [ ] **Step 5: Add a failing overlay source contract**

In `lsp_start_gate_test.ts`, add:

```ts
Deno.test("overlay renders structured project progress while running and failed", async () => {
  const source = await readSource("page/src/StartupOverlay.tsx");
  assert(
    source.includes("presentProjectProgress(projectProgress)") &&
      source.includes("{details().summary}") &&
      source.includes("{details().detail}"),
    "overlay does not render structured project progress",
  );
  assert(
    source.includes('data-startup-task={task.id}'),
    "overlay lacks a stable task selector",
  );
  assert(
    source.includes("col-span-2") && source.includes("break-words"),
    "project labels cannot wrap within the overlay",
  );
});
```

- [ ] **Step 6: Render structured details for running and failed Project tasks**

Import `presentProjectProgress`. In each task row, derive:

```tsx
const projectProgress = task.id === "project" ? task.projectProgress : undefined;
const presentation = projectProgress === undefined
  ? undefined
  : presentProjectProgress(projectProgress);
```

Change the row grid and selector to:

```tsx
<div
  class="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1"
  data-startup-task={task.id}
>
```

Use this detail branch before the existing numeric/indeterminate fallback:

```tsx
<Show
  when={presentation}
  fallback={
    <Show when={task.state === "running"}>
      {task.progress === undefined ? (
        <span class="animate-pulse text-green-400" aria-label="in progress">
          ...
        </span>
      ) : (
        <span class="text-green-400">{Math.round(task.progress)}%</span>
      )}
    </Show>
  }
>
  {(details) => (
    <>
      <span class={task.state === "failed" ? "text-red-400" : "text-green-400"}>
        {details().summary}
      </span>
      <span class="col-start-2 col-span-2 min-w-0 whitespace-normal break-words text-gray-400">
        {details().detail}
      </span>
    </>
  )}
</Show>
```

Keep the current status glyph and task label logic unchanged. Because `presentation` is independent of `task.state === "running"`, failed Project tasks retain the last details.

- [ ] **Step 7: Run overlay tests and build**

Run:

```sh
deno test --no-lock --allow-read \
  page/src/startup_overlay_progress_test.ts \
  page/src/lsp_start_gate_test.ts
bun run --cwd page build
```

Expected: all focused tests PASS and Vite build completes successfully.

---

### Task 5: Retain the Production Event in the Test API

**Files:**
- Modify: `page/src/lsp_test_api_state_test.ts`
- Modify: `page/src/lsp_test_api_state.ts:22-30`
- Modify: `page/src/lsp_test_api.ts:359-380`

**Interfaces:**
- Consumes: coordinator task `projectProgress` from Task 3.
- Produces: retained `StartupTestState.projectProgress` and pure `createStartupTestState(previous, snapshot)`.

- [ ] **Step 1: Add failing state-retention tests**

Import `CrateGraphProgress`, `StartupSnapshot`, and `createStartupTestState`. Add:

```ts
const startupSnapshot = (
  phase: StartupSnapshot["phase"],
  projectProgress?: CrateGraphProgress,
): StartupSnapshot => ({
  generation: 1,
  phase,
  tasks: [{
    id: "project",
    label: "Project",
    state: phase === "failed" ? "failed" : phase === "ready" ? "complete" : "running",
    ...(projectProgress === undefined ? {} : { projectProgress }),
  }],
  ...(phase === "failed" ? { error: "startup failed" } : {}),
});

Deno.test("startup test state retains the exact production crate graph event", () => {
  const projectProgress: CrateGraphProgress = Object.freeze({
    attempt: 4,
    elapsedMs: 15_000,
    remainingMs: 285_000,
    labels: Object.freeze(["rubrc_main", "core", "alloc", "std"]),
    ready: true,
  });
  const activating = createStartupTestState(
    undefined,
    startupSnapshot("project-activating", projectProgress),
  );
  const warming = createStartupTestState(activating, startupSnapshot("semantic-warming"));
  const ready = createStartupTestState(warming, startupSnapshot("ready"));

  assert(activating.projectProgress === projectProgress, "production event was cloned");
  assert(ready.projectProgress === projectProgress, "latest event was discarded");
  assert(
    ready.history.join(",") === "project-activating,semantic-warming,ready",
    `wrong history: ${ready.history}`,
  );
  assert(!ready.overlayVisible, "ready test state retained the overlay");
});

Deno.test("startup test state preserves project progress on failure", () => {
  const projectProgress: CrateGraphProgress = Object.freeze({
    attempt: 24,
    elapsedMs: 295_000,
    remainingMs: 5_000,
    labels: Object.freeze(["rubrc_main", "core", "alloc"]),
    ready: false,
  });
  const failed = createStartupTestState(
    createStartupTestState(undefined, startupSnapshot("project-activating", projectProgress)),
    startupSnapshot("failed", projectProgress),
  );
  assert(failed.projectProgress === projectProgress, "failure lost polling progress");
  assert(failed.history.join(",") === "project-activating,failed", "wrong failed history");
});
```

- [ ] **Step 2: Run the state test and confirm the builder is missing**

Run:

```sh
deno test --no-lock page/src/lsp_test_api_state_test.ts
```

Expected: FAIL because `StartupTestState.projectProgress` and `createStartupTestState` do not exist.

- [ ] **Step 3: Add the retained state type and pure builder**

Add to `StartupTestState`:

```ts
projectProgress?: CrateGraphProgress;
```

Add to `lsp_test_api.ts`:

```ts
export function createStartupTestState(
  previous: StartupTestState | undefined,
  snapshot: StartupSnapshot,
): StartupTestState {
  const projectProgress =
    snapshot.tasks.find((task) => task.id === "project")?.projectProgress ??
      previous?.projectProgress;
  const history = previous?.history ?? [];

  return {
    phase: snapshot.phase,
    history: history.at(-1) === snapshot.phase
      ? [...history]
      : [...history, snapshot.phase],
    overlayVisible: snapshot.phase !== "ready",
    crateGraphReady: previous?.crateGraphReady ?? false,
    diagnosticsVersion: previous?.diagnosticsVersion,
    inlayHintVersion: previous?.inlayHintVersion,
    cargoCallsBeforeProjectActivation:
      previous?.cargoCallsBeforeProjectActivation ?? 0,
    ...(projectProgress === undefined ? {} : { projectProgress }),
  };
}
```

Replace the object reconstruction in `recordStartupTestState` with:

```ts
generation.record((state) => {
  state.startup = createStartupTestState(state.startup, snapshot);
});
```

Do not use `requestCrateGraph()` to populate progress.

- [ ] **Step 4: Run retained-state and existing generation-isolation tests**

Run:

```sh
deno test --no-lock page/src/lsp_test_api_state_test.ts
```

Expected: all state, history, retention, and generation tests PASS.

---

### Task 6: Verify the Built Browser Artifact

**Files:**
- Modify: `scripts/lsp_browser_diagnostics_contract_test.ts`
- Modify: `scripts/lsp_browser_diagnostics_test.mjs:519-715`

**Interfaces:**
- Consumes: `window.__rubrcLspTest.startup.projectProgress` from Task 5 and rendered overlay text from Task 4.
- Produces: actual-artifact proof that startup progress comes from the production polling loop and does not change readiness semantics.

- [ ] **Step 1: Add a failing browser harness contract**

Add:

```ts
Deno.test("browser acceptance observes production crate graph progress without probing for it", async () => {
  const source = await Deno.readTextFile("scripts/lsp_browser_diagnostics_test.mjs");
  assert(
    source.includes("projectProgressCaptures") &&
      source.includes("value?.projectProgress") &&
      source.includes("document.body.innerText"),
    "browser acceptance does not capture rendered production progress",
  );
  assert(
    source.includes("const progress = api.startup.projectProgress;") &&
      source.includes("Object.isFrozen(progress)") &&
      source.includes('"rubrc_main,core,alloc,std"'),
    "browser acceptance does not verify the immutable ready event",
  );
  const start = source.indexOf("const progress = api.startup.projectProgress;");
  const end = source.indexOf("const analysisDeadline", start);
  assert(
    start >= 0 && !source.slice(start, end).includes("requestCrateGraph"),
    "startup progress assertion issues another graph request",
  );
});
```

- [ ] **Step 2: Run the contract and confirm capture logic is absent**

Run:

```sh
deno test --no-lock --allow-read scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: FAIL because the harness does not collect `projectProgressCaptures`.

- [ ] **Step 3: Capture production snapshots and overlay text**

Add these fields to the browser harness state:

```js
projectProgressCaptures: [],
projectBeforeFirstPollText: undefined,
```

Inside the existing startup Proxy `set` trap, add:

```js
if (property === "startup" && value?.phase === "project-activating") {
  const overlayText = document.body.innerText;
  if (
    value.projectProgress === undefined &&
    target.projectBeforeFirstPollText === undefined
  ) {
    Reflect.set(target, "projectBeforeFirstPollText", overlayText);
  }
  if (value?.projectProgress !== undefined) {
    const last = target.projectProgressCaptures.at(-1);
    if (last?.progress?.attempt !== value.projectProgress.attempt) {
      target.projectProgressCaptures.push({
        progress: value.projectProgress,
        overlayText,
      });
    }
  }
}
```

Require the final readiness wait to include:

```js
testApi.startup.projectProgress?.ready === true &&
testApi.projectProgressCaptures.length > 0
```

- [ ] **Step 4: Assert indeterminate, running, immutable, and ready states**

After startup readiness and before diagnostics quiescence, add:

```js
await page.evaluate(() => {
  const api = window.__rubrcLspTest;
  const progress = api.startup.projectProgress;
  if (progress === undefined) {
    throw new Error("startup test state lacks production crate graph progress");
  }
  if (!Object.isFrozen(progress) || !Object.isFrozen(progress.labels)) {
    throw new Error("production crate graph progress is mutable");
  }
  if (!progress.ready || progress.attempt < 1) {
    throw new Error(`invalid ready crate graph progress: ${JSON.stringify(progress)}`);
  }
  if (progress.labels.join(",") !== "rubrc_main,core,alloc,std") {
    throw new Error(`unstable ready crate labels: ${progress.labels.join(",")}`);
  }
  const initialText = api.projectBeforeFirstPollText ?? "";
  if (!initialText.includes("Project") || !initialText.includes("...")) {
    throw new Error(`Project did not render indeterminate startup: ${initialText}`);
  }
  const capture = api.projectProgressCaptures.find(
    (item) => item.progress === progress,
  ) ?? api.projectProgressCaptures.at(-1);
  if (capture === undefined) {
    throw new Error("ready project progress was not captured from the overlay");
  }
  const expectedSummary = `${Math.floor(progress.elapsedMs / 1_000)}s · poll ${progress.attempt} · crates 4/4`;
  if (!capture.overlayText.includes(expectedSummary)) {
    throw new Error(`overlay omitted ${expectedSummary}: ${capture.overlayText}`);
  }
  for (const label of ["rubrc_main", "core", "alloc", "std"]) {
    if (!capture.overlayText.includes(label)) {
      throw new Error(`overlay omitted ${label}: ${capture.overlayText}`);
    }
  }
});
```

Replace the final successful-startup `requestCrateGraph()` readiness probe with:

```js
const progress = api.startup.projectProgress;
if (
  progress?.ready !== true ||
  progress.labels.join(",") !== "rubrc_main,core,alloc,std"
) {
  throw new Error(
    `production crate graph progress is incomplete: ${JSON.stringify(progress)}`,
  );
}
```

Keep the cold-start failure diagnostic probe unchanged; it runs only after failure and is not the source of startup progress.

- [ ] **Step 5: Run the browser contract**

Run:

```sh
deno test --no-lock --allow-read scripts/lsp_browser_diagnostics_contract_test.ts
```

Expected: PASS and no successful-startup progress assertion calls `requestCrateGraph()`.

- [ ] **Step 6: Format and run the complete focused suite**

Run:

```sh
bun x @biomejs/biome format --write \
  page/src/rust_analyzer_readiness.ts \
  page/src/rust_analyzer_readiness_test.ts \
  page/src/rust_lsp_startup.ts \
  page/src/rust_lsp_client.ts \
  page/src/rust_lsp_client_test.ts \
  page/src/startup_coordinator.ts \
  page/src/startup_coordinator_test.ts \
  page/src/startup_overlay_progress.ts \
  page/src/startup_overlay_progress_test.ts \
  page/src/StartupOverlay.tsx \
  page/src/lsp_test_api_state.ts \
  page/src/lsp_test_api.ts \
  page/src/lsp_test_api_state_test.ts \
  page/src/lsp_start_gate_test.ts \
  page/src/App.tsx \
  scripts/lsp_browser_diagnostics_contract_test.ts \
  scripts/lsp_browser_diagnostics_test.mjs

deno test --no-lock --allow-read \
  page/src/rust_analyzer_readiness_test.ts \
  page/src/rust_lsp_client_test.ts \
  page/src/startup_coordinator_test.ts \
  page/src/startup_overlay_progress_test.ts \
  page/src/lsp_test_api_state_test.ts \
  page/src/lsp_start_gate_test.ts \
  scripts/lsp_browser_diagnostics_contract_test.ts

bun run --cwd page build
git diff --check
```

Expected: formatter succeeds, all focused tests PASS, Vite build succeeds, and `git diff --check` produces no output.

- [ ] **Step 7: Run actual-artifact browser acceptance**

Port 4173 is reserved by the user's preview. Run:

```sh
RUBRC_LSP_BROWSER_PORT=4174 bun run test:lsp-browser
```

Expected: browser startup reaches ready, captures immutable production crate-graph progress, renders the expected Project text, and completes existing diagnostics publish/clear assertions.
