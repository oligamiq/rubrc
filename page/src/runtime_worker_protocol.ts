import type {
  DestroyerHandleObject,
  WASIFarmRefObject,
} from "@oligami/browser_wasi_shim-threads";
import type { Ctx } from "./ctx.ts";
import type { RuntimeGeneration } from "./runtime_terminal_service.ts";

export type UtilityWorkerInbound =
  | {
      type: "initialize";
      generation: RuntimeGeneration;
      wasiRef: WASIFarmRefObject;
      ctx: Ctx;
    }
  | { type: "destroyer-adopted"; generation: RuntimeGeneration }
  | { type: "cancel-before-destroyer"; generation: RuntimeGeneration }
  | {
      type: "destroyer-adoption-failed";
      generation: RuntimeGeneration;
      message: string;
    };

export type UtilityWorkerOutbound =
  | {
      type: "destroyer";
      generation: RuntimeGeneration;
      handle: DestroyerHandleObject;
    }
  | { type: "cancelled-before-destroyer"; generation: RuntimeGeneration }
  | { type: "ready"; generation: RuntimeGeneration }
  | { type: "control-fatal"; message: string }
  | { type: "fatal"; generation: RuntimeGeneration; message: string };

export type LifecycleWorkerInbound =
  | {
      type: "adopt";
      generation: RuntimeGeneration;
      handle: DestroyerHandleObject;
    }
  | { type: "destroy"; generation: RuntimeGeneration; token: string };

export type LifecycleWorkerOutbound =
  | { type: "adopted"; generation: RuntimeGeneration }
  | { type: "destroyed"; generation: RuntimeGeneration; token: string }
  | {
      type: "fatal";
      generation: RuntimeGeneration;
      token?: string;
      message: string;
    };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isGeneration(value: unknown): value is RuntimeGeneration {
  return typeof value === "string" && value.length > 0;
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCloneableObject(value: unknown): value is RecordValue {
  return isRecord(value);
}

export function isUtilityWorkerInbound(
  value: unknown,
): value is UtilityWorkerInbound {
  if (!isRecord(value) || !isGeneration(value.generation)) return false;
  if (value.type === "initialize") {
    return (
      hasExactKeys(value, ["type", "generation", "wasiRef", "ctx"]) &&
      isCloneableObject(value.wasiRef) &&
      isCloneableObject(value.ctx)
    );
  }
  if (value.type === "destroyer-adopted") {
    return hasExactKeys(value, ["type", "generation"]);
  }
  if (value.type === "cancel-before-destroyer") {
    return hasExactKeys(value, ["type", "generation"]);
  }
  return (
    value.type === "destroyer-adoption-failed" &&
    hasExactKeys(value, ["type", "generation", "message"]) &&
    typeof value.message === "string"
  );
}

export function isUtilityWorkerOutbound(
  value: unknown,
): value is UtilityWorkerOutbound {
  if (!isRecord(value)) return false;
  if (value.type === "control-fatal") {
    return (
      hasExactKeys(value, ["type", "message"]) &&
      typeof value.message === "string"
    );
  }
  if (!isGeneration(value.generation)) return false;
  if (value.type === "destroyer") {
    return (
      hasExactKeys(value, ["type", "generation", "handle"]) &&
      isCloneableObject(value.handle)
    );
  }
  if (value.type === "ready") {
    return hasExactKeys(value, ["type", "generation"]);
  }
  if (value.type === "cancelled-before-destroyer") {
    return hasExactKeys(value, ["type", "generation"]);
  }
  return (
    value.type === "fatal" &&
    hasExactKeys(value, ["type", "generation", "message"]) &&
    typeof value.message === "string"
  );
}

export function isLifecycleWorkerInbound(
  value: unknown,
): value is LifecycleWorkerInbound {
  if (!isRecord(value) || !isGeneration(value.generation)) return false;
  if (value.type === "adopt") {
    return (
      hasExactKeys(value, ["type", "generation", "handle"]) &&
      isCloneableObject(value.handle)
    );
  }
  return (
    value.type === "destroy" &&
    hasExactKeys(value, ["type", "generation", "token"]) &&
    isToken(value.token)
  );
}

export function isLifecycleWorkerOutbound(
  value: unknown,
): value is LifecycleWorkerOutbound {
  if (!isRecord(value) || !isGeneration(value.generation)) return false;
  if (value.type === "adopted") {
    return hasExactKeys(value, ["type", "generation"]);
  }
  if (value.type === "destroyed") {
    return (
      hasExactKeys(value, ["type", "generation", "token"]) &&
      isToken(value.token)
    );
  }
  if (value.type !== "fatal" || typeof value.message !== "string") return false;
  if (value.token === undefined) {
    return hasExactKeys(value, ["type", "generation", "message"]);
  }
  return (
    hasExactKeys(value, ["type", "generation", "token", "message"]) &&
    isToken(value.token)
  );
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UtilityWorkerStartupError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(toErrorMessage(cause));
    this.name = "UtilityWorkerStartupError";
    this.cause = cause;
  }
}

