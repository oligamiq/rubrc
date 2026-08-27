export type StartupPhase =
  | "editor-visible"
  | "vfs-starting"
  | "analyzer-initializing"
  | "sysroots-loading"
  | "project-activating"
  | "semantic-warming"
  | "ready"
  | "failed";

export type StartupTaskId =
  | "editor"
  | "analyzer"
  | "rust-src"
  | "target-sysroot"
  | "project";

export type StartupSnapshot = {
  generation: number;
  phase: StartupPhase;
  tasks: ReadonlyArray<{
    id: StartupTaskId;
    label: string;
    state: "pending" | "running" | "complete" | "failed";
    progress?: number;
  }>;
  error?: string;
};

export type StartupModel = { getValue(): string };

export type StagedAnalyzerSession = {
  activateProject(
    model: StartupModel,
    signal: AbortSignal,
    semanticWarming: () => void,
  ): Promise<void>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

export type StartupDependencies = {
  waitForVfsRuntime(signal: AbortSignal): Promise<void>;
  prefetchSysroots(
    report: (id: "rust-src" | "target-sysroot", progress?: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  initializeAnalyzer(
    model: StartupModel,
    signal: AbortSignal,
  ): Promise<StagedAnalyzerSession>;
  installSysroots(signal: AbortSignal): Promise<void>;
};

type StartupTask = StartupSnapshot["tasks"][number];

const INITIAL_TASKS: ReadonlyArray<StartupTask> = [
  { id: "editor", label: "Editor", state: "complete" },
  { id: "analyzer", label: "rust-analyzer", state: "pending" },
  { id: "rust-src", label: "Rust source", state: "pending" },
  { id: "target-sysroot", label: "Target sysroot", state: "pending" },
  { id: "project", label: "Project", state: "pending" },
];

const freezeSnapshot = (
  generation: number,
  phase: StartupPhase,
  tasks: ReadonlyArray<StartupTask>,
  error?: string,
): StartupSnapshot => {
  const frozenTasks = Object.isFrozen(tasks) &&
      tasks.every((task) => Object.isFrozen(task))
    ? tasks
    : Object.freeze(
      tasks.map((task) => Object.isFrozen(task) ? task : Object.freeze(task)),
    );
  return Object.freeze({
    generation,
    phase,
    tasks: frozenTasks,
    ...(error === undefined ? {} : { error }),
  });
};

const taskStateForPhase = (
  task: StartupTask,
  phase: Exclude<StartupPhase, "failed">,
): StartupTask => {
  let state: StartupTask["state"];
  switch (phase) {
    case "editor-visible":
      state = task.id === "editor" ? "complete" : "pending";
      break;
    case "vfs-starting":
      state = task.id === "editor"
        ? "complete"
        : task.id === "rust-src" || task.id === "target-sysroot"
        ? "running"
        : "pending";
      break;
    case "analyzer-initializing":
      state = task.id === "editor"
        ? "complete"
        : task.id === "analyzer" || task.id === "rust-src" ||
            task.id === "target-sysroot"
        ? "running"
        : "pending";
      break;
    case "sysroots-loading":
      state = task.id === "editor" || task.id === "analyzer"
        ? "complete"
        : task.id === "rust-src" || task.id === "target-sysroot"
        ? "running"
        : "pending";
      break;
    case "project-activating":
    case "semantic-warming":
      state = task.id === "project" ? "running" : "complete";
      break;
    case "ready":
      state = "complete";
      break;
  }
  return task.state === state ? task : { ...task, state };
};

const errorMessage = (error: unknown): string => {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return "Unknown startup error";
  }
};

export class StartupCoordinator {
  readonly settlementLabel = "startup-coordinator";
  readonly #dependencies: StartupDependencies;
  readonly #controller = new AbortController();
  readonly #listeners = new Set<(snapshot: StartupSnapshot) => void>();
  #generation = 0;
  #snapshot = freezeSnapshot(0, "editor-visible", INITIAL_TASKS);
  #session: StagedAnalyzerSession | undefined;
  #startup: Promise<void> | undefined;
  #disposal: Promise<void> | undefined;
  #startupCleanupError: unknown;
  #startupCleanupFailed = false;

  constructor(dependencies: StartupDependencies) {
    this.#dependencies = dependencies;
  }

  subscribe(listener: (snapshot: StartupSnapshot) => void): () => void {
    this.#listeners.add(listener);
    try {
      listener(this.#snapshot);
    } catch (error) {
      this.#listeners.delete(listener);
      throw error;
    }
    return () => this.#listeners.delete(listener);
  }

  start(model: StartupModel): Promise<void> {
    if (this.#startup !== undefined) return this.#startup;
    const generation = ++this.#generation;
    const startup = this.#run(model, generation, this.#controller.signal);
    this.#startup = startup;
    return startup;
  }

  async flush(): Promise<void> {
    if (this.#snapshot.phase !== "ready" || this.#session === undefined) {
      throw new Error("Startup coordinator is not ready");
    }
    await this.#session.flush();
  }

  abort(
    reason: unknown = new DOMException(
      "Startup coordinator aborted",
      "AbortError",
    ),
  ): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }

  dispose(): Promise<void> {
    if (this.#disposal === undefined) this.#disposal = this.#dispose();
    return this.#disposal;
  }

  snapshot(): StartupSnapshot {
    return this.#snapshot;
  }

  async #run(
    model: StartupModel,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    let analyzer: StagedAnalyzerSession | undefined;
    try {
      signal.throwIfAborted();
      this.#setPhase(generation, "vfs-starting");
      const vfsRuntime = (async () =>
        await this.#dependencies.waitForVfsRuntime(signal))();
      void vfsRuntime.catch(() => undefined);
      const prefetch = (async () =>
        await this.#dependencies.prefetchSysroots(
          (id, progress) => this.#reportProgress(generation, id, progress),
          signal,
        ))();
      void prefetch.catch(() => undefined);
      await vfsRuntime;
      signal.throwIfAborted();
      this.#setPhase(generation, "analyzer-initializing");
      analyzer = await this.#dependencies.initializeAnalyzer(model, signal);
      this.#session = analyzer;
      signal.throwIfAborted();
      await prefetch;
      signal.throwIfAborted();
      this.#setPhase(generation, "sysroots-loading");
      await this.#dependencies.installSysroots(signal);
      signal.throwIfAborted();
      this.#setPhase(generation, "project-activating");
      await analyzer.activateProject(
        model,
        signal,
        () => this.#setPhase(generation, "semantic-warming"),
      );
      signal.throwIfAborted();
      this.#setPhase(generation, "ready");
    } catch (error) {
      if (this.#generation === generation) this.#setFailed(generation, error);
      try {
        await this.#disposeSession(analyzer);
      } catch (cleanupError) {
        // Cleanup must not replace the originating startup failure.
        this.#startupCleanupError = cleanupError;
        this.#startupCleanupFailed = true;
      }
      throw error;
    }
  }

  #setPhase(
    generation: number,
    phase: Exclude<StartupPhase, "failed">,
  ): void {
    if (
      generation !== this.#generation || this.#snapshot.phase === "ready" ||
      this.#snapshot.phase === "failed"
    ) return;
    const updatedTasks = this.#snapshot.tasks.map((task) =>
      taskStateForPhase(task, phase)
    );
    const tasks =
      updatedTasks.every((task, index) => task === this.#snapshot.tasks[index])
        ? this.#snapshot.tasks
        : updatedTasks;
    this.#publish(freezeSnapshot(generation, phase, tasks));
  }

  #setFailed(generation: number, error: unknown): void {
    const tasks = this.#snapshot.tasks.map((task) =>
      task.state === "running" ? { ...task, state: "failed" as const } : task
    );
    this.#publish(
      freezeSnapshot(generation, "failed", tasks, errorMessage(error)),
    );
  }

  #reportProgress(
    generation: number,
    id: "rust-src" | "target-sysroot",
    progress?: number,
  ): void {
    if (
      generation !== this.#generation || this.#controller.signal.aborted ||
      this.#snapshot.phase === "ready" || this.#snapshot.phase === "failed"
    ) return;
    const tasks = this.#snapshot.tasks.map((task) =>
      task.id === id ? { ...task, state: "running" as const, progress } : task
    );
    this.#publish(
      freezeSnapshot(generation, this.#snapshot.phase, tasks),
    );
  }

  #publish(snapshot: StartupSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Subscribers cannot interrupt startup or starve other subscribers.
      }
    }
  }

  async #disposeSession(
    session: StagedAnalyzerSession | undefined,
  ): Promise<void> {
    if (session === undefined || this.#session !== session) return;
    this.#session = undefined;
    await session.dispose();
  }

  async #dispose(): Promise<void> {
    ++this.#generation;
    this.abort(
      new DOMException("Startup coordinator disposed", "AbortError"),
    );

    let disposalError: unknown;
    let disposalFailed = false;
    const currentSession = this.#session;
    try {
      await this.#disposeSession(currentSession);
    } catch (error) {
      disposalError = error;
      disposalFailed = true;
    }

    await this.#startup?.catch(() => undefined);
    if (!disposalFailed && this.#startupCleanupFailed) {
      disposalError = this.#startupCleanupError;
      disposalFailed = true;
    }
    const lateSession = this.#session;
    try {
      await this.#disposeSession(lateSession);
    } catch (error) {
      if (!disposalFailed) disposalError = error;
      disposalFailed = true;
    }

    if (disposalFailed) throw disposalError;
  }
}
