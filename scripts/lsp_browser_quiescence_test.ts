import {
  DIAGNOSTICS_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  waitForDiagnosticsQuiescence,
} from "./lsp_browser_quiescence.mjs";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
};

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("browser diagnostics budgets separate startup from interactions", () => {
  assert(STARTUP_TIMEOUT_MS === 300_000, "startup budget must be 300 seconds");
  assert(
    DIAGNOSTICS_TIMEOUT_MS === 15_000,
    "diagnostics and barrier budget must be 15 seconds",
  );
});

Deno.test("diagnostics quiescence waits for publication and markers before requesting syntax", async () => {
  const publication = deferred();
  const markers = deferred();
  const events: string[] = [];

  const barrier = waitForDiagnosticsQuiescence({
    stage: "invalid diagnostics",
    waitForPublication: () => {
      events.push("publication-started");
      return publication.promise;
    },
    waitForMarkers: () => {
      events.push("markers-started");
      return markers.promise;
    },
    requestSyntaxTree: async () => {
      events.push("syntax-tree-complete");
    },
  });

  await nextTurn();
  assert(
    events.join(",") === "publication-started",
    "marker wait or syntax request started before publication",
  );

  publication.resolve();
  await nextTurn();
  assert(
    events.join(",") === "publication-started,markers-started",
    "syntax request started before markers were published",
  );

  markers.resolve();
  await barrier;
  events.push("next-mutation");
  assert(
    events.join(",") ===
      "publication-started,markers-started,syntax-tree-complete,next-mutation",
    "the next mutation did not follow the quiescence response",
  );
});

Deno.test("diagnostics quiescence timeout identifies its stage", async () => {
  let message = "";
  try {
    await waitForDiagnosticsQuiescence({
      stage: "clearing diagnostics",
      waitForPublication: async () => {},
      requestSyntaxTree: () => new Promise(() => {}),
      timeoutMs: 1,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(
    message ===
      "syntax-tree quiescence timed out after 1 ms during clearing diagnostics",
    `unexpected timeout error: ${message}`,
  );
});