export function createUtilityWorkerMessageHandler(options: {
  machine: { handle(message: unknown): Promise<void> };
  postMessage(message: UtilityWorkerOutbound): void;
}) {
  let terminal = false;
  return async (message: unknown): Promise<void> => {
    const terminalAdoptionFailure =
      terminal &&
      isUtilityWorkerInbound(message) &&
      message.type === "destroyer-adoption-failed";
    if (terminal && !terminalAdoptionFailure) return;
    try {
      await options.machine.handle(message);
    } catch (error) {
      if (terminalAdoptionFailure) return;
      terminal = true;
      if (error instanceof UtilityWorkerStartupError) return;

      const outbound: UtilityWorkerOutbound = {
        type: "control-fatal",
        message: toErrorMessage(error),
      };
      try {
        options.postMessage(outbound);
      } catch (postError) {
        console.error(
          "failed to report utility worker protocol error",
          postError,
        );
      }
    }
  };
}

interface UtilityAnimal {
  create_destroyer(): { get_object(): DestroyerHandleObject };
  start(root: unknown): unknown;
  destroy(): void;
}

export interface UtilityWorkerStateMachineDependencies<
  TAnimal extends UtilityAnimal,
  TPrerequisite = undefined,
> {
  prepareAnimal?(
    message: Extract<UtilityWorkerInbound, { type: "initialize" }>,
    signal: AbortSignal,
  ): Promise<TPrerequisite> | TPrerequisite;
  createAnimal(
    message: Extract<UtilityWorkerInbound, { type: "initialize" }>,
    prerequisite: TPrerequisite,
  ): TAnimal;
  startGuest(
    animal: TAnimal,
    message: Extract<UtilityWorkerInbound, { type: "initialize" }>,
    prerequisite: TPrerequisite,
  ): Promise<void> | void;
  postMessage(message: UtilityWorkerOutbound): void;
  onAdopted?(): void;
  onFailure?(): void;
}

export function createUtilityWorkerStateMachine<
  TAnimal extends UtilityAnimal,
  TPrerequisite = undefined,
