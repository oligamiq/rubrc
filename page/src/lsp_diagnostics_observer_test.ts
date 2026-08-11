const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const observerModule = import("./lsp_diagnostics_observer.ts").catch(() =>
  undefined
);

Deno.test("diagnostics publication observation forwards unchanged", async () => {
  const observer = await observerModule;
  assert(observer, "diagnostics observer module is missing");

  const state = { mainDiagnosticsPublicationCount: 0 };
  const uri = { toString: () => "file:///src/main.rs" };
  const diagnostics = [{ message: "expected diagnostic" }];
  const continuationResult = Symbol("continuation result");
  let forwardedUri: unknown;
  let forwardedDiagnostics: unknown;

  const result = observer.observeDiagnosticsPublication(
    state,
    uri,
    diagnostics,
    (nextUri, nextDiagnostics) => {
      forwardedUri = nextUri;
      forwardedDiagnostics = nextDiagnostics;
      return continuationResult;
    },
  );

  assert(forwardedUri === uri, "observer changed the diagnostics URI");
  assert(
    forwardedDiagnostics === diagnostics,
    "observer changed the diagnostics payload",
  );
  assert(result === continuationResult, "observer changed the next result");
  assert(
    state.mainDiagnosticsPublicationCount === 1,
    "main diagnostics publication was not observed",
  );
});

Deno.test("diagnostics publication observation is gated by test state", async () => {
  const observer = await observerModule;
  assert(observer, "diagnostics observer module is missing");

  const uri = { toString: () => "file:///src/main.rs" };
  const diagnostics: unknown[] = [];
  let nextCalls = 0;

  observer.observeDiagnosticsPublication(
    undefined,
    uri,
    diagnostics,
    (nextUri, nextDiagnostics) => {
      nextCalls++;
      assert(nextUri === uri, "gated observer changed the diagnostics URI");
      assert(
        nextDiagnostics === diagnostics,
        "gated observer changed the diagnostics payload",
      );
    },
  );

  assert(nextCalls === 1, "gated observer did not call next exactly once");
});

Deno.test("LSP boundary events are recorded only in test state", async () => {
  const observer = await observerModule;
  assert(observer, "diagnostics observer module is missing");
  assert(
    typeof observer.recordLspTestEvent === "function",
    "LSP boundary recorder is missing",
  );

  const event = {
    boundary: "outbound" as const,
    message: { method: "textDocument/didChange", params: { version: 2 } },
  };
  const state: { lspEvents?: unknown[] } = {};
  observer.recordLspTestEvent(state, event);
  observer.recordLspTestEvent(undefined, event);

  assert(
    Array.isArray(state.lspEvents) && state.lspEvents.length === 1,
    "test state did not record exactly one boundary event",
  );
  assert(state.lspEvents[0] === event, "boundary recorder changed the event");
});
