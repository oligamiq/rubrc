import { runAcceptedTargetExtraction } from "./app_startup_lifecycle.ts";
import type { Ctx } from "./ctx.ts";
import type {
  RuntimeCommandService,
  RuntimeParserService,
  RuntimeSharedObjectFactories,
} from "./runtime_command_service.ts";
import type { RuntimeHostCallbackOwner } from "./runtime_host_callbacks.ts";
import type {
  Disposable as TerminalDisposable,
  RuntimeTerminalService,
  TerminalView,
} from "./runtime_terminal_service.ts";
import type {
  RuntimeWorkerEndpoint,
  RuntimeWorkerHandshake,
} from "./runtime_worker_protocol.ts";
import type { SysrootArchiveStore } from "./sysroot_archive_store.ts";
import type { createChannelOwner } from "./terminal_channel_lifecycle.ts";
import type { AdditionalSysrootRequest } from "./vfs_readiness.ts";

export class ReloadRequiredError extends Error {
  override readonly name = "ReloadRequiredError";
}

export type AppRuntimePhase =
  | "created"
  | "starting"
  | "ready"
  | "disposing"
  | "disposed"
  | "reload-required";

export type AppRuntimeOperation = "idle" | "run" | "target";

export type AppRuntimeLifecycleEvent =
  | "data-plane-detached"
  | "generation-aborted"
  | "host-producers-aborted"
  | "host-callbacks-settled"
  | "animal-destroy-requested"
  | "animal-destroyed"
  | "utility-worker-terminated"
  | "lifecycle-worker-terminated"
  | "operations-settled"
  | "farm-destroyed"
  | "owners-disposed"
  | "store-disposed"
  | "registrations-cleared"
  | "disposed"
  | "reload-required";

export type AppRuntimeState = Readonly<{
  phase: AppRuntimePhase;
  operation: AppRuntimeOperation;
  selectedTarget?: string;
  activeTarget?: string;
  queuedTargets: readonly string[];
  completedTargets: readonly string[];
  utilityWorkers: number;
  lifecycleWorkers: number;
  farmCallbacks: number;
}>;

export type RuntimeDisposable = TerminalDisposable;

export interface RuntimeAsyncDisposable {
  dispose(): Promise<void>;
}

export type RuntimeArchiveStore = Pick<
  SysrootArchiveStore,
  "prefetch" | "dispose"
>;

export type RuntimeTerminalOwner = Pick<
  RuntimeTerminalService,
  "attach" | "dispose" | "write" | "size" | "out" | "error"
>;

export type RuntimeParserOwner = Pick<
  RuntimeParserService,
  "ready" | "dispose"
>;

export type RuntimeCommandOwner = Pick<
  RuntimeCommandService,
  "run" | "download" | "dispose"
>;

export type RuntimeChannelOwner = ReturnType<typeof createChannelOwner>;

export interface RuntimeFarmOwner {
  destroy(): void;
}

export interface RuntimeFarmResources {
  farm: RuntimeFarmOwner;
  wasiRef: Parameters<RuntimeWorkerHandshake["initialize"]>[0];
  detachDataPlane(): void;
}

