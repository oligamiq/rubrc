// deno-lint-ignore-file require-await

import {
  type StagedAnalyzerSession,
  StartupCoordinator,
  type StartupDependencies,
} from "./startup_coordinator.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const fakeSession = (
  order: string[] = [],
  overrides: Partial<StagedAnalyzerSession> = {},
): StagedAnalyzerSession => ({
  async activateProject(_model, _signal, semanticWarming) {
    order.push("activate:start");
    semanticWarming();
    order.push("activate:ready");
  },
  async flush() {
    order.push("flush");
  },
  async dispose() {
    order.push("dispose");
  },
  ...overrides,
});

const immediateDependencies = (
  session: StagedAnalyzerSession = fakeSession(),
): StartupDependencies => ({
  async waitForVfsRuntime() {},
  async prefetchSysroots() {},
  async initializeAnalyzer() {
    return session;
  },
  async installSysroots() {},
});

Deno.test("coordinator overlaps prefetch with lightweight analyzer startup", async () => {
  const order: string[] = [];
  const phases: string[] = [];
  const vfs = deferred<void>();
  const archives = deferred<void>();
  const analyzer = deferred<StagedAnalyzerSession>();
  const installed = deferred<void>();
  const coordinator = new StartupCoordinator({
    waitForVfsRuntime: async () => {
      assertEquals(
        coordinator.snapshot().phase,
        "vfs-starting",
        "VFS dependency ran before its phase was published",
      );
      order.push("vfs:start");
      await vfs.promise;
      order.push("vfs:ready");
    },
    prefetchSysroots: async () => {
      assertEquals(
        coordinator.snapshot().phase,
        "vfs-starting",
        "prefetch ran before the VFS phase was published",
      );
      order.push("prefetch:start");
      await archives.promise;
      order.push("prefetch:ready");
    },
    initializeAnalyzer: async () => {
      order.push("analyzer:start");
      return await analyzer.promise;
    },
    installSysroots: async () => {
      order.push("install:start");
      await installed.promise;
      order.push("install:ready");
    },
  });
  coordinator.subscribe((snapshot) => phases.push(snapshot.phase));

  const started = coordinator.start({ getValue: () => "edited" });
  await tick();
  assertEquals(
    order.join(","),
    "vfs:start,prefetch:start",
    "prefetch did not overlap VFS readiness",
  );

  vfs.resolve();
  await tick();
  assert(order.includes("analyzer:start"), "analyzer did not start after VFS");
  assert(!order.includes("install:start"), "sysroots installed before inputs");

  archives.resolve();
  analyzer.resolve(fakeSession(order));
  await tick();
  assert(
    order.includes("install:start"),
    "sysroots did not install after inputs",
  );

  installed.resolve();
  await started;
  assertEquals(coordinator.snapshot().phase, "ready", "startup did not finish");
  assertEquals(
    phases.join(","),
    "editor-visible,vfs-starting,analyzer-initializing,sysroots-loading,project-activating,semantic-warming,ready",
    "wrong phase sequence",
  );
});

Deno.test("synchronous startup dependency throws keep both branches observed", async () => {
  const vfsError = new Error("VFS threw synchronously");
  let prefetchStarted = false;
  const vfsFailure = new StartupCoordinator({
    waitForVfsRuntime() {
      throw vfsError;
    },
    async prefetchSysroots() {
      prefetchStarted = true;
    },
    async initializeAnalyzer() {
      throw new Error("analyzer must not start after VFS failure");
    },
    async installSysroots() {
      throw new Error("sysroots must not install after VFS failure");
    },
  });

  const vfsCaught = await vfsFailure.start({ getValue: () => "edited" }).then(
    () => undefined,
    (error) => error,
  );
  assert(vfsCaught === vfsError, "synchronous VFS error identity was replaced");
  assert(prefetchStarted, "synchronous VFS throw prevented prefetch startup");

  const vfs = deferred<void>();
  const lateVfsError = new Error("VFS failed after prefetch threw");
  const prefetchError = new Error("prefetch threw synchronously");
  const prefetchFailure = new StartupCoordinator({
    waitForVfsRuntime: () => vfs.promise,
    prefetchSysroots() {
      throw prefetchError;
    },
    async initializeAnalyzer() {
      throw new Error("analyzer must not start after VFS failure");
    },
    async installSysroots() {
      throw new Error("sysroots must not install after VFS failure");
    },
  });

  const started = prefetchFailure.start({ getValue: () => "edited" }).then(
    () => undefined,
    (error) => error,
  );
  vfs.reject(lateVfsError);
  assert(
    await started === lateVfsError,
    "synchronous prefetch throw abandoned or reordered the VFS branch",
  );
});

