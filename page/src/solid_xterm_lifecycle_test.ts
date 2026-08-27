import { retainAsyncCleanup } from "./solid_xterm_lifecycle.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("async mount cleanup runs once when disposed before resolution", async () => {
  let resolve!: (cleanup: () => void) => void;
  const pending = new Promise<() => void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  let cleanups = 0;
  const retained = retainAsyncCleanup(pending);

  retained.dispose();
  retained.dispose();
  resolve(() => cleanups++);
  await pending;
  await Promise.resolve();
  assert(cleanups === 1, `late cleanup ran ${cleanups} times`);
});

Deno.test("late resolved cleanup throw is reported once without rejection", async () => {
  let resolve!: (cleanup: () => void) => void;
  const pending = new Promise<() => void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  const cleanupError = new Error("late cleanup threw");
  const reported: unknown[] = [];
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const retained = retainAsyncCleanup(pending, (error) =>
      reported.push(error)
    );
    retained.dispose();
    retained.dispose();
    resolve(() => {
      throw cleanupError;
    });
    await pending;
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    assert(reported.length === 1, `cleanup reported ${reported.length} times`);
    assert(reported[0] === cleanupError, "late cleanup error identity changed");
    assert(unhandled === 0, "late cleanup produced an unhandled rejection");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("mounted cleanup throw is reported once and dispose stays idempotent", async () => {
  const cleanupError = new Error("mounted cleanup threw");
  const reported: unknown[] = [];
  const retained = retainAsyncCleanup(
    Promise.resolve(() => {
      throw cleanupError;
    }),
    (error) => reported.push(error),
  );
  await Promise.resolve();
  let escaped: unknown;

  try {
    retained.dispose();
    retained.dispose();
  } catch (error) {
    escaped = error;
  }

  assert(escaped === undefined, "mounted cleanup throw escaped dispose");
  assert(reported.length === 1, `cleanup reported ${reported.length} times`);
  assert(reported[0] === cleanupError, "mounted cleanup error identity changed");
});

Deno.test("throwing reporter cannot reject pending rejection handling", async () => {
  const pendingError = new Error("mount rejected");
  let reportAttempts = 0;
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const retained = retainAsyncCleanup(Promise.reject(pendingError), () => {
      reportAttempts++;
      throw new Error("reporter failed");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let escaped: unknown;
    try {
      retained.dispose();
      retained.dispose();
    } catch (error) {
      escaped = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert(escaped === undefined, "pending rejection reporter escaped dispose");
    assert(reportAttempts === 1, `reporting attempted ${reportAttempts} times`);
    assert(unhandled === 0, "throwing rejection reporter became unhandled");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("throwing reporter cannot reject delayed cleanup handling", async () => {
  let resolve!: (cleanup: () => void) => void;
  const pending = new Promise<() => void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  let reportAttempts = 0;
  let unhandled = 0;
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const retained = retainAsyncCleanup(pending, () => {
      reportAttempts++;
      throw new Error("reporter failed");
    });
    retained.dispose();
    retained.dispose();
    resolve(() => {
      throw new Error("delayed cleanup failed");
    });
    await pending;
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    assert(reportAttempts === 1, `reporting attempted ${reportAttempts} times`);
    assert(unhandled === 0, "throwing delayed reporter became unhandled");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("throwing reporter cannot escape mounted cleanup disposal", async () => {
  let reportAttempts = 0;
  const retained = retainAsyncCleanup(
    Promise.resolve(() => {
      throw new Error("mounted cleanup failed");
    }),
    () => {
      reportAttempts++;
      throw new Error("reporter failed");
    },
  );
  await Promise.resolve();
  let escaped: unknown;

  try {
    retained.dispose();
    retained.dispose();
  } catch (error) {
    escaped = error;
  }

  assert(escaped === undefined, "throwing reporter escaped synchronous dispose");
  assert(reportAttempts === 1, `reporting attempted ${reportAttempts} times`);
});

Deno.test("terminal component owns only its runtime attachment", async () => {
  const source = await Deno.readTextFile("page/src/xterm.tsx");

  assert(source.includes("runtime: RuntimeTerminalBinding"), "runtime prop missing");
  assert(source.includes("sessionId: number"), "session ID prop missing");
  assert(
    source.includes("props.runtime.attachTerminal(props.sessionId"),
    "terminal does not attach through the runtime",
  );
  assert(
    source.includes("attachment.dispose()"),
    "terminal unmount does not dispose its attachment",
  );
  for (const forbidden of [
    "archiveStore",
    "WASIFarm",
    "get_ref",
    "createHttpBridge",
    "createChildProcessBridge",
    "SharedObjectRef",
    "createTerminalSessionChannels",
  ]) {
    assert(!source.includes(forbidden), `terminal still owns ${forbidden}`);
  }
});