export interface RuntimeOperationOwner {
  readonly settlementLabel?: string;
  abort?(reason?: unknown): void;
  flush?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RuntimeOperationOwnerAdopter {
  adoptOperationOwner(owner: RuntimeOperationOwner): void;
}

export interface RuntimeLspDependencies {
  ctx: Ctx;
  signal: AbortSignal;
  adopter: RuntimeOperationOwnerAdopter;
  factories: RuntimeSharedObjectFactories;
}

export interface AppRuntimeDependencies<
  TArchiveStore extends RuntimeArchiveStore = RuntimeArchiveStore,
> {
  teardownTimeoutMs?: number;
  workspaceFileSystem?: unknown;
  createGeneration(): string;
  createCtx(): Ctx;
  createArchiveStore(): TArchiveStore;
  createTerminalService(generation: string): RuntimeTerminalOwner;
  createParserService(ctx: Ctx, signal: AbortSignal): RuntimeParserOwner;
  createCommandService(ctx: Ctx, signal: AbortSignal): RuntimeCommandOwner;
  createChannelOwner(): RuntimeChannelOwner;
  sharedObjectFactories: RuntimeSharedObjectFactories;
  createHostCallbacks(options: {
    generation: string;
    ctx: Ctx;
    signal: AbortSignal;
    archiveStore: TArchiveStore;
    terminal: RuntimeTerminalOwner;
    channels: RuntimeChannelOwner;
    workspaceFileSystem?: unknown;
    registerConstructionCleanup(cleanup: Promise<void>): void;
  }): RuntimeHostCallbackOwner;
  createFarm(options: {
    generation: string;
    ctx: Ctx;
    signal: AbortSignal;
    archiveStore: TArchiveStore;
    terminal: RuntimeTerminalOwner;
    hostCallbacks: RuntimeHostCallbackOwner;
    channels: RuntimeChannelOwner;
    workspaceFileSystem?: unknown;
  }): RuntimeFarmResources;
  createUtilityWorker(generation: string): RuntimeWorkerEndpoint;
  createLifecycleWorker(generation: string): RuntimeWorkerEndpoint;
  createWorkerHandshake(options: {
    generation: string;
    utilityWorker: RuntimeWorkerEndpoint;
    lifecycleWorker: RuntimeWorkerEndpoint;
    onFatalError(error: Error): void;
  }): RuntimeWorkerHandshake;
  targetEndpoint?: (request: AdditionalSysrootRequest) => Promise<number>;
  clearRegistrations?(generation: string): void;
  operationsSettled?(): void;
}

export type RuntimeQuarantineRetention<
  TArchiveStore extends RuntimeArchiveStore = RuntimeArchiveStore,
> = {
  generation: string;
  farm: RuntimeFarmOwner | undefined;
  archiveStore: TArchiveStore;
  hostCallbacks: RuntimeHostCallbackOwner | undefined;
  channels: RuntimeChannelOwner;
  terminal: RuntimeTerminalOwner;
  parser: RuntimeParserOwner;
  commands: RuntimeCommandOwner;
  workerHandshake: RuntimeWorkerHandshake | undefined;
  utilityWorker: RuntimeWorkerEndpoint | undefined;
  lifecycleWorker: RuntimeWorkerEndpoint | undefined;
};

const runtimeDisposedReason = () =>
  new DOMException("runtime disposed", "AbortError");

function observe<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

function observedRejection<T>(reason: unknown): Promise<T> {
  return observe(Promise.reject(reason));
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  observe(promise);
  if (signal.aborted) return observedRejection(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  observe(promise);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

function onceTerminatingEndpoint(
  endpoint: RuntimeWorkerEndpoint,
): RuntimeWorkerEndpoint {
  let terminated = false;
  return {
    addEventListener: endpoint.addEventListener.bind(endpoint),
    dispatchEvent: endpoint.dispatchEvent.bind(endpoint),
    removeEventListener: endpoint.removeEventListener.bind(endpoint),
    postMessage: endpoint.postMessage.bind(endpoint),
    terminate() {
      if (terminated) return;
      terminated = true;
      endpoint.terminate();
    },
  };
}

function throwWithCleanup(primary: unknown, cleanupErrors: unknown[]): void {
  if (primary !== undefined && cleanupErrors.length === 0) throw primary;
  if (primary !== undefined) {
    throw new AggregateError(cleanupErrors, "runtime cleanup failed", {
      cause: primary,
    });
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "runtime cleanup failed");
  }
}

export class RuntimeSupervisor<
  TArchiveStore extends RuntimeArchiveStore = RuntimeArchiveStore,
> {
  readonly #dependencies: AppRuntimeDependencies<TArchiveStore>;
  #current: AppRuntime<TArchiveStore> | undefined;
  #quarantine: RuntimeQuarantineRetention<TArchiveStore> | undefined;
  #admission = Promise.resolve();

  constructor(dependencies: AppRuntimeDependencies<TArchiveStore>) {
    this.#dependencies = dependencies;
  }

  get reloadRequired(): boolean {
    return this.#quarantine !== undefined;
  }

  get quarantineRetention():
    | Readonly<RuntimeQuarantineRetention<TArchiveStore>>
    | undefined {
    return this.#quarantine;
  }

  async create(): Promise<AppRuntime<TArchiveStore>> {
    let releaseTurn!: () => void;
    const previousTurn = this.#admission;
    this.#admission = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    await previousTurn;
    try {
      if (this.#quarantine !== undefined) {
        throw new ReloadRequiredError("reload required");
      }
      if (this.#current !== undefined) {
        if (!this.#current.disposing) {
          throw new Error("runtime already active");
        }
        try {
          await this.#current.dispose();
        } catch {
          // Fatal ordinary disposal still releases the generation slot.
        }
        if (this.#quarantine !== undefined) {
          throw new ReloadRequiredError("reload required");
        }
        if (this.#current !== undefined) {
          throw new Error("runtime teardown did not release its slot");
        }
      }

      const runtime = await AppRuntime.construct(this, this.#dependencies);
      this.#current = runtime;
      return runtime;
    } finally {
      releaseTurn();
    }
  }

  release(runtime: AppRuntime<TArchiveStore>): void {
    if (
      this.#current === runtime &&
      this.#current.generation === runtime.generation
    ) {
      this.#current = undefined;
    }
  }

  quarantine(
    runtime: AppRuntime<TArchiveStore>,
    retained: RuntimeQuarantineRetention<TArchiveStore>,
  ): void {
    if (
      this.#current !== runtime ||
      this.#current.generation !== retained.generation
    ) {
      return;
    }
    this.#quarantine = retained;
  }
}

export class AppRuntime<
  TArchiveStore extends RuntimeArchiveStore = RuntimeArchiveStore,
> {
  readonly generation: string;
  readonly ctx: Ctx;
  readonly archiveStore: TArchiveStore;
  readonly terminal: RuntimeTerminalOwner;
  readonly parser: RuntimeParserOwner;
  readonly commands: RuntimeCommandOwner;
  readonly channels: RuntimeChannelOwner;
  readonly lspDependencies: RuntimeLspDependencies;

  readonly #supervisor: RuntimeSupervisor<TArchiveStore>;
  readonly #dependencies: AppRuntimeDependencies<TArchiveStore>;
  readonly #abortController: AbortController;
  readonly #callerOperations = new Set<Promise<unknown>>();
  readonly #underlyingOperations = new Map<Promise<unknown>, string>();
  readonly #ownerDisposals = new Set<Promise<void>>();
  readonly #pendingOwnerDisposals = new Set<Promise<void>>();
  readonly #ownerDisposalLabels = new Map<Promise<void>, string>();
  readonly #constructionCleanups = new Set<Promise<void>>();
  readonly #lateStartupCleanups = new Set<Promise<void>>();
  readonly #lateStartupCleanupErrors: unknown[] = [];
  #lateStartupUnsafe = false;
  readonly #operationOwners: RuntimeOperationOwner[] = [];
  readonly #listeners = new Set<(state: AppRuntimeState) => void>();
  readonly #lifecycleListeners = new Set<
    (event: AppRuntimeLifecycleEvent) => void
  >();
  readonly #completedTargets = new Set<string>(["wasm32-wasip1"]);
  readonly #targetOperations = new Map<string, Promise<void>>();
  #targetQueue: string[] = [];
  #targetTail: Promise<void> = Promise.resolve();
  #downloadTail: Promise<void> = Promise.resolve();
  #coordinator: RuntimeOperationOwner | undefined;
  #state: AppRuntimeState = Object.freeze({
    phase: "created",
    operation: "idle",
    queuedTargets: Object.freeze([]),
    completedTargets: Object.freeze(["wasm32-wasip1"]),
    utilityWorkers: 0,
    lifecycleWorkers: 0,
    farmCallbacks: 0,
  });
  #primaryError: unknown;
  #disposePromise: Promise<void> | undefined;
  #hostCallbacks: RuntimeHostCallbackOwner | undefined;
  #farmResources: RuntimeFarmResources | undefined;
  #farmDataPlaneDetached = false;
  #utilityWorker: RuntimeWorkerEndpoint | undefined;
  #lifecycleWorker: RuntimeWorkerEndpoint | undefined;
  #workerHandshake: RuntimeWorkerHandshake | undefined;
  #terminalEndpoints:
    | {
      resize(args: {
        sessionId: number;
        cols: number;
        rows: number;
      }): Promise<void>;
      inputChar(args: { sessionId: number; c: number }): Promise<void>;
      inputString(args: { sessionId: number; data: string }): Promise<void>;
      interrupt(args: { sessionId: number }): Promise<void>;
      createSession(args: { sessionId: number }): Promise<void>;
      closeSession(args: { sessionId: number }): Promise<void>;
    }
    | undefined;
  readonly #createdTerminalSessions = new Set<number>([0]);

  private constructor(options: {
    supervisor: RuntimeSupervisor<TArchiveStore>;
    dependencies: AppRuntimeDependencies<TArchiveStore>;
    generation: string;
    ctx: Ctx;
    archiveStore: TArchiveStore;
    terminal: RuntimeTerminalOwner;
    parser: RuntimeParserOwner;
    commands: RuntimeCommandOwner;
    channels: RuntimeChannelOwner;
    abortController: AbortController;
  }) {
    this.#supervisor = options.supervisor;
    this.#dependencies = options.dependencies;
    this.generation = options.generation;
    this.ctx = options.ctx;
    this.archiveStore = options.archiveStore;
    this.terminal = options.terminal;
    this.parser = options.parser;
    this.commands = options.commands;
    this.channels = options.channels;
    this.#abortController = options.abortController;
    this.lspDependencies = {
      ctx: this.ctx,
      signal: this.signal,
      adopter: this,
      factories: {
        createSharedObject: (value, id) =>
          this.channels.add(
            this.#dependencies.sharedObjectFactories.createSharedObject(
              value,
              id,
            ),
          ),
        createSharedObjectRef: (id) =>
          this.channels.add(
            this.#dependencies.sharedObjectFactories.createSharedObjectRef(id),
          ),
      },
    };
    this.#getTerminalEndpoints();
    observe(this.parser.ready);
  }

