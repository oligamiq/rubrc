import {
  type CrateGraphProgress,
  RustAnalyzerReadiness,
} from "./rust_analyzer_readiness.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const uri = "file:///src/main.rs";
const graph = (nodes: string) =>
  `digraph rust_analyzer_crate_graph {\n${nodes}\n}`;
const mainNode = '  _0 [label="rubrc_main"];';
const coreNode = '  _1 [label="core"];';
const allocNode = '  _2 [label="alloc"];';
const stdNode = '  _3 [label="std"];';
const readyNodes = `${mainNode}\n${coreNode}\n${allocNode}\n${stdNode}`;

Deno.test("crate graph recognizes exact RA node labels only", async () => {
  const nearGraphs = [
    graph(
      '  _0 [label="rubrc_main_extra"];\n' +
        `${coreNode}\n${allocNode}\n${stdNode}`,
    ),
    graph(`${mainNode}\n  _1 [label="core2"];\n${allocNode}\n${stdNode}`),
    graph(
      `${mainNode}\n  _0 -> _1 [label="core"];\n${allocNode}\n${stdNode}`,
    ),
    graph(
      `${mainNode}\n  _1 [label="co\\re"];\n${allocNode}\n${stdNode}`,
    ),
    graph(
      `${mainNode}\n  node [label="core"];\n${allocNode}\n${stdNode}`,
    ),
    graph(`${mainNode}\n${coreNode}\n  _2 [label="alloc2"];\n${stdNode}`),
    graph(`${mainNode}\n${coreNode}\n${allocNode}\n  _3 [label="std2"];`),
  ];
  const actualRaGraph = graph(
    '  _0[label="rubrc_main"][tooltip="workspace -> sysroot"][shape="box"];\n' +
      '  _1[label="core"][shape="box"];\n' +
      '  _2[label="alloc"][shape="box"];\n' +
      '  _3[label="std"][shape="box"];\n' +
      '  _0 -> _1 [label="core", color="blue"];\n' +
      '  _0 -> _3 [label="std", color="blue"];',
  );
  let requests = 0;
  let now = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(): Promise<R> {
        requests++;
        return (nearGraphs.shift() ?? actualRaGraph) as R;
      },
    },
    uri,
    {
      now: () => now,
      sleep: async () => {
        now++;
      },
      timeoutMs: 10,
    },
  );

  await readiness.waitForCrateGraph(new AbortController().signal);

  assert(requests === 8, `accepted a non-exact graph after ${requests} polls`);
});

Deno.test("crate graph polling requires main, core, alloc, and std in the full graph", async () => {
  const responses = [
    graph(""),
    graph(mainNode),
    graph(`${mainNode}\n${coreNode}`),
    graph(`${coreNode}\n${allocNode}\n${stdNode}`),
    graph(`${mainNode}\n${allocNode}\n${stdNode}`),
    graph(`${mainNode}\n${coreNode}\n${stdNode}`),
    graph(`${mainNode}\n${coreNode}\n${allocNode}`),
    graph(readyNodes),
  ];
  const requests: Array<{ method: string; params: unknown }> = [];
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string, params: unknown): Promise<R> {
        requests.push({ method, params });
        return responses.shift() as R;
      },
    },
    uri,
    { sleep: async () => {} },
  );

  await readiness.waitForCrateGraph(new AbortController().signal);

  assert(requests.length === 8, `resolved after ${requests.length} polls`);
  assert(
    requests.every(
      (request) =>
        request.method === "rust-analyzer/viewCrateGraph" &&
        JSON.stringify(request.params) === JSON.stringify({ full: true }),
    ),
    `wrong graph request: ${JSON.stringify(requests)}`,
  );
});