Deno.test("coordinator publishes immutable progress and ignores stale callbacks", async () => {
  const vfs = deferred<void>();
  let reportProgress!: (
    id: "rust-src" | "target-sysroot",
    progress?: number,
  ) => void;
  const coordinator = new StartupCoordinator({
    waitForVfsRuntime: () => vfs.promise,
    prefetchSysroots: (report) => {
      reportProgress = report;
      return new Promise<void>(() => {});
    },
    async initializeAnalyzer() {
      throw new Error("analyzer must not start after disposal");
    },
    async installSysroots() {
      throw new Error("sysroots must not install after disposal");
    },
  });

  const started = coordinator.start({ getValue: () => "edited" }).catch((
    error,
  ) => error);
  const beforeProgress = coordinator.snapshot();
  reportProgress("rust-src", 35);
  const afterProgress = coordinator.snapshot();
  const oldRustSrc = beforeProgress.tasks.find((task) =>
    task.id === "rust-src"
  );
  const currentRustSrc = afterProgress.tasks.find((task) =>
    task.id === "rust-src"
  );

  assert(
    beforeProgress !== afterProgress,
    "progress mutated the current snapshot",
  );
  assert(
    beforeProgress.tasks !== afterProgress.tasks,
    "progress reused the task array",
  );
  assertEquals(
    oldRustSrc?.progress,
    undefined,
    "old snapshot progress was mutated",
  );
  assertEquals(currentRustSrc?.progress, 35, "progress was not published");
  assertEquals(
    currentRustSrc?.state,
    "running",
    "progress task was not running",
  );
  for (const oldTask of beforeProgress.tasks) {
    const currentTask = afterProgress.tasks.find((task) =>
      task.id === oldTask.id
    );
    assert(
      Object.isFrozen(currentTask),
      `${oldTask.id} task is externally mutable`,
    );
    assert(
      oldTask.id === "rust-src"
        ? currentTask !== oldTask
        : currentTask === oldTask,
      `${oldTask.id} task did not use safe structural sharing`,
    );
  }

  const disposal = coordinator.dispose();
  const disposedSnapshot = coordinator.snapshot();
  reportProgress("rust-src", 90);
  assert(
    coordinator.snapshot() === disposedSnapshot,
    "late progress published into a stale generation",
  );
  vfs.resolve();
  await disposal;
  await started;
});

Deno.test("coordinator preserves startup failures and disposes the session", async () => {
  const original = new Error("sysroot installation failed");
  const order: string[] = [];
  const session = fakeSession(order);
  const coordinator = new StartupCoordinator({
    ...immediateDependencies(session),
    async installSysroots() {
      order.push("install");
      throw original;
    },
  });

  let caught: unknown;
  try {
    await coordinator.start({ getValue: () => "edited" });
  } catch (error) {
    caught = error;
  }

  assert(caught === original, "startup replaced the originating error");
  assertEquals(coordinator.snapshot().phase, "failed", "failure phase missing");
  assertEquals(
    coordinator.snapshot().error,
    original.message,
    "failure message missing",
  );
  assertEquals(
    order.join(","),
    "install,dispose",
    "session was not cleaned up",
  );
});

Deno.test("unformattable failures cannot bypass analyzer disposal", async () => {
  const original = Object.create(null);
  let disposed = false;
  const coordinator = new StartupCoordinator({
    ...immediateDependencies(fakeSession([], {
      async dispose() {
        disposed = true;
      },
    })),
    async installSysroots() {
      throw original;
    },
  });

  let caught: unknown;
  await coordinator.start({ getValue: () => "edited" }).catch((error) => {
    caught = error;
  });

  assert(
    caught === original,
    "failure formatting replaced the rejection value",
  );
  assert(disposed, "failure formatting bypassed analyzer disposal");
  assertEquals(coordinator.snapshot().phase, "failed", "failure phase missing");
  assertEquals(
    coordinator.snapshot().error,
    "Unknown startup error",
    "unformattable failure did not use the fallback message",
  );
});

Deno.test("subscribe removes a listener whose initial delivery throws", async () => {
  const listenerError = new Error("initial render failed");
  const coordinator = new StartupCoordinator(immediateDependencies());
  let deliveries = 0;
  let caught: unknown;

  try {
    coordinator.subscribe(() => {
      deliveries++;
      throw listenerError;
    });
  } catch (error) {
    caught = error;
  }

  assert(caught === listenerError, "subscribe replaced the listener error");
  await coordinator.start({ getValue: () => "edited" });
  assertEquals(deliveries, 1, "failed initial listener remained subscribed");
});