  static async construct<TArchiveStore extends RuntimeArchiveStore>(
    supervisor: RuntimeSupervisor<TArchiveStore>,
    dependencies: AppRuntimeDependencies<TArchiveStore>,
  ): Promise<AppRuntime<TArchiveStore>> {
    const generation = dependencies.createGeneration();
    let archiveStore: TArchiveStore | undefined;
    let terminal: RuntimeTerminalOwner | undefined;
    let parser: RuntimeParserOwner | undefined;
    let commands: RuntimeCommandOwner | undefined;
    let channels: RuntimeChannelOwner | undefined;
    const abortController = new AbortController();
    try {
      const ctx = dependencies.createCtx();
      archiveStore = dependencies.createArchiveStore();
      terminal = dependencies.createTerminalService(generation);
      parser = dependencies.createParserService(ctx, abortController.signal);
      commands = dependencies.createCommandService(ctx, abortController.signal);
      channels = dependencies.createChannelOwner();
      const runtime = new AppRuntime({
        supervisor,
        dependencies,
        generation,
        ctx,
        archiveStore,
        terminal,
        parser,
        commands,
        channels,
        abortController,
      });
      return runtime;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      abortController.abort(error);
      for (
        const owner of [
          commands,
          parser,
          terminal,
          channels,
          archiveStore,
        ]
      ) {
        if (owner === undefined) continue;
        try {
          owner.dispose();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        dependencies.clearRegistrations?.(generation);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "runtime construction cleanup failed",
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  get phase(): AppRuntimePhase {
    return this.#state.phase;
  }

  get state(): AppRuntimeState {
    return this.#state;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get disposing(): boolean {
    return (
      this.#state.phase === "disposing" ||
      this.#state.phase === "disposed" ||
      this.#state.phase === "reload-required"
    );
  }

  subscribe(listener: (state: AppRuntimeState) => void): () => void {
    this.#listeners.add(listener);
    try {
      listener(this.#state);
    } catch (error) {
      this.#listeners.delete(listener);
      throw error;
    }
    return () => this.#listeners.delete(listener);
  }

  subscribeLifecycle(
    listener: (event: AppRuntimeLifecycleEvent) => void,
  ): () => void {
    this.#lifecycleListeners.add(listener);
    return () => this.#lifecycleListeners.delete(listener);
  }

  #publishLifecycle(event: AppRuntimeLifecycleEvent): void {
    for (const listener of this.#lifecycleListeners) {
      try {
        listener(event);
      } catch (error) {
        this.#lifecycleListeners.delete(listener);
        try {
          console.error("AppRuntime lifecycle subscriber failed", error);
        } catch {
          // Reporting must not alter teardown control flow.
        }
      }
    }
  }

  #transition(update: Partial<AppRuntimeState>): void {
    this.#state = Object.freeze({
      ...this.#state,
      ...update,
      queuedTargets: Object.freeze([
        ...(update.queuedTargets ?? this.#state.queuedTargets),
      ]),
      completedTargets: Object.freeze([
        ...(update.completedTargets ?? this.#state.completedTargets),
      ]),
    });
    for (const listener of this.#listeners) {
      try {
        listener(this.#state);
      } catch (error) {
        this.#listeners.delete(listener);
        try {
          console.error("AppRuntime state subscriber failed", error);
        } catch {
          // Reporting must not alter runtime state or control flow.
        }
      }
    }
  }

  adoptCoordinator(owner: RuntimeOperationOwner): void {
    if (
      this.#state.phase === "disposing" ||
      this.#state.phase === "disposed" ||
      this.#state.phase === "reload-required"
    ) {
      throw this.#abortController.signal.reason ?? runtimeDisposedReason();
    }
    if (this.#coordinator !== undefined) {
      throw new Error("runtime coordinator already adopted");
    }
    this.#coordinator = owner;
  }

  adoptOperationOwner(owner: RuntimeOperationOwner): void {
    if (this.disposing) throw this.#abortController.signal.reason;
    this.#operationOwners.push(owner);
  }

  attachTerminal(sessionId: number, view: TerminalView): RuntimeDisposable {
    if (this.disposing) throw this.#abortController.signal.reason;
    const attachment = this.terminal.attach(sessionId, view);
    if (!this.#createdTerminalSessions.has(sessionId)) {
      this.#createdTerminalSessions.add(sessionId);
      void this.trackOperation(
        this.#getTerminalEndpoints().createSession({ sessionId }),
        `terminal:${sessionId}:create`,
      ).catch((error) => {
        if (!this.signal.aborted) void this.reportFatal(error);
      });
    }
    return attachment;
  }

  resizeTerminal(sessionId: number, cols: number, rows: number): Promise<void> {
    if (this.disposing) return observedRejection(this.signal.reason);
    if (this.#state.phase !== "ready") return Promise.resolve();
    return this.trackOperation(
      this.#getTerminalEndpoints().resize({ sessionId, cols, rows }),
      `terminal:${sessionId}:resize`,
    );
  }

  inputTerminal(sessionId: number, data: string | number): Promise<void> {
    const endpoints = this.#getTerminalEndpoints();
    return this.trackOperation(
      typeof data === "number"
        ? endpoints.inputChar({ sessionId, c: data })
        : endpoints.inputString({ sessionId, data }),
      `terminal:${sessionId}:input`,
    );
  }

  interruptTerminal(sessionId: number): Promise<void> {
    return this.trackOperation(
      this.#getTerminalEndpoints().interrupt({ sessionId }),
      `terminal:${sessionId}:interrupt`,
    );
  }

  closeTerminal(sessionId: number): Promise<void> {
    this.#createdTerminalSessions.delete(sessionId);
    return this.trackOperation(
      this.#getTerminalEndpoints().closeSession({ sessionId }),
      `terminal:${sessionId}:close`,
    );
  }

  download(file: string): Promise<void> {
    this.#assertReady();
    const queued = this.#downloadTail.then(() => {
      this.signal.throwIfAborted();
      return this.commands.download(file);
    });
    const operation = this.trackOperation(queued, `download:${file}`);
    this.#downloadTail = operation.catch(() => undefined);
    return operation;
  }

  start(): Promise<void> {
    if (this.#state.phase !== "created") {
      return observedRejection(new Error("runtime already started"));
    }
    this.#transition({ phase: "starting" });
    let resolveStartup!: () => void;
    let rejectStartup!: (reason: unknown) => void;
    const startupSettlement = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    this.#observeUnderlyingOperation(startupSettlement, "startup");
    const startup = (async () => {
      try {
        await startupSettlement;
      } catch (error) {
        const disposal = this.dispose();
        if (error === this.signal.reason && this.#primaryError === undefined) {
          observe(disposal);
          throw error;
        }
        await disposal;
        throw error;
      }
    })();
    this.#callerOperations.add(startup);
    observe(startup);
    void startup
      .finally(() => this.#callerOperations.delete(startup))
      .catch(() => {});
    this.#startInner().then(resolveStartup, rejectStartup);
    return startup;
  }

  async #startInner(): Promise<void> {
    try {
      this.signal.throwIfAborted();
      const hostCallbacks = this.#dependencies.createHostCallbacks({
        generation: this.generation,
        ctx: this.ctx,
        signal: this.signal,
        archiveStore: this.archiveStore,
        terminal: this.terminal,
        channels: this.channels,
        workspaceFileSystem: this.#dependencies.workspaceFileSystem,
        registerConstructionCleanup: (cleanup) => {
          this.#constructionCleanups.add(observe(cleanup));
        },
      });
      const callbacksAcquiredWhileDisposing = this.disposing;
      this.#hostCallbacks = hostCallbacks;
      this.#transition({
        farmCallbacks: this.#state.farmCallbacks + 1,
      });
      if (callbacksAcquiredWhileDisposing || this.disposing) {
        try {
          hostCallbacks.abort(this.signal.reason);
        } catch (error) {
          this.#lateStartupCleanupErrors.push(error);
        }
        if (callbacksAcquiredWhileDisposing) {
          try {
            this.#trackLateStartupCleanup(
              hostCallbacks.dispose().then(() => {
                this.#transition({ farmCallbacks: 0 });
              }),
            );
          } catch (error) {
            this.#lateStartupCleanupErrors.push(error);
            this.#lateStartupUnsafe = true;
          }
        }
        throw this.signal.reason;
      }