Deno.test("crate graph retries only ContentModified request failures", async () => {
  let requests = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(): Promise<R> {
        requests++;
        if (requests === 1) throw { code: -32801 };
        return graph(readyNodes) as R;
      },
    },
    uri,
    { sleep: async () => {} },
  );

  await readiness.waitForCrateGraph(new AbortController().signal);
  assert(requests === 2, `crate graph issued ${requests} requests`);
});

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

  await readiness.waitForCrateGraph(new AbortController().signal, (event) =>
    progress.push(event),
  );

  assert(progress.length === 2, `emitted ${progress.length} progress events`);
  assert(progress[0].attempt === 1, "first attempt was not numbered one");
  assert(progress[1].attempt === 2, "second attempt was not numbered two");
  assert(
    progress[0].elapsedMs === 0,
    `wrong first elapsed: ${progress[0].elapsedMs}`,
  );
  assert(
    progress[1].elapsedMs === 5_000,
    `wrong second elapsed: ${progress[1].elapsedMs}`,
  );
  assert(
    progress[0].remainingMs === 20_000 && progress[1].remainingMs === 15_000,
    `wrong remaining times: ${progress.map((event) => event.remainingMs)}`,
  );
  assert(
    progress[0].labels.join(",") === "core,std",
    `unstable partial labels: ${progress[0].labels}`,
  );
  assert(
    progress[1].labels.join(",") === "rubrc_main,core,alloc,std",
    `unstable ready labels: ${progress[1].labels}`,
  );
  assert(!progress[0].ready, "partial graph was reported ready");
  assert(progress[1].ready, "complete graph was reported incomplete");
  assert(Object.isFrozen(progress[0]), "progress event is mutable");
  assert(Object.isFrozen(progress[0].labels), "progress labels are mutable");
});

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

  await readiness.waitForCrateGraph(new AbortController().signal, (event) =>
    progress.push(event),
  );

  assert(requests === 2, `issued ${requests} graph requests`);
  assert(progress.length === 2, `emitted ${progress.length} progress events`);
  assert(
    progress[0].attempt === 1 &&
      progress[0].labels.length === 0 &&
      !progress[0].ready,
    `wrong ContentModified progress: ${JSON.stringify(progress[0])}`,
  );
  assert(
    progress[1].attempt === 2 && progress[1].ready,
    "retry did not report readiness",
  );
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

  await readiness.waitForCrateGraph(new AbortController().signal, () => {
    throw new Error("observer failed");
  });

  assert(
    requests === 2,
    `observer stopped readiness after ${requests} requests`,
  );
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

  const caught = await readiness
    .waitForCrateGraph(new AbortController().signal, () => events++)
    .then(
      () => undefined,
      (error) => error,
    );

  assert(caught === expected, "ordinary graph error identity changed");
  assert(events === 0, `ordinary error emitted ${events} progress events`);
});

Deno.test("semantic readiness rejects pre-graph diagnostics and converts the full range", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  let sleeps = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string, params: unknown): Promise<R> {
        requests.push({ method, params });
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(readyNodes) as R;
        }
        return [] as R;
      },
    },
    uri,
    {
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) {
          readiness.observeMessage({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri, version: 7, diagnostics: [] },
          });
        }
      },
    },
  );
  readiness.observeMessage({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, version: 7, diagnostics: [] },
  });
  await readiness.waitForCrateGraph(new AbortController().signal);

  await readiness.waitForSemanticReadiness(
    {
      getVersionId: () => 7,
      getFullModelRange: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 4,
        endColumn: 9,
      }),
    },
    new AbortController().signal,
  );

  const hints = requests.filter(
    (request) => request.method === "textDocument/inlayHint",
  );
  assert(sleeps === 2, `pre-graph diagnostics counted after ${sleeps} sleeps`);
  assert(hints.length === 1, `issued ${hints.length} hint requests`);
  assert(
    JSON.stringify(hints[0].params) ===
      JSON.stringify({
        textDocument: { uri },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 3, character: 8 },
        },
      }),
    `wrong hint range: ${JSON.stringify(hints[0].params)}`,
  );
});

Deno.test("document changes clear diagnostics and invalidate an in-flight hint", async () => {
  let version = 1;
  let sleeps = 0;
  const hintVersions: number[] = [];
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string): Promise<R> {
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(readyNodes) as R;
        }
        hintVersions.push(version);
        if (hintVersions.length === 1) {
          version = 2;
          readiness.noteDocumentChanged(version);
          readiness.observeMessage({
            method: "textDocument/publishDiagnostics",
            params: { uri, version, diagnostics: [] },
          });
        }
        return [] as R;
      },
    },
    uri,
    {
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) {
          readiness.observeMessage({
            method: "textDocument/publishDiagnostics",
            params: { uri, version: 1, diagnostics: [] },
          });
        }
      },
    },
  );
  await readiness.waitForCrateGraph(new AbortController().signal);

  await readiness.waitForSemanticReadiness(
    {
      getVersionId: () => version,
      getFullModelRange: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      }),
    },
    new AbortController().signal,
  );

  assert(sleeps === 2, `edit did not restart quiet window: ${sleeps}`);
  assert(hintVersions.join(",") === "1,2", `wrong probes: ${hintVersions}`);
});

