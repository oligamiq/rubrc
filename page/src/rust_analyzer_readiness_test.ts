import { RustAnalyzerReadiness } from "./rust_analyzer_readiness.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const uri = "file:///src/main.rs";
const graph = (nodes: string) =>
  `digraph rust_analyzer_crate_graph {\n${nodes}\n}`;
const mainNode = '  _0 [label="rubrc_main"];';
const coreNode = '  _1 [label="core"];';

Deno.test("crate graph recognizes exact RA node labels only", async () => {
  const nearGraphs = [
    graph('  _0 [label="rubrc_main_extra"];\n  _1 [label="core"];'),
    graph('  _0 [label="rubrc_main"];\n  _1 [label="core2"];'),
    graph('  _0 [label="rubrc_main"];\n  _0 -> _1 [label="core"];'),
    graph('  _0 [label="rubrc_main"];\n  _1 [label="co\\re"];'),
    graph('  _0 [label="rubrc_main"];\n  node [label="core"];'),
  ];
  const actualRaGraph = graph(
    '  _0[label="rubrc_main"][tooltip="workspace -> sysroot"][shape="box"];\n' +
      '  _1[label="core"][shape="box"];\n' +
      '  _0 -> _1 [label="core", color="blue"];',
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

  assert(requests === 6, `accepted a non-exact graph after ${requests} polls`);
});

Deno.test("crate graph polling requires main and core in the full graph", async () => {
  const responses = [
    graph(""),
    graph(mainNode),
    graph(coreNode),
    graph(`${mainNode}\n${coreNode}`),
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

  assert(requests.length === 4, `resolved after ${requests.length} polls`);
  assert(
    requests.every((request) =>
      request.method === "rust-analyzer/viewCrateGraph" &&
      JSON.stringify(request.params) === JSON.stringify({ full: true })
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
        return graph(`${mainNode}\n${coreNode}`) as R;
      },
    },
    uri,
    { sleep: async () => {} },
  );

  await readiness.waitForCrateGraph(new AbortController().signal);
  assert(requests === 2, `crate graph issued ${requests} requests`);
});

Deno.test("semantic readiness rejects pre-graph diagnostics and converts the full range", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  let sleeps = 0;
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string, params: unknown): Promise<R> {
        requests.push({ method, params });
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(`${mainNode}\n${coreNode}`) as R;
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

  const hints = requests.filter((request) =>
    request.method === "textDocument/inlayHint"
  );
  assert(sleeps === 2, `pre-graph diagnostics counted after ${sleeps} sleeps`);
  assert(hints.length === 1, `issued ${hints.length} hint requests`);
  assert(
    JSON.stringify(hints[0].params) === JSON.stringify({
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
          return graph(`${mainNode}\n${coreNode}`) as R;
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
          return graph(`${mainNode}\n${coreNode}`) as R;
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
          return graph(`${mainNode}\n${coreNode}`) as R;
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
          return graph(`${mainNode}\n${coreNode}`) as R;
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
          return graph(`${mainNode}\n${coreNode}`) as R;
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
        return graph(`${mainNode}\n${coreNode}`) as R;
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
  const started = new Promise<void>((resolve) => inlayStarted = resolve);
  const readiness = new RustAnalyzerReadiness(
    {
      async sendRequest<R>(method: string): Promise<R> {
        if (method === "rust-analyzer/viewCrateGraph") {
          return graph(`${mainNode}\n${coreNode}`) as R;
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
