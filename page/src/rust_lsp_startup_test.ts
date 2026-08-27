import { runRustLspStartup } from "./rust_lsp_startup.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

Deno.test("startup snapshots the current model into VFS before starting the client", async () => {
  const order: string[] = [];

  await runRustLspStartup(
    {
      prepopulateMain: async () => {
        order.push("snapshot current model");
        await Promise.resolve();
        order.push("VFS write complete");
      },
      startClient: async () => {
        order.push("client.start resolved");
      },
      cancelClientStart: () => {},
    },
    100,
    new AbortController().signal,
  );

  assert(
    order.join(",") ===
      "snapshot current model,VFS write complete,client.start resolved",
    `wrong startup order: ${order}`,
  );
});

Deno.test("client startup timeout preserves the startup phase", async () => {
  let message = "";

  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {},
        startClient: () => new Promise<void>(() => {}),
        cancelClientStart: () => {},
      },
      1,
      new AbortController().signal,
      1,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(
    message === "rust-analyzer startup timed out",
    `wrong timeout error: ${message}`,
  );
});

Deno.test("startup timeout bounds stalled pre-population without cancelling client", async () => {
  let starts = 0;
  let cancellations = 0;
  const result = await Promise.race([
    runRustLspStartup(
      {
        prepopulateMain: () => new Promise<void>(() => {}),
        startClient: async () => {
          starts++;
        },
        cancelClientStart: () => cancellations++,
      },
      1,
      new AbortController().signal,
      1,
    ).then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error)),
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("pre-population stalled"), 20)
    ),
  ]);

  assert(
    result === "rust-analyzer startup timed out",
    `wrong stalled pre-population result: ${result}`,
  );
  assert(starts === 0, `startClient called ${starts} times`);
  assert(cancellations === 0, `cancelled ${cancellations} times`);
});

Deno.test("abort bounds stalled pre-population without cancelling client", async () => {
  const controller = new AbortController();
  const reason = new Error("component unmounted during pre-population");
  let starts = 0;
  let cancellations = 0;
  const startup = runRustLspStartup(
    {
      prepopulateMain: () => new Promise<void>(() => {}),
      startClient: async () => {
        starts++;
      },
      cancelClientStart: () => cancellations++,
    },
    1_000,
    controller.signal,
    1,
  );
  await Promise.resolve();
  controller.abort(reason);
  const result = await Promise.race([
    startup.then(
      () => undefined,
      (error) => error,
    ),
    new Promise<unknown>((resolve) =>
      setTimeout(() => resolve("pre-population stalled"), 20)
    ),
  ]);

  assert(result === reason, "abort reason identity was replaced");
  assert(starts === 0, `startClient called ${starts} times`);
  assert(cancellations === 0, `cancelled ${cancellations} times`);
});

Deno.test("abort observes pre-population settlement before rejecting", async () => {
  const controller = new AbortController();
  const prepopulation = deferred();
  const entered = deferred();
  let rejected = false;
  const startup = runRustLspStartup(
    {
      prepopulateMain: () => {
        entered.resolve();
        return prepopulation.promise;
      },
      startClient: async () => {
        throw new Error("client must not start after abort");
      },
      cancelClientStart: () => {
        throw new Error("transport must not cancel before client start");
      },
    },
    1_000,
    controller.signal,
    20,
  ).catch(() => {
    rejected = true;
  });
  await entered.promise;

  controller.abort(new Error("cancelled during VFS write"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(!rejected, "startup rejected while pre-population remained active");

  prepopulation.resolve();
  await startup;
  assert(rejected, "startup did not reject after pre-population settled");
});

Deno.test("client startup failure preserves the original error", async () => {
  const original = new Error("client failed");
  let received: unknown;

  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {},
        startClient: async () => {
          await Promise.resolve();
          throw original;
        },
        cancelClientStart: () => {},
      },
      100,
      new AbortController().signal,
    );
  } catch (error) {
    received = error;
  }

  assert(received === original, "startup replaced the client error");
});

Deno.test("VFS pre-population failure prevents client startup", async () => {
  let started = false;
  let message = "";

  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {
          throw new Error("VFS write failed");
        },
        startClient: async () => {
          started = true;
        },
        cancelClientStart: () => {},
      },
      100,
      new AbortController().signal,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(message === "VFS write failed", `wrong VFS error: ${message}`);
  assert(!started, "client started after VFS pre-population failed");
});

Deno.test("abort cancels start, waits for settlement, and preserves its reason", async () => {
  const controller = new AbortController();
  const start = deferred();
  const started = deferred();
  const reason = new Error("component unmounted");
  const order: string[] = [];
  let starts = 0;
  let caught: unknown;
  const startup = runRustLspStartup(
    {
      prepopulateMain: async () => {
        order.push("prepopulate");
      },
      startClient: () => {
        starts++;
        order.push("start");
        started.resolve();
        return start.promise.finally(() => order.push("start-settled"));
      },
      cancelClientStart: () => {
        order.push("cancel");
        start.reject(new Error("transport closed"));
      },
    },
    1_000,
    controller.signal,
    20,
  );
  await started.promise;
  controller.abort(reason);
  try {
    await startup;
  } catch (error) {
    caught = error;
    order.push("cleanup");
  }
  assert(starts === 1, `startClient called ${starts} times`);
  assert(caught === reason, "abort reason identity was replaced");
  assert(
    order.join(",") === "prepopulate,start,cancel,start-settled,cleanup",
    `wrong cancellation order: ${order}`,
  );
});

Deno.test("timeout cancellation is bounded and observes a late rejection", async () => {
  const start = deferred();
  let cancellations = 0;
  let message = "";
  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {},
        startClient: () => start.promise,
        cancelClientStart: () => cancellations++,
      },
      1,
      new AbortController().signal,
      1,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  start.reject(new Error("late transport rejection"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(cancellations === 1, `cancelled ${cancellations} times`);
  assert(
    message === "rust-analyzer startup timed out",
    `wrong timeout reason: ${message}`,
  );
});
