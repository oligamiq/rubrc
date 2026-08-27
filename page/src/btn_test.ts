import btnSource from "./btn.tsx" with { type: "text" };
import { createRunAfterFlush } from "./run_after_flush.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

type CreateRunAfterFlush = (
  flush: () => Promise<void>,
  run: (triple?: string) => Promise<void>,
  reportError: (error: unknown) => void,
) => (triple?: string) => Promise<void>;

const loadFactory = async (): Promise<CreateRunAfterFlush> =>
  createRunAfterFlush;

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

Deno.test("RunButton receives and invokes the runtime run callback", async () => {
  const source = btnSource;
  assert(
    source.includes("run(triple?: string): Promise<void>"),
    "RunButton lacks a concrete run callback",
  );
  assert(
    source.includes("void props.run(props.triple).catch(console.error)"),
    "RunButton does not invoke the runtime callback",
  );
  assert(
    !source.includes("import { compile_and_run") &&
      !source.includes("createRunAfterFlush"),
    "RunButton still owns module-global run behavior",
  );
});