Deno.test("publication does not revisit listeners subscribed during delivery", async () => {
  const coordinator = new StartupCoordinator(immediateDependencies());
  let subscribedDuringPublication = false;
  let duplicateSnapshotDeliveries = 0;

  coordinator.subscribe((snapshot) => {
    if (snapshot.phase !== "vfs-starting" || subscribedDuringPublication) {
      return;
    }
    subscribedDuringPublication = true;
    coordinator.subscribe((nestedSnapshot) => {
      if (nestedSnapshot === snapshot) duplicateSnapshotDeliveries++;
    });
  });

  await coordinator.start({ getValue: () => "edited" });
  assertEquals(
    duplicateSnapshotDeliveries,
    1,
    "listener received the publication after its immediate subscription delivery",
  );
});

Deno.test("subscriber failures cannot replace errors or skip cleanup", async () => {
  const original = new Error("sysroot installation failed");
  const listenerError = new Error("render failed");
  const order: string[] = [];
  const coordinator = new StartupCoordinator({
    ...immediateDependencies(fakeSession(order)),
    async installSysroots() {
      throw original;
    },
  });
  coordinator.subscribe((snapshot) => {
    if (snapshot.phase === "failed") throw listenerError;
  });

  let caught: unknown;
  await coordinator.start({ getValue: () => "edited" }).catch((error) => {
    caught = error;
  });

  assert(caught === original, "subscriber replaced the originating error");
  assertEquals(
    order.join(","),
    "dispose",
    "subscriber skipped session cleanup",
  );
});

Deno.test("prefetch rejection is observed immediately and retained", async () => {
  const original = new Error("archive download failed");
  const vfs = deferred<void>();
  const order: string[] = [];
  const coordinator = new StartupCoordinator({
    waitForVfsRuntime: () => vfs.promise,
    prefetchSysroots: () => Promise.reject(original),
    async initializeAnalyzer() {
      order.push("analyzer");
      return fakeSession(order);
    },
    async installSysroots() {
      order.push("install");
    },
  });

  const started = coordinator.start({ getValue: () => "edited" }).then(
    () => undefined,
    (error) => error,
  );
  await tick();
  vfs.resolve();
  const caught = await started;

  assert(caught === original, "prefetch rejection identity was replaced");
  assertEquals(order.join(","), "analyzer,dispose", "wrong failure cleanup");
});

Deno.test("late callbacks cannot overwrite a failed snapshot", async () => {
  const original = new Error("project activation failed");
  let reportProgress!: (
    id: "rust-src" | "target-sysroot",
    progress?: number,
  ) => void;
  let semanticWarming!: () => void;
  const coordinator = new StartupCoordinator({
    async waitForVfsRuntime() {},
    async prefetchSysroots(report) {
      reportProgress = report;
    },
    async initializeAnalyzer() {
      return fakeSession([], {
        async activateProject(_model, _signal, warming) {
          semanticWarming = warming;
          throw original;
        },
      });
    },
    async installSysroots() {},
  });

  await coordinator.start({ getValue: () => "edited" }).catch(() => {});
  const failed = coordinator.snapshot();
  reportProgress("rust-src", 100);
  semanticWarming();

  assert(
    coordinator.snapshot() === failed,
    "late callback replaced the terminal snapshot",
  );
  assertEquals(coordinator.snapshot().phase, "failed", "failure was cleared");
  assertEquals(
    coordinator.snapshot().error,
    original.message,
    "originating error was cleared",
  );
});