Deno.test("an edit partway through a sleep restarts the complete quiet window", async () => {
  let now = 0;
  let version = 1;
  let sleeps = 0;
  let hints = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string): Promise<R> {
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(readyNodes) as R;
        }
        hints++;
        return [] as R;
      },
    },
    uri,
    {
      now: () => now,
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) {
          now += 125;
          version = 2;
          readiness.noteDocumentChanged(version);
          readiness.observeMessage({
            method: "textDocument/publishDiagnostics",
            params: { uri, version, diagnostics: [] },
          });
          return;
        }
        now += 250;
      },
    },
  );
  await readiness.waitForCrateGraph(new AbortController().signal);

  await readiness.waitForSemanticReadiness(
    {
      getVersionId: () => version,
      getFullModelRange: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      }),
    },
    new AbortController().signal,
  );

  assert(sleeps === 2, `edit shortened quiet window to ${sleeps} sleeps`);
  assert(hints === 1, `issued ${hints} hints`);
});

Deno.test("out-of-order stale diagnostics cannot erase the latest version", async () => {
  let now = 0;
  let hints = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string): Promise<R> {
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(readyNodes) as R;
        }
        hints++;
        return [] as R;
      },
    },
    uri,
    {
      now: () => now,
      sleep: async () => {
        now += 250;
        readiness.observeMessage({
          method: "textDocument/publishDiagnostics",
          params: { uri, version: 2, diagnostics: [] },
        });
        readiness.observeMessage({
          method: "textDocument/publishDiagnostics",
          params: { uri, version: 1, diagnostics: [] },
        });
      },
    },
  );
  await readiness.waitForCrateGraph(new AbortController().signal);

  await readiness.waitForSemanticReadiness(
    {
      getVersionId: () => 2,
      getFullModelRange: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      }),
    },
    new AbortController().signal,
  );

  assert(hints === 1, `latest diagnostics were erased before ${hints} hints`);
});

Deno.test("ContentModified retries after another quiet window", async () => {
  let sleeps = 0;
  let hints = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string): Promise<R> {
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(readyNodes) as R;
        }
        hints++;
        if (hints === 1) throw { code: -32801, message: "Content modified" };
        return [] as R;
      },
    },
    uri,
    {
      sleep: async () => {
        sleeps++;
        readiness.observeMessage({
          method: "textDocument/publishDiagnostics",
          params: { uri, version: 3, diagnostics: [] },
        });
      },
    },
  );
  await readiness.waitForCrateGraph(new AbortController().signal);

  await readiness.waitForSemanticReadiness(
    {
      getVersionId: () => 3,
      getFullModelRange: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      }),
    },
    new AbortController().signal,
  );

  assert(hints === 2, `ContentModified issued ${hints} probes`);
  assert(
    sleeps === 2,
    `ContentModified retried without quiet window: ${sleeps}`,
  );
});

Deno.test("non-ContentModified hint failures fail semantic readiness", async () => {
  const expected = new Error("hint failed");
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string): Promise<R> {
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(readyNodes) as R;
        }
        throw expected;
      },
    },
    uri,
    {
      sleep: async () => {
        readiness.observeMessage({
          method: "textDocument/publishDiagnostics",
          params: { uri, version: 4, diagnostics: [] },
        });
      },
    },
  );
  await readiness.waitForCrateGraph(new AbortController().signal);

  let caught: unknown;
  try {
    await readiness.waitForSemanticReadiness(
      {
        getVersionId: () => 4,
        getFullModelRange: () => ({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        }),
      },
      new AbortController().signal,
    );
  } catch (error) {
    caught = error;
  }
  assert(
    caught === expected,
    "non-ContentModified request error was swallowed",
  );
});

Deno.test("crate graph polling has a deterministic phase timeout", async () => {
  let now = 0;
  let requests = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(): Promise<R> {
        requests++;
        return graph("") as R;
      },
    },
    uri,
    {
      now: () => now,
      sleep: async () => {
        now += 250;
      },
      timeoutMs: 500,
    },
  );

  let message = "";
  try {
    await readiness.waitForCrateGraph(new AbortController().signal);
  } catch (error) {
    message = String(error);
  }
  assert(
    message.includes("timed out after 500ms"),
    `wrong timeout: ${message}`,
  );
  assert(requests === 2, `unexpected timeout poll count: ${requests}`);
});

