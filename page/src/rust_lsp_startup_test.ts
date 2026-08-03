import { runRustLspStartup } from "./rust_lsp_startup.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("startup pre-populates VFS and opens the model without progress", async () => {
  const order: string[] = [];

  await runRustLspStartup({
    prepopulateMain: async () => {
      order.push("prepopulate");
    },
    startClient: async () => {
      order.push("start");
    },
    createMainModel: () => {
      order.push("model");
    },
  }, 100);

  assert(
    order.join(",") === "prepopulate,start,model",
    `wrong startup order: ${order}`,
  );
});

Deno.test("client startup timeout does not create the model", async () => {
  let modelCreated = false;
  let message = "";

  try {
    await runRustLspStartup({
      prepopulateMain: async () => {},
      startClient: () => new Promise<void>(() => {}),
      createMainModel: () => {
        modelCreated = true;
      },
    }, 1);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(
    message === "rust-analyzer startup timed out",
    `wrong timeout error: ${message}`,
  );
  assert(!modelCreated, "model was created after startup timeout");
});

Deno.test("VFS pre-population failure prevents client startup", async () => {
  let started = false;
  let message = "";

  try {
    await runRustLspStartup({
      prepopulateMain: async () => {
        throw new Error("VFS write failed");
      },
      startClient: async () => {
        started = true;
      },
      createMainModel: () => {},
    }, 100);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(message === "VFS write failed", `wrong VFS error: ${message}`);
  assert(!started, "client started after VFS pre-population failed");
});