>(dependencies: UtilityWorkerStateMachineDependencies<TAnimal, TPrerequisite>) {
  let initialized = false;
  let adopted = false;
  let lifecycleOwnsDestroyer = false;
  let activeGeneration: RuntimeGeneration | undefined;
  let animalCreated = false;
  let cancelledBeforeAnimal = false;
  const prerequisiteController = new AbortController();
  let resolveAdoption: (() => void) | undefined;
  let rejectAdoption: ((reason: unknown) => void) | undefined;
  const adoption = new Promise<void>((resolve, reject) => {
    resolveAdoption = resolve;
    rejectAdoption = reject;
  });

  const initialize = async (
    message: Extract<UtilityWorkerInbound, { type: "initialize" }>,
  ): Promise<void> => {
    let animal: TAnimal | undefined;
    try {
      const prerequisite = dependencies.prepareAnimal
        ? await dependencies.prepareAnimal(
            message,
            prerequisiteController.signal,
          )
        : (undefined as TPrerequisite);
      if (cancelledBeforeAnimal) {
        throw new Error("disposed before Animal construction");
      }
      animal = dependencies.createAnimal(message, prerequisite);
      animalCreated = true;
      dependencies.postMessage({
        type: "destroyer",
        generation: message.generation,
        handle: animal.create_destroyer().get_object(),
      });
      await adoption;
      await dependencies.startGuest(animal, message, prerequisite);
      dependencies.postMessage({
        type: "ready",
        generation: message.generation,
      });
    } catch (error) {
      let reportedError = error;
      const cleanupErrors: unknown[] = [];
      try {
        dependencies.onFailure?.();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (!lifecycleOwnsDestroyer) {
        try {
          animal?.destroy();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        const cleanupMessage = cleanupErrors.map(toErrorMessage).join("; ");
        reportedError = new AggregateError(
          [error, ...cleanupErrors],
          `${toErrorMessage(error)}; cleanup failed: ${cleanupMessage}`,
        );
      }
      dependencies.postMessage({
        type: "fatal",
        generation: message.generation,
        message: toErrorMessage(reportedError),
      });
      throw new UtilityWorkerStartupError(reportedError);
    }
  };

  return {
    handle(message: unknown): Promise<void> {
      if (!isUtilityWorkerInbound(message)) {
        return Promise.reject(new Error("invalid utility worker message"));
      }
      if (message.type === "initialize") {
        if (initialized) {
          return Promise.reject(
            new Error("utility worker already initialized"),
          );
        }
        initialized = true;
        activeGeneration = message.generation;
        return initialize(message);
      }
      if (!initialized) {
        return Promise.reject(new Error("utility worker is not initialized"));
      }
      if (message.generation !== activeGeneration) {
        return Promise.reject(new Error("utility worker generation mismatch"));
      }
      if (message.type === "cancel-before-destroyer") {
        if (!animalCreated && !cancelledBeforeAnimal) {
          cancelledBeforeAnimal = true;
          prerequisiteController.abort(
            new Error("disposed before Animal construction"),
          );
          dependencies.postMessage({
            type: "cancelled-before-destroyer",
            generation: message.generation,
          });
        }
        return Promise.resolve();
      }
      if (adopted) {
        return Promise.reject(new Error("destroyer already adopted"));
      }
      if (message.type === "destroyer-adoption-failed") {
        rejectAdoption?.(new Error(message.message));
        rejectAdoption = undefined;
        resolveAdoption = undefined;
        return Promise.resolve();
      }
      adopted = true;
      lifecycleOwnsDestroyer = true;
      dependencies.onAdopted?.();
      resolveAdoption?.();
      resolveAdoption = undefined;
      rejectAdoption = undefined;
      return Promise.resolve();
    },
  };
}

interface LifecycleDestroyer {
  destroy(): void;
}

export function createLifecycleWorkerStateMachine(dependencies: {
  restoreDestroyer(handle: DestroyerHandleObject): LifecycleDestroyer;
  postMessage(message: LifecycleWorkerOutbound): void;
}) {
  let destroyer: LifecycleDestroyer | undefined;
  let activeGeneration: RuntimeGeneration | undefined;
  let destroyOutcome: { ok: true } | { ok: false; message: string } | undefined;

  const respondToDestroy = (generation: RuntimeGeneration, token: string) => {
    if (destroyOutcome?.ok) {
      dependencies.postMessage({ type: "destroyed", generation, token });
    } else if (destroyOutcome?.ok === false) {
      dependencies.postMessage({
        type: "fatal",
        generation,
        token,
        message: destroyOutcome.message,
      });
    }
  };

  return {
    async handle(message: unknown): Promise<void> {
      if (!isLifecycleWorkerInbound(message)) {
        throw new Error("invalid lifecycle worker message");
      }
      if (message.type === "adopt") {
        if (destroyer !== undefined) {
          throw new Error("destroyer already adopted");
        }
        destroyer = dependencies.restoreDestroyer(message.handle);
        activeGeneration = message.generation;
        dependencies.postMessage({
          type: "adopted",
          generation: message.generation,
        });
        return;
      }
      if (destroyer === undefined || activeGeneration === undefined) {
        throw new Error("destroyer is not adopted");
      }
      if (message.generation !== activeGeneration) {
        throw new Error("lifecycle worker generation mismatch");
      }
      if (destroyOutcome === undefined) {
        try {
          destroyer.destroy();
          destroyOutcome = { ok: true };
        } catch (error) {
          destroyOutcome = { ok: false, message: toErrorMessage(error) };
        }
      }
      respondToDestroy(message.generation, message.token);
    },
  };
}

export interface RuntimeWorkerEndpoint extends EventTarget {
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface RuntimeWorkerHandshake {
  initialize(wasiRef: WASIFarmRefObject, ctx: Ctx): Promise<void>;
  dispose(): Promise<void>;
}

export function createRuntimeWorkerFactory(options: {
  utilityWorkerUrl: string;
  lifecycleWorkerUrl: string;
  createWorker?: (url: string) => RuntimeWorkerEndpoint;
  onFatalError?: (generation: RuntimeGeneration, error: Error) => void;
}) {
  const createWorker =
    options.createWorker ??
    ((url: string) => new Worker(url, { type: "module" }));
  return {
    create(generation: RuntimeGeneration): RuntimeWorkerHandshake {
      return createRuntimeWorkerHandshake({
        generation,
        utilityWorker: createWorker(options.utilityWorkerUrl),
        lifecycleWorker: createWorker(options.lifecycleWorkerUrl),
        onFatalError: (error) => options.onFatalError?.(generation, error),
      });
    },
  };
}

function eventError(event: Event): Error {
  if (event instanceof ErrorEvent && event.message) {
    return new Error(event.message);
  }
  return new Error(`${event.type} from runtime worker`);
}

export function createRuntimeWorkerHandshake(options: {
  generation: RuntimeGeneration;
  utilityWorker: RuntimeWorkerEndpoint;
  lifecycleWorker: RuntimeWorkerEndpoint;
  createToken?: () => string;
  onFatalError?: (error: Error) => void;
}): RuntimeWorkerHandshake {
  let initialized = false;
  let destroyerReceived = false;
  let adopted = false;
  let ready = false;
  let disposeRequested = false;
  let prerequisiteCancellationRequested = false;
  let destroyToken: string | undefined;
  let terminal = false;
  let failure: Error | undefined;
  let fatalReported = false;
  let adoptionFailure: Error | undefined;
  let resolveStartup!: () => void;
  let rejectStartup!: (reason: unknown) => void;
  let resolveDisposal!: () => void;
  let rejectDisposal!: (reason: unknown) => void;
  const startup = new Promise<void>((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  const disposal = new Promise<void>((resolve, reject) => {
    resolveDisposal = resolve;
    rejectDisposal = reject;
  });
  void startup.catch(() => undefined);
  void disposal.catch(() => undefined);

  const terminate = () => {
    if (terminal) return;
    terminal = true;
    options.utilityWorker.removeEventListener("message", onUtilityMessage);
    options.utilityWorker.removeEventListener("error", onUtilityBoundary);
    options.utilityWorker.removeEventListener(
      "messageerror",
      onUtilityBoundary,
    );
    options.lifecycleWorker.removeEventListener("message", onLifecycleMessage);
    options.lifecycleWorker.removeEventListener("error", onLifecycleBoundary);
    options.lifecycleWorker.removeEventListener(
      "messageerror",
      onLifecycleBoundary,
    );
    options.utilityWorker.terminate();
    options.lifecycleWorker.terminate();
  };

  const completeDisposal = () => {
    terminate();
    if (failure) {
      rejectDisposal(failure);
    } else {
      if (!ready) {
        rejectStartup(new Error("runtime worker disposed before ready"));
      }
      resolveDisposal();
    }
  };

  const captureFailure = (error: Error) => {
    const firstFailure = failure === undefined;
    failure ??= error;
    if (firstFailure && ready && !disposeRequested && !fatalReported) {
      fatalReported = true;
      try {
        options.onFatalError?.(failure);
      } catch {
        // Consumer reporting cannot interrupt worker ownership teardown.
      }
    }
    return failure;
  };

  const failImmediately = (error: Error) => {
    if (terminal) return;
    captureFailure(error);
    rejectStartup(failure);
    terminate();
    rejectDisposal(failure);
  };

  const requestDestroy = () => {
    if (!disposeRequested || !adopted || destroyToken !== undefined || terminal)
      return;
    destroyToken = options.createToken?.() ?? crypto.randomUUID();
    options.lifecycleWorker.postMessage({
      type: "destroy",
      generation: options.generation,
      token: destroyToken,
    } satisfies LifecycleWorkerInbound);
  };

  const cancelBeforeDestroyer = () => {
    if (
      !disposeRequested ||
      destroyerReceived ||
      prerequisiteCancellationRequested ||
      terminal
    )
      return;
    prerequisiteCancellationRequested = true;
    options.utilityWorker.postMessage({
      type: "cancel-before-destroyer",
      generation: options.generation,
    } satisfies UtilityWorkerInbound);
  };

  const beginFailureDisposal = (error: Error) => {
    captureFailure(error);
    rejectStartup(failure);
    disposeRequested = true;
    if (!destroyerReceived) {
      failImmediately(failure);
      return;
    }
    requestDestroy();
  };

  function onUtilityMessage(event: Event) {
    const message = (event as MessageEvent).data;
    if (!isUtilityWorkerOutbound(message)) {
      failImmediately(new Error("invalid utility worker message"));
      return;
    }
    if (message.type === "control-fatal") {
      beginFailureDisposal(new Error(message.message));
      return;
    }
    if (message.generation !== options.generation || terminal) return;
    if (message.type === "cancelled-before-destroyer") {
      if (!disposeRequested || destroyerReceived) {
        failImmediately(
          new Error("utility worker cancelled construction out of order"),
        );
        return;
      }
      completeDisposal();
      return;
    }
    if (message.type === "fatal") {
      const error = new Error(message.message);
      if (adoptionFailure) {
        failure ??= adoptionFailure;
        rejectStartup(failure);
        terminate();
        rejectDisposal(failure);
        return;
      }
      if (disposeRequested && failure === undefined) {
        rejectStartup(error);
        if (adopted) return;
        terminate();
        resolveDisposal();
        return;
      }
      beginFailureDisposal(error);
      return;
    }
    if (message.type === "destroyer") {
      if (destroyerReceived) {
        beginFailureDisposal(
          new Error("utility worker sent duplicate destroyer"),
        );
        return;
      }
      destroyerReceived = true;
      options.lifecycleWorker.postMessage({
        type: "adopt",
        generation: options.generation,
        handle: message.handle,
      } satisfies LifecycleWorkerInbound);
      return;
    }
    if (disposeRequested) return;
    if (!adopted || ready) {
      beginFailureDisposal(
        new Error("utility worker became ready out of order"),
      );
      return;
    }
    ready = true;
    resolveStartup();
  }

  function onLifecycleMessage(event: Event) {
    const message = (event as MessageEvent).data;
    if (!isLifecycleWorkerOutbound(message)) {
      failImmediately(new Error("invalid lifecycle worker message"));
      return;
    }
    if (message.generation !== options.generation || terminal) return;
    if (message.type === "adopted") {
      if (!destroyerReceived || adopted) {
        failImmediately(
          new Error("lifecycle worker adopted destroyer out of order"),
        );
        return;
      }
      adopted = true;
      if (disposeRequested) requestDestroy();
      else {
        options.utilityWorker.postMessage({
          type: "destroyer-adopted",
          generation: options.generation,
        } satisfies UtilityWorkerInbound);
      }
      return;
    }
    if (message.type === "fatal" && message.token === undefined) {
      if (ready) {
        beginFailureDisposal(new Error(message.message));
        return;
      }
      adoptionFailure = new Error(message.message);
      rejectStartup(adoptionFailure);
      options.utilityWorker.postMessage({
        type: "destroyer-adoption-failed",
        generation: options.generation,
        message: message.message,
      } satisfies UtilityWorkerInbound);
      return;
    }
    if (message.token !== destroyToken) return;
    if (message.type === "fatal") {
      failure ??= new Error(message.message);
    }
    completeDisposal();
  }

  function onUtilityBoundary(event: Event) {
    event.preventDefault();
    if (adoptionFailure) {
      failImmediately(adoptionFailure);
      return;
    }
    beginFailureDisposal(eventError(event));
  }

  function onLifecycleBoundary(event: Event) {
    event.preventDefault();
    failImmediately(eventError(event));
  }

  options.utilityWorker.addEventListener("message", onUtilityMessage);
  options.utilityWorker.addEventListener("error", onUtilityBoundary);
  options.utilityWorker.addEventListener("messageerror", onUtilityBoundary);
  options.lifecycleWorker.addEventListener("message", onLifecycleMessage);
  options.lifecycleWorker.addEventListener("error", onLifecycleBoundary);
  options.lifecycleWorker.addEventListener("messageerror", onLifecycleBoundary);

  return {
    initialize(wasiRef, ctx) {
      if (initialized) {
        return Promise.reject(new Error("runtime worker already initialized"));
      }
      if (terminal || disposeRequested) {
        return Promise.reject(new Error("runtime worker is disposed"));
      }
      initialized = true;
      options.utilityWorker.postMessage({
        type: "initialize",
        generation: options.generation,
        wasiRef,
        ctx,
      } satisfies UtilityWorkerInbound);
      return startup;
    },
    dispose() {
      if (terminal) return disposal;
      if (!disposeRequested) {
        disposeRequested = true;
        if (!initialized) completeDisposal();
        else if (destroyerReceived) requestDestroy();
        else cancelBeforeDestroyer();
      }
      return disposal;
    },
  };
}