      this.signal.throwIfAborted();
      const farmResources = this.#dependencies.createFarm({
        generation: this.generation,
        ctx: this.ctx,
        signal: this.signal,
        archiveStore: this.archiveStore,
        terminal: this.terminal,
        hostCallbacks: this.#hostCallbacks,
        channels: this.channels,
        workspaceFileSystem: this.#dependencies.workspaceFileSystem,
      });
      const farmAcquiredWhileDisposing = this.disposing;
      this.#farmResources = farmResources;
      if (farmAcquiredWhileDisposing || this.disposing) {
        try {
          this.#detachFarmDataPlane();
        } catch (error) {
          this.#lateStartupCleanupErrors.push(error);
          this.#lateStartupUnsafe = true;
        }
        throw this.signal.reason;
      }

      this.signal.throwIfAborted();
      const utilityWorker = onceTerminatingEndpoint(
        this.#dependencies.createUtilityWorker(this.generation),
      );
      const utilityAcquiredWhileDisposing = this.disposing;
      this.#utilityWorker = utilityWorker;
      this.#transition({
        utilityWorkers: this.#state.utilityWorkers + 1,
      });
      if (utilityAcquiredWhileDisposing || this.disposing) {
        try {
          utilityWorker.terminate();
          this.#transition({ utilityWorkers: 0 });
        } catch (error) {
          this.#lateStartupCleanupErrors.push(error);
          this.#lateStartupUnsafe = true;
        }
        throw this.signal.reason;
      }

      this.signal.throwIfAborted();
      const lifecycleWorker = onceTerminatingEndpoint(
        this.#dependencies.createLifecycleWorker(this.generation),
      );
      const lifecycleAcquiredWhileDisposing = this.disposing;
      this.#lifecycleWorker = lifecycleWorker;
      this.#transition({
        lifecycleWorkers: this.#state.lifecycleWorkers + 1,
      });
      if (lifecycleAcquiredWhileDisposing || this.disposing) {
        try {
          lifecycleWorker.terminate();
          this.#transition({ lifecycleWorkers: 0 });
        } catch (error) {
          this.#lateStartupCleanupErrors.push(error);
          this.#lateStartupUnsafe = true;
        }
        throw this.signal.reason;
      }

      this.signal.throwIfAborted();
      let pendingHandshakeFatal: Error | undefined;
      const workerHandshake = this.#dependencies.createWorkerHandshake({
        generation: this.generation,
        utilityWorker,
        lifecycleWorker,
        onFatalError: (error) => {
          if (this.disposing) return;
          if (this.#workerHandshake === undefined) {
            pendingHandshakeFatal ??= error;
            return;
          }
          void this.reportFatal(error);
        },
      });
      const handshakeAcquiredWhileDisposing = this.disposing;
      this.#workerHandshake = workerHandshake;
      if (pendingHandshakeFatal !== undefined && !this.disposing) {
        void this.reportFatal(pendingHandshakeFatal);
      }
      if (handshakeAcquiredWhileDisposing || this.disposing) {
        if (handshakeAcquiredWhileDisposing) {
          try {
            this.#trackLateStartupCleanup(workerHandshake.dispose());
          } catch (error) {
            this.#lateStartupCleanupErrors.push(error);
            this.#lateStartupUnsafe = true;
          }
        }
        throw this.signal.reason;
      }

      await raceAbort(
        workerHandshake.initialize(farmResources.wasiRef, this.ctx),
        this.signal,
      );
      if (this.#state.phase === "starting") {
        this.#transition({ phase: "ready" });
      }
    } catch (error) {
      if (this.disposing && this.signal.aborted) throw this.signal.reason;
      void this.reportFatal(error);
      throw error;
    }
  }

  async run(triple?: string): Promise<void> {
    this.#assertReady();
    if (
      this.#state.operation !== "idle" ||
      this.#state.queuedTargets.length !== 0
    ) {
      throw new Error(
        `runtime busy: ${
          this.#state.operation === "idle" ? "target" : this.#state.operation
        }`,
      );
    }
    this.#transition({ operation: "run" });
    try {
      await this.flushWorkspace();
      await this.trackOperation(this.commands.run(triple), "run:command");
    } finally {
      if (this.#state.phase === "ready") {
        this.#transition({ operation: "idle" });
      }
    }
  }

  async flushWorkspace(): Promise<void> {
    this.#assertReady();
    const coordinator = this.#coordinator;
    const flush = coordinator?.flush;
    if (flush === undefined) throw new Error("runtime flush is not configured");
    await this.trackOperation(flush.call(coordinator), "workspace:flush");
  }

  loadTarget(triple: string): Promise<void> {
    try {
      this.#assertReady();
    } catch (error) {
      return observedRejection(error);
    }
    if (this.#state.operation === "run") {
      return observedRejection(new Error("runtime busy: run"));
    }
    if (this.#completedTargets.has(triple)) {
      this.#transition({ selectedTarget: triple });
      return Promise.resolve();
    }
    const duplicate = this.#targetOperations.get(triple);
    if (duplicate !== undefined) {
      this.#transition({ selectedTarget: triple });
      return duplicate;
    }
    const endpoint = this.#dependencies.targetEndpoint;
    if (endpoint === undefined) {
      this.#transition({ selectedTarget: triple });
      return observedRejection(new Error("target loading is not configured"));
    }
    this.#targetQueue.push(triple);
    const queued = this.#targetTail
      .then(async () => {
        this.signal.throwIfAborted();
        await this.archiveStore.prefetch([triple], this.signal);
        this.signal.throwIfAborted();
        this.#transition({ activeTarget: triple });
        await runAcceptedTargetExtraction({
          triple,
          endpoint: (request) =>
            this.#observeUnderlyingOperation(
              endpoint(request),
              `target:${triple}:${request.operation}`,
            ),
          generationSignal: this.signal,
          onTerminalWorkerFailure: (error) => {
            void this.reportFatal(error);
          },
        });
        this.#completedTargets.add(triple);
      })
      .finally(() => {
        this.#targetOperations.delete(triple);
        if (this.#state.phase !== "ready") return;
        this.#targetQueue = this.#targetQueue.filter(
          (queuedTriple) => queuedTriple !== triple,
        );
        this.#transition({
          queuedTargets: this.#targetQueue,
          operation: this.#targetQueue.length === 0 ? "idle" : "target",
          activeTarget: undefined,
          completedTargets: [...this.#completedTargets],
        });
      });
    const operation = this.trackOperation(queued, `target:${triple}:queue`);
    this.#targetTail = operation.catch(() => undefined);
    this.#targetOperations.set(triple, operation);
    this.#transition({
      operation: "target",
      selectedTarget: triple,
      queuedTargets: this.#targetQueue,
      completedTargets: [...this.#completedTargets],
    });
    return operation;
  }

  #assertReady(): void {
    if (this.disposing) throw this.signal.reason;
    if (this.#state.phase !== "ready") throw new Error("runtime is not ready");
  }

  #getTerminalEndpoints() {
    if (this.#terminalEndpoints !== undefined) return this.#terminalEndpoints;
    const createProxy = <T,>(id: string): T =>
      this.channels
        .add(this.#dependencies.sharedObjectFactories.createSharedObjectRef(id))
        .proxy<T>();
    this.#terminalEndpoints = {
      resize: createProxy(this.ctx.resize_id),
      inputChar: createProxy(this.ctx.input_char_id),
      inputString: createProxy(this.ctx.input_string_id),
      interrupt: createProxy(this.ctx.interrupt_id),
      createSession: createProxy(this.ctx.create_session_id),
      closeSession: createProxy(this.ctx.close_session_id),
    };
    return this.#terminalEndpoints;
  }

  trackOperation<T>(operation: Promise<T>, label = "operation"): Promise<T> {
    if (this.disposing) return observedRejection(this.signal.reason);
    const underlying = this.#observeUnderlyingOperation(operation, label);
    const wrapped = raceAbort(underlying, this.signal);
    this.#callerOperations.add(wrapped);
    observe(wrapped);
    void wrapped
      .finally(() => this.#callerOperations.delete(wrapped))
      .catch(() => {});
    return wrapped;
  }

  #observeUnderlyingOperation<T>(operation: Promise<T>, label: string): Promise<T> {
    this.#underlyingOperations.set(operation, label);
    observe(operation);
    void operation
      .finally(() => this.#underlyingOperations.delete(operation))
      .catch(() => {});
    return operation;
  }

  reportFatal(error: unknown): Promise<void> {
    if (this.#primaryError === undefined) this.#primaryError = error;
    return this.dispose();
  }

  dispose(): Promise<void> {
    if (this.#disposePromise === undefined) {
      let resolveDisposal!: () => void;
      let rejectDisposal!: (reason: unknown) => void;
      this.#disposePromise = new Promise<void>((resolve, reject) => {
        resolveDisposal = resolve;
        rejectDisposal = reject;
      });
      observe(this.#disposePromise);
      this.#disposeInner().then(resolveDisposal, rejectDisposal);
    }
    return this.#disposePromise;
  }

  async #disposeInner(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    let callbacksSafe = this.#hostCallbacks === undefined;
    let animalSafe = this.#workerHandshake === undefined;
    let operationsSafe = false;
    this.#targetQueue = [];
    this.#transition({
      phase: "disposing",
      operation: "idle",
      queuedTargets: [],
      activeTarget: undefined,
    });
    try {
      const dataPlaneWasAttached =
        this.#farmResources !== undefined && !this.#farmDataPlaneDetached;
      this.#detachFarmDataPlane();
      if (dataPlaneWasAttached) this.#publishLifecycle("data-plane-detached");
    } catch (error) {
      cleanupErrors.push(error);
    }
    const reason = this.#primaryError ?? runtimeDisposedReason();
    this.#abortController.abort(reason);
    this.#publishLifecycle("generation-aborted");
    try {
      this.#hostCallbacks?.abort(reason);
      if (this.#hostCallbacks !== undefined) {
        this.#publishLifecycle("host-producers-aborted");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const owner of [this.#coordinator, ...this.#operationOwners]) {
      try {
        owner?.abort?.(reason);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    this.#initiateOperationDisposals();

    if (this.#hostCallbacks !== undefined) {
      try {
        await withDeadline(
          this.#hostCallbacks.dispose(),
          this.#dependencies.teardownTimeoutMs ?? 5_000,
          "host callback settlement timed out after 5000ms",
        );
        callbacksSafe = true;
        this.#transition({ farmCallbacks: 0 });
        this.#publishLifecycle("host-callbacks-settled");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (this.#workerHandshake !== undefined) {
      try {
        this.#publishLifecycle("animal-destroy-requested");
        await withDeadline(
          this.#workerHandshake.dispose(),
          this.#dependencies.teardownTimeoutMs ?? 5_000,
          "Animal destroy acknowledgement timed out after 5000ms",
        );
        animalSafe = true;
        this.#publishLifecycle("animal-destroyed");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      if (this.#utilityWorker !== undefined) {
        this.#utilityWorker.terminate();
        this.#transition({ utilityWorkers: 0 });
        this.#publishLifecycle("utility-worker-terminated");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (this.#lifecycleWorker !== undefined) {
        this.#lifecycleWorker.terminate();
        this.#transition({ lifecycleWorkers: 0 });
        this.#publishLifecycle("lifecycle-worker-terminated");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    operationsSafe = await this.#settleOperations(cleanupErrors);
    this.#publishLifecycle("operations-settled");

    if (!callbacksSafe || !animalSafe || !operationsSafe) {
      this.#transition({ phase: "reload-required" });
      this.#publishLifecycle("reload-required");
      this.#supervisor.quarantine(this, {
        generation: this.generation,
        farm: this.#farmResources?.farm,
        archiveStore: this.archiveStore,
        hostCallbacks: this.#hostCallbacks,
        channels: this.channels,
        terminal: this.terminal,
        parser: this.parser,
        commands: this.commands,
        workerHandshake: this.#workerHandshake,
        utilityWorker: this.#utilityWorker,
        lifecycleWorker: this.#lifecycleWorker,
      });
      try {
        this.#dependencies.clearRegistrations?.(this.generation);
        if (this.#dependencies.clearRegistrations !== undefined) {
          this.#publishLifecycle("registrations-cleared");
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      throwWithCleanup(this.#primaryError, cleanupErrors);
      return;
    }

    try {
      this.#farmResources?.farm.destroy();
      if (this.#farmResources !== undefined) {
        this.#publishLifecycle("farm-destroyed");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (
      const owner of [
        this.commands,
        this.parser,
        this.terminal,
        this.channels,
      ]
    ) {
      try {
        owner.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    this.#publishLifecycle("owners-disposed");
    try {
      this.archiveStore.dispose();
      this.#publishLifecycle("store-disposed");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.#dependencies.clearRegistrations?.(this.generation);
      if (this.#dependencies.clearRegistrations !== undefined) {
        this.#publishLifecycle("registrations-cleared");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    this.#transition({ phase: "disposed" });
    this.#publishLifecycle("disposed");
    this.#supervisor.release(this);
    throwWithCleanup(this.#primaryError, cleanupErrors);
  }

  #detachFarmDataPlane(): void {
    if (this.#farmResources === undefined || this.#farmDataPlaneDetached) {
      return;
    }
    this.#farmDataPlaneDetached = true;
    this.#farmResources.detachDataPlane();
  }

  #initiateOperationDisposals(): void {
    const owners = [this.#coordinator, ...this.#operationOwners].filter(
      (owner): owner is RuntimeOperationOwner => owner !== undefined,
    );
    for (const owner of owners) {
      const disposal = (async () => await owner.dispose())();
      this.#ownerDisposals.add(disposal);
      this.#pendingOwnerDisposals.add(disposal);
      this.#ownerDisposalLabels.set(
        disposal,
        owner.settlementLabel ?? owner.constructor.name ?? "operation-owner",
      );
      observe(disposal);
      void disposal
        .finally(() => {
          this.#pendingOwnerDisposals.delete(disposal);
        })
        .catch(() => {});
    }
  }

  #trackLateStartupCleanup(cleanup: Promise<void>): void {
    this.#lateStartupCleanups.add(observe(cleanup));
  }

  async #settleOperations(cleanupErrors: unknown[]): Promise<boolean> {
    const ownerDisposals = [...this.#ownerDisposals];
    const constructionCleanups = [...this.#constructionCleanups];
    const requiredCleanups = [...ownerDisposals, ...constructionCleanups];
    const underlyingOperations = [...this.#underlyingOperations.keys()];
    const settlement = Promise.allSettled([
      ...requiredCleanups,
      ...underlyingOperations,
    ]);
    let safe = false;
    try {
      const results = await withDeadline(
        settlement,
        this.#dependencies.teardownTimeoutMs ?? 5_000,
        "runtime operation settlement timed out after 5000ms",
      );
      safe = true;
      for (let index = 0; index < requiredCleanups.length; index++) {
        const result = results[index];
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
    } catch (error) {
      const pendingOwners = ownerDisposals
        .filter((disposal) => this.#pendingOwnerDisposals.has(disposal))
        .map((disposal) =>
          this.#ownerDisposalLabels.get(disposal) ?? "operation-owner"
        );
      const pendingUnderlying = underlyingOperations
        .filter((operation) => this.#underlyingOperations.has(operation))
        .map((operation) =>
          this.#underlyingOperations.get(operation) ?? "operation"
        );
      cleanupErrors.push(
        new Error(
          `${error instanceof Error ? error.message : String(error)}; ` +
            `pending operation owners: ${pendingOwners.join(", ") || "none"}; ` +
            `pending underlying operations: ${pendingUnderlying.join(", ") || "none"}`,
          { cause: error },
        ),
      );
    }
    const lateStartupCleanups = [...this.#lateStartupCleanups];
    if (lateStartupCleanups.length > 0) {
      try {
        const results = await withDeadline(
          Promise.allSettled(lateStartupCleanups),
          this.#dependencies.teardownTimeoutMs ?? 5_000,
          "late startup cleanup timed out after 5000ms",
        );
        for (const result of results) {
          if (result.status === "rejected") {
            cleanupErrors.push(result.reason);
            safe = false;
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
        safe = false;
      }
    }
    cleanupErrors.push(...this.#lateStartupCleanupErrors);
    if (this.#lateStartupUnsafe) safe = false;
    try {
      this.#dependencies.operationsSettled?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    return safe;
  }
}
