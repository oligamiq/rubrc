import type { AppRuntime } from "./app_runtime.ts";
import { ReloadRequiredError } from "./app_runtime.ts";
import {
  mountRuntimeApplication,
  type RuntimeCreationFailureModel,
} from "./runtime_entrypoint.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("runtime entrypoint renders one reload failure and resolves creation rejection", async () => {
  let appRenders = 0;
  const failures: RuntimeCreationFailureModel[] = [];

  await mountRuntimeApplication({
    createRuntime: () =>
      Promise.reject(new ReloadRequiredError("reload required")),
    renderApp: () => appRenders++,
    renderFailure: (failure) => failures.push(failure),
  });

  assert(appRenders === 0, "App rendered after runtime creation rejected");
  assert(failures.length === 1, `failure rendered ${failures.length} times`);
  assert(
    JSON.stringify(failures[0]) ===
      JSON.stringify({ message: "reload required", reloadRequired: true }),
    `wrong failure model: ${JSON.stringify(failures[0])}`,
  );
});

Deno.test("runtime entrypoint renders App once after successful creation", async () => {
  const runtime = {} as AppRuntime;
  const rendered: AppRuntime[] = [];
  let failures = 0;

  await mountRuntimeApplication({
    createRuntime: () => Promise.resolve(runtime),
    renderApp: (created) => rendered.push(created),
    renderFailure: () => failures++,
  });

  assert(rendered.length === 1, `App rendered ${rendered.length} times`);
  assert(rendered[0] === runtime, "entrypoint replaced the created runtime");
  assert(failures === 0, "successful creation rendered a failure");
});

Deno.test("runtime creation failure component owns reload copy and action", async () => {
  const source = await Deno.readTextFile(
    "page/src/RuntimeCreationFailure.tsx",
  );

  assert(source.includes('role="alert"'), "creation failure is not visible");
  assert(source.includes("Reload required"), "reload-required copy is missing");
  assert(
    source.includes("Runtime failed to start"),
    "fatal creation copy is missing",
  );
  assert(source.includes("props.onReload"), "reload action is not wired");
});

Deno.test("runtime entrypoint awaits an async render success callback", async () => {
  let releaseRender!: () => void;
  const rendering = new Promise<void>((resolve) => {
    releaseRender = resolve;
  });
  let settled = false;
  const mounting = mountRuntimeApplication({
    createRuntime: () => Promise.resolve({} as AppRuntime),
    renderApp: () => rendering,
    renderFailure: () => {
      throw new Error("unexpected failure render");
    },
  }).finally(() => {
    settled = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert(!settled, "entrypoint resolved before async render completed");
  releaseRender();
  await mounting;
});

Deno.test("render failure waits for runtime disposal before fallback", async () => {
  let releaseDisposal!: () => void;
  const disposal = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  const order: string[] = [];
  const failures: RuntimeCreationFailureModel[] = [];
  const renderError = new Error("Solid render failed");
  let phase: AppRuntime["phase"] = "ready";
  const runtime = {
    get phase() {
      return phase;
    },
    dispose: () => {
      order.push("dispose:start");
      return disposal.then(() => {
        phase = "disposed";
        order.push("dispose:complete");
      });
    },
  } as AppRuntime;
  const mounting = mountRuntimeApplication({
    createRuntime: () => Promise.resolve(runtime),
    renderApp: () => {
      throw renderError;
    },
    renderFailure: (failure) => {
      failures.push(failure);
      order.push(`failure:${failure.message}`);
    },
  });

  await Promise.resolve();
  assert(
    order.join(",") === "dispose:start",
    `fallback did not wait for disposal: ${order}`,
  );
  releaseDisposal();
  await mounting;
  assert(
    order.join(",") ===
      "dispose:start,dispose:complete,failure:Solid render failed",
    `wrong render failure order: ${order}`,
  );
  assert(!failures[0].reloadRequired, "ordinary disposal required a reload");
});

Deno.test("render failure requires reload when teardown quarantines the runtime", async () => {
  const renderError = new Error("primary render failure");
  const cleanupError = new Error("runtime teardown failed");
  const failures: RuntimeCreationFailureModel[] = [];
  const cleanupReports: unknown[] = [];
  let phase: AppRuntime["phase"] = "ready";
  const runtime = {
    get phase() {
      return phase;
    },
    dispose: () => {
      phase = "reload-required";
      return Promise.reject(cleanupError);
    },
  } as AppRuntime;

  await mountRuntimeApplication({
    createRuntime: () => Promise.resolve(runtime),
    renderApp: () => {
      throw renderError;
    },
    renderFailure: (failure) => failures.push(failure),
    reportCleanupFailure: (error) => cleanupReports.push(error),
  });

  assert(failures.length === 1, `failure rendered ${failures.length} times`);
  assert(
    failures[0].message === renderError.message,
    "teardown failure replaced the primary render message",
  );
  assert(failures[0].reloadRequired, "quarantined teardown did not require reload");
  assert(
    cleanupReports.length === 1 && cleanupReports[0] === cleanupError,
    "teardown rejection was not reported once",
  );
});

Deno.test("render cleanup rejection preserves the render failure without unhandled rejection", async () => {
  const renderError = new Error("original render failure");
  const cleanupError = new Error("render cleanup failed");
  let disposalCalls = 0;
  let unhandled = 0;
  const failures: RuntimeCreationFailureModel[] = [];
  const cleanupReports: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    await mountRuntimeApplication({
      createRuntime: () =>
        Promise.resolve({
          dispose: () => {
            disposalCalls++;
            return Promise.reject(cleanupError);
          },
        } as AppRuntime),
      renderApp: () => {
        throw renderError;
      },
      renderFailure: (failure) => failures.push(failure),
      reportCleanupFailure: (error) => cleanupReports.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert(disposalCalls === 1, `runtime disposed ${disposalCalls} times`);
    assert(failures.length === 1, `failure rendered ${failures.length} times`);
    assert(
      failures[0].message === renderError.message,
      "cleanup rejection replaced the render failure",
    );
    assert(
      cleanupReports.length === 1 && cleanupReports[0] === cleanupError,
      "cleanup rejection was not observed exactly once",
    );
    assert(unhandled === 0, "cleanup rejection became unhandled");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});
