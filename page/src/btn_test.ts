const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

type CreateRunAfterFlush = (
  flush: () => Promise<void>,
  run: (triple?: string) => Promise<void>,
  reportError: (error: unknown) => void,
) => (triple?: string) => Promise<void>;

const loadFactory = async (): Promise<CreateRunAfterFlush> => {
  const moduleUrl = new URL("./run_after_flush.ts", import.meta.url).href;
  const module = await import(moduleUrl);
  assert(
    module.createRunAfterFlush,
    "single-flight flush-before-run factory is missing",
  );
  return module.createRunAfterFlush as CreateRunAfterFlush;
};

Deno.test("run command waits for the workspace flush", async () => {
  const createRunAfterFlush = await loadFactory();
  const order: string[] = [];
  let completeFlush!: () => void;
  const flushCompletion = new Promise<void>((resolve) => {
    completeFlush = resolve;
  });
  const run = createRunAfterFlush(
    async () => {
      order.push("flush-start");
      await flushCompletion;
      order.push("flush-complete");
    },
    async (triple) => {
      order.push(`run:${triple}`);
    },
    () => {},
  );

  const clicked = run("wasm32-wasip1");
  await Promise.resolve();
  assert(!order.includes("run:wasm32-wasip1"), `run started early: ${order}`);
  completeFlush();
  await clicked;
  assert(
    order.join(",") === "flush-start,flush-complete,run:wasm32-wasip1",
    `flush did not precede run command: ${order}`,
  );
});

Deno.test("rapid clicks dispatch only one compile command", async () => {
  const createRunAfterFlush = await loadFactory();
  let flushes = 0;
  let runs = 0;
  let completeFlush!: () => void;
  const flushCompletion = new Promise<void>((resolve) => {
    completeFlush = resolve;
  });
  const run = createRunAfterFlush(
    async () => {
      flushes++;
      await flushCompletion;
    },
    async () => {
      runs++;
    },
    () => {},
  );

  const first = run();
  const duplicate = run();
  await duplicate;
  assert(flushes === 1, `duplicate click started ${flushes} flushes`);
  completeFlush();
  await first;
  assert(runs === 1, `duplicate click started ${runs} compile commands`);
});

Deno.test("flush failure suppresses run and reports the error", async () => {
  const createRunAfterFlush = await loadFactory();
  const original = new Error("flush failed");
  const errors: unknown[] = [];
  let runs = 0;
  const run = createRunAfterFlush(
    async () => {
      throw original;
    },
    async () => {
      runs++;
    },
    (error) => errors.push(error),
  );

  await run();

  assert(runs === 0, "compile ran after flush failure");
  assert(
    errors.length === 1 && errors[0] === original,
    "error was not reported",
  );
});

Deno.test("a later click retries after the first run settles", async () => {
  const createRunAfterFlush = await loadFactory();
  let shouldFail = true;
  let flushes = 0;
  let runs = 0;
  const errors: unknown[] = [];
  const run = createRunAfterFlush(
    async () => {
      flushes++;
      if (shouldFail) throw new Error("first flush failed");
    },
    async () => {
      runs++;
    },
    (error) => errors.push(error),
  );

  await run();
  shouldFail = false;
  await run();

  assert(flushes === 2, `retry performed ${flushes} flushes`);
  assert(runs === 1, `retry performed ${runs} compile commands`);
  assert(errors.length === 1, `retry reported ${errors.length} errors`);
});

Deno.test("RunButton creates one guarded flush-before-run callback", async () => {
  const source = await Deno.readTextFile("page/src/btn.tsx");
  assert(
    source.includes(
      "createRunAfterFlush(props.flush, compile_and_run, console.error)",
    ),
    "RunButton does not create the guarded run callback",
  );
  assert(
    source.includes("void run(props.triple)"),
    "RunButton does not invoke the guarded run callback",
  );
});
