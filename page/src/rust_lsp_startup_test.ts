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

Deno.test("startup pre-populates VFS and opens the model without progress", async () => {
  const order: string[] = [];

  await runRustLspStartup(
    {
      prepopulateMain: async () => {
        order.push("prepopulate");
      },
      startClient: async () => {
        order.push("start");
      },
      cancelClientStart: () => {},
      createMainModel: () => {
        order.push("model");
      },
    },
    100,
    new AbortController().signal,
  );

  assert(
    order.join(",") === "prepopulate,start,model",
    `wrong startup order: ${order}`,
  );
});

Deno.test("startup waits for main didOpen completion after model creation", async () => {
  const order: string[] = [];
  let resolveModelCreated!: () => void;
  let resolveDidOpen!: () => void;
  const modelCreated = new Promise<void>((resolve) => {
    resolveModelCreated = resolve;
  });
  const didOpenComplete = new Promise<void>((resolve) => {
    resolveDidOpen = resolve;
  });
  let startupSettled = false;

  const startup = runRustLspStartup(
    {
      prepopulateMain: async () => {
        order.push("prepopulate");
      },
      startClient: async () => {
        order.push("start");
      },
      cancelClientStart: () => {},
      createMainModel: async () => {
        order.push("model");
        resolveModelCreated();
        await didOpenComplete;
        order.push("didOpen");
      },
    },
    100,
    new AbortController().signal,
  ).then(() => {
    startupSettled = true;
  });

  await modelCreated;
  assert(
    order.join(",") === "prepopulate,start,model",
    `wrong pre-completion order: ${order}`,
  );
  assert(!startupSettled, "startup resolved before didOpen completion");

  resolveDidOpen();
  await startup;
  assert(
    order.join(",") === "prepopulate,start,model,didOpen",
    `wrong completed order: ${order}`,
  );
});

Deno.test("client startup timeout does not create the model", async () => {
  let modelCreated = false;
  let message = "";

  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {},
        startClient: () => new Promise<void>(() => {}),
        cancelClientStart: () => {},
        createMainModel: () => {
          modelCreated = true;
        },
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
  assert(!modelCreated, "model was created after startup timeout");
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
        createMainModel: () => {},
      },
      1,
      new AbortController().signal,
      1,
    ).then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error)),
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("pre-population stalled"), 20),
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
      createMainModel: () => {},
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
      setTimeout(() => resolve("pre-population stalled"), 20),
    ),
  ]);

  assert(result === reason, "abort reason identity was replaced");
  assert(starts === 0, `startClient called ${starts} times`);
  assert(cancellations === 0, `cancelled ${cancellations} times`);
});

Deno.test("client startup failure preserves the original error", async () => {
  const original = new Error("client failed");
  let modelCreated = false;
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
        createMainModel: () => {
          modelCreated = true;
        },
      },
      100,
      new AbortController().signal,
    );
  } catch (error) {
    received = error;
  }

  assert(received === original, "startup replaced the client error");
  assert(!modelCreated, "model was created after client startup failed");
});

Deno.test("startup timeout remains active while didOpen is pending", async () => {
  let modelCreated = false;
  let cancellations = 0;
  let message = "";

  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {},
        startClient: async () => {},
        cancelClientStart: () => cancellations++,
        createMainModel: () => {
          modelCreated = true;
          return new Promise<void>(() => {});
        },
      },
      1,
      new AbortController().signal,
      1,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(modelCreated, "named model was not created after client startup");
  assert(
    message === "rust-analyzer startup timed out",
    `wrong didOpen timeout error: ${message}`,
  );
  assert(cancellations === 1, `cancelled ${cancellations} times`);
});

Deno.test("didOpen failure preserves the original startup error", async () => {
  const original = new Error("didOpen failed");
  let cancellations = 0;
  let received: unknown;

  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {},
        startClient: async () => {},
        cancelClientStart: () => cancellations++,
        createMainModel: async () => {
          throw original;
        },
      },
      100,
      new AbortController().signal,
    );
  } catch (error) {
    received = error;
  }

  assert(received === original, "startup replaced the didOpen error");
  assert(cancellations === 0, `cancelled ${cancellations} times`);
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
        createMainModel: () => {},
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
      createMainModel: () => {
        order.push("model");
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
        createMainModel: () => {
          throw new Error("model must not be created");
        },
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
