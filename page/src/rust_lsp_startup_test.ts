import { runRustLspStartup } from "./rust_lsp_startup.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
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
      createMainModel: () => {
        order.push("model");
      },
    },
    100,
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
      createMainModel: async () => {
        order.push("model");
        resolveModelCreated();
        await didOpenComplete;
        order.push("didOpen");
      },
    },
    100,
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
        createMainModel: () => {
          modelCreated = true;
        },
      },
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
        createMainModel: () => {
          modelCreated = true;
        },
      },
      100,
    );
  } catch (error) {
    received = error;
  }

  assert(received === original, "startup replaced the client error");
  assert(!modelCreated, "model was created after client startup failed");
});

Deno.test("startup timeout remains active while didOpen is pending", async () => {
  let modelCreated = false;
  let message = "";

  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {},
        startClient: async () => {},
        createMainModel: () => {
          modelCreated = true;
          return new Promise<void>(() => {});
        },
      },
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
});

Deno.test("didOpen failure preserves the original startup error", async () => {
  const original = new Error("didOpen failed");
  let received: unknown;

  try {
    await runRustLspStartup(
      {
        prepopulateMain: async () => {},
        startClient: async () => {},
        createMainModel: async () => {
          throw original;
        },
      },
      100,
    );
  } catch (error) {
    received = error;
  }

  assert(received === original, "startup replaced the didOpen error");
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
        createMainModel: () => {},
      },
      100,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(message === "VFS write failed", `wrong VFS error: ${message}`);
  assert(!started, "client started after VFS pre-population failed");
});