Deno.test("a never-settling crate graph request is bounded by abort", async () => {
  const controller = new AbortController();
  const readiness = new RustAnalyzerReadiness(
    { sendRequest: () => new Promise<never>(() => {}) },
    uri,
    { timeoutMs: 100 },
  );
  const waiting = readiness.waitForCrateGraph(controller.signal);
  controller.abort("graph-aborted");

  let caught: unknown;
  try {
    await waiting;
  } catch (error) {
    caught = error;
  }
  assert(caught === "graph-aborted", `wrong abort: ${String(caught)}`);
});

Deno.test("a never-settling crate graph request times out", async () => {
  const readiness = new RustAnalyzerReadiness(
    { sendRequest: () => new Promise<never>(() => {}) },
    uri,
    { timeoutMs: 10 },
  );

  let message = "";
  try {
    await readiness.waitForCrateGraph(new AbortController().signal);
  } catch (error) {
    message = String(error);
  }
  assert(message.includes("timed out after 10ms"), `wrong timeout: ${message}`);
});

Deno.test("a crate graph response settling after its deadline still fails", async () => {
  let now = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(): Promise<R> {
        now = 11;
        return graph(readyNodes) as R;
      },
    },
    uri,
    { now: () => now, timeoutMs: 10 },
  );

  let message = "";
  try {
    await readiness.waitForCrateGraph(new AbortController().signal);
  } catch (error) {
    message = String(error);
  }
  assert(
    message.includes("timed out after 10ms"),
    `late graph passed: ${message}`,
  );
});

Deno.test("a sleep settling after its deadline still fails", async () => {
  let now = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(): Promise<R> {
        return graph("") as R;
      },
    },
    uri,
    {
      now: () => now,
      sleep: async () => {
        now = 11;
      },
      timeoutMs: 10,
    },
  );

  let message = "";
  try {
    await readiness.waitForCrateGraph(new AbortController().signal);
  } catch (error) {
    message = String(error);
  }
  assert(
    message.includes("timed out after 10ms"),
    `late sleep passed: ${message}`,
  );
});

Deno.test("abort and dispose promptly interrupt pending sleeps", async () => {
  for (const cancel of ["abort", "dispose"] as const) {
    const controller = new AbortController();
    const readiness = new RustAnalyzerReadiness(
      {
        async sendRequest<R>(): Promise<R> {
          return graph("") as R;
        },
      },
      uri,
      { sleep: () => new Promise<never>(() => {}), timeoutMs: 100 },
    );
    const waiting = readiness.waitForCrateGraph(controller.signal);
    await Promise.resolve();
    if (cancel === "abort") controller.abort("sleep-aborted");
    else readiness.dispose();

    let message = "";
    try {
      await waiting;
    } catch (error) {
      message = String(error);
    }
    assert(
      cancel === "abort"
        ? message === "sleep-aborted"
        : message.includes("disposed"),
      `${cancel} did not interrupt sleep: ${message}`,
    );
  }
});

Deno.test("abort interrupts a never-settling inlay-hint request", async () => {
  const controller = new AbortController();
  let inlayStarted!: () => void;
  const started = new Promise<void>((resolve) => (inlayStarted = resolve));
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string): Promise<R> {
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(readyNodes) as R;
        }
        inlayStarted();
        return await new Promise<never>(() => {});
      },
    },
    uri,
    {
      sleep: async () => {
        readiness.observeMessage({
          method: "textDocument/publishDiagnostics",
          params: { uri, version: 5, diagnostics: [] },
        });
      },
      timeoutMs: 100,
    },
  );
  await readiness.waitForCrateGraph(controller.signal);
  const waiting = readiness.waitForSemanticReadiness(
    {
      getVersionId: () => 5,
      getFullModelRange: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      }),
    },
    controller.signal,
  );
  await started;
  controller.abort("hint-aborted");

  let caught: unknown;
  try {
    await waiting;
  } catch (error) {
    caught = error;
  }
  assert(caught === "hint-aborted", `wrong hint abort: ${String(caught)}`);
});