Deno.test("coordinator checks cancellation after each phase await", async () => {
  for (
    const checkpoint of [
      "vfs",
      "analyzer",
      "prefetch",
      "install",
      "activate",
    ] as const
  ) {
    const order: string[] = [];
    const vfs = deferred<void>();
    const prefetch = deferred<void>();
    const analyzer = deferred<StagedAnalyzerSession>();
    const install = deferred<void>();
    const activate = deferred<void>();
    const vfsEntered = deferred<void>();
    const analyzerEntered = deferred<void>();
    const installEntered = deferred<void>();
    const activateEntered = deferred<void>();
    const session = fakeSession(order, {
      async activateProject() {
        order.push("activate");
        activateEntered.resolve();
        await activate.promise;
      },
    });
    const coordinator = new StartupCoordinator({
      waitForVfsRuntime: async () => {
        order.push("vfs");
        vfsEntered.resolve();
        await vfs.promise;
      },
      prefetchSysroots: async () => {
        order.push("prefetch");
        await prefetch.promise;
      },
      initializeAnalyzer: async () => {
        order.push("analyzer");
        analyzerEntered.resolve();
        return await analyzer.promise;
      },
      installSysroots: async () => {
        order.push("install");
        installEntered.resolve();
        await install.promise;
      },
    });

    const startup = coordinator.start({ getValue: () => "edited" }).catch(
      () => {},
    );
    if (checkpoint === "vfs") {
      await vfsEntered.promise;
    } else {
      vfs.resolve();
      await analyzerEntered.promise;
      if (checkpoint === "analyzer") {
        // Abort while analyzer initialization is still pending.
      } else {
        analyzer.resolve(session);
        if (checkpoint === "prefetch") {
          await tick();
        } else {
          prefetch.resolve();
          await installEntered.promise;
          if (checkpoint === "install") {
            // Abort while sysroot installation is still pending.
          } else {
            install.resolve();
            await activateEntered.promise;
          }
        }
      }
    }

    const disposal = coordinator.dispose();
    ({
      vfs,
      prefetch,
      install,
      activate,
    })[
      checkpoint === "analyzer"
        ? "vfs"
        : checkpoint === "prefetch"
        ? "prefetch"
        : checkpoint === "activate"
        ? "activate"
        : checkpoint
    ].resolve();
    if (checkpoint === "analyzer") analyzer.resolve(session);
    await startup;
    await disposal;

    const forbidden = checkpoint === "vfs"
      ? "analyzer"
      : checkpoint === "analyzer" || checkpoint === "prefetch"
      ? "install"
      : checkpoint === "install"
      ? "activate"
      : undefined;
    assert(
      forbidden === undefined || !order.includes(forbidden),
      `${checkpoint} cancellation continued into ${forbidden}: ${order}`,
    );
    if (checkpoint === "activate") {
      assertEquals(
        coordinator.snapshot().phase,
        "project-activating",
        "activation cancellation published ready",
      );
    }
  }
});

Deno.test("flush rejects before ready and delegates after startup", async () => {
  let flushes = 0;
  const session = fakeSession([], {
    async flush() {
      flushes++;
    },
  });
  const coordinator = new StartupCoordinator(immediateDependencies(session));

  let earlyFlushRejected = false;
  await coordinator.flush().catch(() => {
    earlyFlushRejected = true;
  });
  assert(earlyFlushRejected, "flush resolved before ready");

  await coordinator.start({ getValue: () => "edited" });
  await coordinator.flush();
  assertEquals(flushes, 1, "ready flush did not delegate to the session");
});

Deno.test("dispose waits for analyzer session disposal", async () => {
  const sessionDisposal = deferred<void>();
  let disposalStarted = false;
  let disposalFinished = false;
  const session = fakeSession([], {
    async dispose() {
      disposalStarted = true;
      await sessionDisposal.promise;
    },
  });
  const coordinator = new StartupCoordinator(immediateDependencies(session));
  await coordinator.start({ getValue: () => "edited" });

  const disposal = coordinator.dispose().then(() => {
    disposalFinished = true;
  });
  await tick();
  assert(disposalStarted, "session disposal did not start");
  assert(!disposalFinished, "coordinator disposed before its session");

  sessionDisposal.resolve();
  await disposal;
  assert(disposalFinished, "coordinator disposal did not finish");
});

Deno.test("dispose reports late session cleanup failure", async () => {
  const analyzerEntered = deferred<void>();
  const analyzer = deferred<StagedAnalyzerSession>();
  const cleanupError = new Error("late session cleanup failed");
  const coordinator = new StartupCoordinator({
    async waitForVfsRuntime() {},
    async prefetchSysroots() {},
    async initializeAnalyzer() {
      analyzerEntered.resolve();
      return await analyzer.promise;
    },
    async installSysroots() {
      throw new Error("installation must not start after disposal");
    },
  });
  const startup = coordinator.start({ getValue: () => "edited" }).catch(
    () => {},
  );
  await analyzerEntered.promise;

  const disposal = coordinator.dispose().then(
    () => undefined,
    (error) => error,
  );
  analyzer.resolve(fakeSession([], {
    async dispose() {
      throw cleanupError;
    },
  }));

  await startup;
  assert(
    await disposal === cleanupError,
    "dispose swallowed the late cleanup failure",
  );
});
