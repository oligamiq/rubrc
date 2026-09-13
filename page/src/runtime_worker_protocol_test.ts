import {
  createLifecycleWorkerStateMachine,
  createRuntimeWorkerFactory,
  createRuntimeWorkerHandshake,
  createUtilityWorkerMessageHandler,
  createUtilityWorkerStateMachine,
  isLifecycleWorkerInbound,
  isLifecycleWorkerOutbound,
  isUtilityWorkerInbound,
  isUtilityWorkerOutbound,
  type RuntimeWorkerEndpoint,
  UtilityWorkerStartupError,
} from "./runtime_worker_protocol.ts";
import type { DestroyerHandleObject } from "@oligami/browser_wasi_shim-threads";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";
import { File, OpenFile } from "@bjorn3/browser_wasi_shim";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "values differ",
) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function assertRejects(
  operation: () => Promise<unknown> | unknown,
  includes: string,
) {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(includes),
      `expected "${message}" to include "${includes}"`,
    );
    return;
  }
  throw new Error(`expected rejection containing "${includes}"`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const generation = "runtime-1";
const ctx = { terminal_id: "terminal" } as never;
const wasiRef = { stdin: 0 } as never;
// State-machine unit tests treat the library-owned payload as opaque.
const destroyerHandle = {
  fixture: "destroyer",
} as unknown as DestroyerHandleObject;

Deno.test("runtime worker protocol accepts only strict canonical envelopes", () => {
  assert(
    isUtilityWorkerInbound({ type: "initialize", generation, wasiRef, ctx }),
  );
  assert(isUtilityWorkerInbound({ type: "destroyer-adopted", generation }));
  assert(
    isUtilityWorkerInbound({ type: "cancel-before-destroyer", generation }),
  );
  assert(
    isUtilityWorkerInbound({
      type: "destroyer-adoption-failed",
      generation,
      message: "adoption failed",
    }),
  );
  assert(
    !isUtilityWorkerInbound({
      type: "initialize",
      generation,
      wasiRef,
      ctx,
      extra: true,
    }),
  );
  assert(!isUtilityWorkerInbound({ type: "destroyer-adopted", generation: 1 }));
  assert(
    !isUtilityWorkerInbound({
      type: "cancel-before-destroyer",
      generation,
      extra: true,
    }),
  );
  assert(
    !isUtilityWorkerInbound({
      type: "destroyer-adoption-failed",
      generation,
    }),
  );

  assert(
    isUtilityWorkerOutbound({
      type: "destroyer",
      generation,
      handle: destroyerHandle,
    }),
  );
  assert(isUtilityWorkerOutbound({ type: "ready", generation }));
  assert(isUtilityWorkerOutbound({ type: "control-fatal", message: "failed" }));
  assert(
    isUtilityWorkerOutbound({
      type: "cancelled-before-destroyer",
      generation,
    }),
  );
  assert(
    isUtilityWorkerOutbound({ type: "fatal", generation, message: "failed" }),
  );
  assert(
    !isUtilityWorkerOutbound({
      type: "fatal",
      generation,
      message: "failed",
      token: "x",
    }),
  );
  assert(
    !isUtilityWorkerOutbound({
      type: "control-fatal",
      generation,
      message: "failed",
    }),
  );

  assert(
    isLifecycleWorkerInbound({
      type: "adopt",
      generation,
      handle: destroyerHandle,
    }),
  );
  assert(
    isLifecycleWorkerInbound({
      type: "destroy",
      generation,
      token: "destroy-1",
    }),
  );
  assert(!isLifecycleWorkerInbound({ type: "destroy", generation, token: "" }));

  assert(isLifecycleWorkerOutbound({ type: "adopted", generation }));
  assert(
    isLifecycleWorkerOutbound({
      type: "destroyed",
      generation,
      token: "destroy-1",
    }),
  );
  assert(
    isLifecycleWorkerOutbound({
      type: "fatal",
      generation,
      token: "destroy-1",
      message: "failed",
    }),
  );
  assert(
    !isLifecycleWorkerOutbound({
      type: "destroyed",
      generation,
      token: "destroy-1",
      extra: true,
    }),
  );
});

Deno.test("utility worker publishes destroyer and awaits adoption before guest setup", async () => {
  const events: string[] = [];
  const outbound: unknown[] = [];
  const animal = {
    create_destroyer() {
      return { get_object: () => destroyerHandle };
    },
    start(_root: unknown) {},
    async async_destroy() {
      events.push("animal-destroyed");
    },
  };
  const machine = createUtilityWorkerStateMachine({
    createAnimal() {
      events.push("animal-created");
      return animal;
    },
    postMessage(message) {
      outbound.push(message);
      if ((message as { type?: string }).type === "destroyer") {
        events.push("destroyer-posted");
      }
      if ((message as { type?: string }).type === "ready") events.push("ready");
    },
    async startGuest(ownedAnimal) {
      events.push("vfs-fetch-started");
      events.push("vfs-instantiated");
      ownedAnimal.start({});
    },
    onAdopted() {
      events.push("lifecycle-adopted");
    },
  });

  const starting = machine.handle({
    type: "initialize",
    generation,
    wasiRef,
    ctx,
  });
  await Promise.resolve();
  assertEquals(events, ["animal-created", "destroyer-posted"]);

  await machine.handle({ type: "destroyer-adopted", generation });
  await starting;
  assertEquals(events, [
    "animal-created",
    "destroyer-posted",
    "lifecycle-adopted",
    "vfs-fetch-started",
    "vfs-instantiated",
    "ready",
  ]);
  assertEquals(
    outbound.map((message) => (message as { type: string }).type),
    ["destroyer", "ready"],
  );
});

Deno.test("utility worker prepares the construction module before creating the Animal", async () => {
  const events: string[] = [];
  const prerequisite = deferred<WebAssembly.Module>();
  const destroyerPosted = deferred<void>();
  const module = new WebAssembly.Module(
    new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  const machine = createUtilityWorkerStateMachine({
    async prepareAnimal(_message, signal) {
      events.push("prerequisite-fetch");
      assert(!signal.aborted, "prerequisite signal started aborted");
      return await prerequisite.promise;
    },
    createAnimal(_message, constructionModule) {
      assert(constructionModule === module, "wrong construction module");
      events.push("animal-created-with-real-module");
      return {
        create_destroyer: () => ({ get_object: () => destroyerHandle }),
        start(_root: unknown) {},
        async async_destroy() {
          events.push("animal-destroyed");
        },
      };
    },
    postMessage(message) {
      events.push(message.type);
      if (message.type === "destroyer") destroyerPosted.resolve();
    },
    async startGuest() {
      events.push("remaining-vfs-assets");
    },
  });

  const starting = machine.handle({
    type: "initialize",
    generation,
    wasiRef,
    ctx,
  });
  await Promise.resolve();
  assertEquals(events, ["prerequisite-fetch"]);

  prerequisite.resolve(module);
  await destroyerPosted.promise;
  assertEquals(events, [
    "prerequisite-fetch",
    "animal-created-with-real-module",
    "destroyer",
  ]);

  await machine.handle({ type: "destroyer-adopted", generation });
  await starting;
  assertEquals(events, [
    "prerequisite-fetch",
    "animal-created-with-real-module",
    "destroyer",
    "remaining-vfs-assets",
    "ready",
  ]);
});

Deno.test("utility cancellation during prerequisite fetch creates and destroys no Animal", async () => {
  let createCalls = 0;
  let destroyCalls = 0;
  const outbound: Array<{ type: string; message?: string }> = [];
  const machine = createUtilityWorkerStateMachine({
    prepareAnimal(_message, signal) {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    createAnimal() {
      createCalls++;
      return {
        create_destroyer: () => ({ get_object: () => destroyerHandle }),
        start(_root: unknown) {},
        async async_destroy() {
          destroyCalls++;
        },
      };
    },
    postMessage: (message) => outbound.push(message),
    async startGuest() {},
  });

  const starting = machine.handle({
    type: "initialize",
    generation,
    wasiRef,
    ctx,
  });
  void starting.catch(() => undefined);
  await Promise.resolve();
  const cancelling = machine.handle({
    type: "cancel-before-destroyer",
    generation,
  });
  assertEquals(outbound, [
    {
      type: "cancelled-before-destroyer",
      generation,
    },
  ]);
  await cancelling;
  await assertRejects(() => starting, "disposed before Animal construction");

  assertEquals(createCalls, 0);
  assertEquals(destroyCalls, 0);
  assertEquals(outbound, [
    { type: "cancelled-before-destroyer", generation },
    {
      type: "fatal",
      generation,
      message: "disposed before Animal construction",
    },
  ]);
});

Deno.test("utility prerequisite failure creates and destroys no Animal", async () => {
  let createCalls = 0;
  let destroyCalls = 0;
  const outbound: Array<{ type: string; message?: string }> = [];
  const machine = createUtilityWorkerStateMachine({
    prepareAnimal() {
      throw new Error("thread module fetch failed");
    },
    createAnimal() {
      createCalls++;
      return {
        create_destroyer: () => ({ get_object: () => destroyerHandle }),
        start(_root: unknown) {},
        async async_destroy() {
          destroyCalls++;
        },
      };
    },
    postMessage: (message) => outbound.push(message),
    async startGuest() {},
  });

  await assertRejects(
    () => machine.handle({ type: "initialize", generation, wasiRef, ctx }),
    "thread module fetch failed",
  );
  assertEquals(createCalls, 0);
  assertEquals(destroyCalls, 0);
  assertEquals(outbound, [
    {
      type: "fatal",
      generation,
      message: "thread module fetch failed",
    },
  ]);
});

Deno.test("utility worker rejects duplicate initialize and mismatched adoption", async () => {
  let animals = 0;
  const machine = createUtilityWorkerStateMachine({
    createAnimal() {
      animals++;
      return {
        create_destroyer: () => ({ get_object: () => destroyerHandle }),
        start(_root: unknown) {},
        async async_destroy() {},
      };
    },
    postMessage() {},
    async startGuest() {},
  });

  const starting = machine.handle({
    type: "initialize",
    generation,
    wasiRef,
    ctx,
  });
  await assertRejects(
    () => machine.handle({ type: "initialize", generation, wasiRef, ctx }),
    "already initialized",
  );
  await assertRejects(
    () => machine.handle({ type: "destroyer-adopted", generation: "stale" }),
    "generation",
  );
  await machine.handle({ type: "destroyer-adopted", generation });
  await starting;
  await assertRejects(
    () => machine.handle({ type: "destroyer-adopted", generation }),
    "already adopted",
  );
  assertEquals(animals, 1);
});

Deno.test("utility worker message handler reports one strict control failure", async () => {
  const outbound: unknown[] = [];
  const calls: unknown[] = [];
  const handleMessage = createUtilityWorkerMessageHandler({
    machine: {
      handle(message) {
        calls.push(message);
        if (
          isUtilityWorkerInbound(message) &&
          message.type === "destroyer-adoption-failed"
        ) {
          return Promise.reject(
            new UtilityWorkerStartupError(new Error(message.message)),
          );
        }
        return Promise.reject(new Error("invalid control message"));
      },
    },
    postMessage: (message) => outbound.push(message),
  });

  const invalid = { generation: "stale", invalid: true };
  const adoptionFailure = {
    type: "destroyer-adoption-failed",
    generation,
    message: "adoption failed",
  };
  await handleMessage(invalid);
  await handleMessage({ invalid: true });
  await handleMessage(adoptionFailure);
  assertEquals(calls, [invalid, adoptionFailure]);
  assertEquals(outbound, [
    {
      type: "control-fatal",
      message: "invalid control message",
    },
  ]);
});

Deno.test("utility worker leaves post-adoption startup cleanup to lifecycle owner", async () => {
  for (
    const stage of [
      "wait-background",
      "fetch",
      "instantiate",
      "start",
      "registration",
    ]
  ) {
    const outbound: Array<{ type: string; message?: string }> = [];
    let destroyCalls = 0;
    let startCalls = 0;
    let failureCleanupCalls = 0;
    const machine = createUtilityWorkerStateMachine({
      createAnimal() {
        return {
          create_destroyer: () => ({ get_object: () => destroyerHandle }),
          start(_root: unknown) {
            startCalls++;
          },
          async async_destroy() {
            destroyCalls++;
          },
        };
      },
      postMessage(message) {
        outbound.push(message);
      },
      async startGuest(animal) {
        if (stage === "start") animal.start({});
        throw new Error(`${stage} failed`);
      },
      onFailure() {
        failureCleanupCalls++;
      },
    });

    const starting = machine.handle({
      type: "initialize",
      generation,
      wasiRef,
      ctx,
    });
    await machine.handle({ type: "destroyer-adopted", generation });
    await assertRejects(() => starting, `${stage} failed`);
    assertEquals(destroyCalls, 0, `${stage} local destroy count`);
    assertEquals(startCalls, stage === "start" ? 1 : 0, `${stage} start count`);
    assertEquals(failureCleanupCalls, 1, `${stage} failure cleanup count`);
    assertEquals(
      outbound.filter((message) => message.type === "fatal").length,
      1,
    );
    assertEquals(
      outbound.find((message) => message.type === "fatal")?.message,
      `${stage} failed`,
    );
  }
});

Deno.test("utility worker destroys locally once when publication fails before adoption", async () => {
  let destroyCalls = 0;
  const outbound: string[] = [];
  const machine = createUtilityWorkerStateMachine({
    createAnimal() {
      return {
        create_destroyer: () => ({ get_object: () => destroyerHandle }),
        start(_root: unknown) {},
        async async_destroy() {
          destroyCalls++;
        },
      };
    },
    postMessage(message) {
      outbound.push(message.type);
      if (message.type === "destroyer") throw new Error("publish failed");
    },
    async startGuest() {},
  });

  await assertRejects(
    () => machine.handle({ type: "initialize", generation, wasiRef, ctx }),
    "publish failed",
  );
  assertEquals(destroyCalls, 1);
  assertEquals(outbound, ["destroyer", "fatal"]);
});

Deno.test("utility worker still destroys locally when its failure hook throws", async () => {
  let destroyCalls = 0;
  const outbound: Array<{ type: string; message?: string }> = [];
  const machine = createUtilityWorkerStateMachine({
    createAnimal() {
      return {
        create_destroyer: () => ({ get_object: () => destroyerHandle }),
        start(_root: unknown) {},
        async async_destroy() {
          destroyCalls++;
        },
      };
    },
    postMessage(message) {
      outbound.push(message);
      if (message.type === "destroyer") throw new Error("publish failed");
    },
    async startGuest() {},
    onFailure() {
      throw new Error("failure hook failed");
    },
  });

  await assertRejects(
    () => machine.handle({ type: "initialize", generation, wasiRef, ctx }),
    "failure hook failed",
  );
  assertEquals(destroyCalls, 1);
  assert(
    outbound.at(-1)?.message?.includes("publish failed") &&
      outbound.at(-1)?.message?.includes("failure hook failed"),
    `cleanup errors were not aggregated: ${outbound.at(-1)?.message}`,
  );
});

Deno.test("utility worker reports Animal construction failure before publication", async () => {
  const outbound: Array<{ type: string; message?: string }> = [];
  const machine = createUtilityWorkerStateMachine({
    createAnimal() {
      throw new Error("Animal construction failed");
    },
    postMessage: (message) => outbound.push(message),
    async startGuest() {},
  });

  await assertRejects(
    () => machine.handle({ type: "initialize", generation, wasiRef, ctx }),
    "Animal construction failed",
  );
  assertEquals(outbound, [
    {
      type: "fatal",
      generation,
      message: "Animal construction failed",
    },
  ]);
});

Deno.test("utility worker reclaims local ownership when lifecycle adoption fails", async () => {
  let destroyCalls = 0;
  const events: string[] = [];
  const outbound: Array<{ type: string; message?: string }> = [];
  const machine = createUtilityWorkerStateMachine({
    createAnimal() {
      return {
        create_destroyer: () => ({ get_object: () => destroyerHandle }),
        start(_root: unknown) {},
        async async_destroy() {
          destroyCalls++;
          events.push("animal-destroyed");
        },
      };
    },
    postMessage: (message) => {
      outbound.push(message);
      events.push(message.type);
    },
    async startGuest() {},
  });
  const starting = machine.handle({
    type: "initialize",
    generation,
    wasiRef,
    ctx,
  });

  await machine.handle({
    type: "destroyer-adoption-failed",
    generation,
    message: "adoption failed",
  });
  await assertRejects(() => starting, "adoption failed");
  assertEquals(destroyCalls, 1);
  assertEquals(
    outbound.map((message) => message.type),
    ["destroyer", "fatal"],
  );
  assertEquals(events, ["destroyer", "animal-destroyed", "fatal"]);
});

Deno.test("lifecycle state machine defers destroyed until async_destroy resolves (deferred success)", async () => {
  const outbound: unknown[] = [];
  const asyncDestroyDeferred = deferred<void>();
  const machine = createLifecycleWorkerStateMachine({
    restoreDestroyer: () => ({
      async_destroy: () => asyncDestroyDeferred.promise,
    }),
    postMessage: (message) => outbound.push(message),
  });
  await machine.handle({ type: "adopt", generation, handle: destroyerHandle });
  const handling = machine.handle({
    type: "destroy",
    generation,
    token: "tok-1",
  });
  await Promise.resolve();
  // destroyed must NOT be emitted yet — lifecycle waits for async_destroy
  assertEquals(outbound, [{ type: "adopted", generation }]);
  asyncDestroyDeferred.resolve();
  await handling;
  assertEquals(outbound, [
    { type: "adopted", generation },
    { type: "destroyed", generation, token: "tok-1" },
  ]);
});

Deno.test("lifecycle state machine correlates fatal with each duplicate token after deferred failure", async () => {
  const outbound: unknown[] = [];
  const asyncDestroyDeferred = deferred<void>();
  const machine = createLifecycleWorkerStateMachine({
    restoreDestroyer: () => ({
      async_destroy: () => asyncDestroyDeferred.promise,
    }),
    postMessage: (message) => outbound.push(message),
  });
  await machine.handle({ type: "adopt", generation, handle: destroyerHandle });
  const h1 = machine.handle({ type: "destroy", generation, token: "tok-1" });
  const h2 = machine.handle({ type: "destroy", generation, token: "tok-2" });
  await Promise.resolve();
  // nothing yet — both are waiting on the same async_destroy
  assertEquals(outbound, [{ type: "adopted", generation }]);
  asyncDestroyDeferred.reject(new Error("async destroy failed"));
  await h1.catch(() => {});
  await h2.catch(() => {});
  assertEquals(outbound.slice(1), [
    {
      type: "fatal",
      generation,
      token: "tok-1",
      message: "async destroy failed",
    },
    {
      type: "fatal",
      generation,
      token: "tok-2",
      message: "async destroy failed",
    },
  ]);
});

Deno.test("lifecycle state machine shares one in-flight outcome for duplicate destroy tokens", async () => {
  const outbound: unknown[] = [];
  let destroyCalls = 0;
  const asyncDestroyDeferred = deferred<void>();
  const machine = createLifecycleWorkerStateMachine({
    restoreDestroyer: () => ({
      async_destroy() {
        destroyCalls++;
        return asyncDestroyDeferred.promise;
      },
    }),
    postMessage: (message) => outbound.push(message),
  });
  await machine.handle({ type: "adopt", generation, handle: destroyerHandle });
  const h1 = machine.handle({ type: "destroy", generation, token: "tok-1" });
  const h2 = machine.handle({ type: "destroy", generation, token: "tok-2" });
  asyncDestroyDeferred.resolve();
  await h1;
  await h2;
  assertEquals(destroyCalls, 1, "async_destroy called more than once");
  assertEquals(outbound, [
    { type: "adopted", generation },
    { type: "destroyed", generation, token: "tok-1" },
    { type: "destroyed", generation, token: "tok-2" },
  ]);
});

Deno.test("utility worker pre-adoption rollback awaits async_destroy before emitting fatal", async () => {
  const asyncDestroyDeferred = deferred<void>();
  const events: string[] = [];
  const outbound: Array<{ type: string; message?: string }> = [];
  const machine = createUtilityWorkerStateMachine({
    createAnimal() {
      return {
        create_destroyer: () => ({ get_object: () => destroyerHandle }),
        start(_root: unknown) {},
        async_destroy() {
          events.push("async-destroy-called");
          return asyncDestroyDeferred.promise;
        },
      };
    },
    postMessage: (message) => {
      outbound.push(message);
      events.push(message.type);
    },
    async startGuest() {},
  });
  const starting = machine.handle({
    type: "initialize",
    generation,
    wasiRef,
    ctx,
  });
  void starting.catch(() => {});

  // Trigger adoption failure before async_destroy resolves
  const handling = machine.handle({
    type: "destroyer-adoption-failed",
    generation,
    message: "adoption failed",
  });
  await Promise.resolve();
  // fatal must NOT be emitted until async_destroy resolves
  assertEquals(outbound.map((m) => m.type), ["destroyer"]);
  asyncDestroyDeferred.resolve();
  await handling;
  await assertRejects(() => starting, "adoption failed");
  assertEquals(events, ["destroyer", "async-destroy-called", "fatal"]);
});

Deno.test("lifecycle state machine adopts once, rejects stale generations, and destroys once", async () => {
  const outbound: unknown[] = [];
  let restoreCalls = 0;
  let destroyCalls = 0;
  const machine = createLifecycleWorkerStateMachine({
    restoreDestroyer() {
      restoreCalls++;
      return {
        async_destroy: async () => {
          destroyCalls++;
        },
      };
    },
    postMessage(message) {
      outbound.push(message);
    },
  });

  await machine.handle({ type: "adopt", generation, handle: destroyerHandle });
  await assertRejects(
    () =>
      machine.handle({ type: "adopt", generation, handle: destroyerHandle }),
    "already adopted",
  );
  await assertRejects(
    () =>
      machine.handle({ type: "destroy", generation: "stale", token: "stale" }),
    "generation",
  );
  await machine.handle({ type: "destroy", generation, token: "destroy-1" });
  await machine.handle({ type: "destroy", generation, token: "destroy-2" });

  assertEquals(restoreCalls, 1);
  assertEquals(destroyCalls, 1);
  assertEquals(outbound, [
    { type: "adopted", generation },
    { type: "destroyed", generation, token: "destroy-1" },
    { type: "destroyed", generation, token: "destroy-2" },
  ]);
});

Deno.test("lifecycle state machine correlates destroy failures with each token", async () => {
  const outbound: unknown[] = [];
  let destroyCalls = 0;
  const machine = createLifecycleWorkerStateMachine({
    restoreDestroyer: () => ({
      async_destroy() {
        destroyCalls++;
        throw new Error("destroy failed");
      },
    }),
    postMessage: (message) => outbound.push(message),
  });
  await machine.handle({ type: "adopt", generation, handle: destroyerHandle });
  await machine.handle({ type: "destroy", generation, token: "destroy-1" });
  await machine.handle({ type: "destroy", generation, token: "destroy-2" });

  assertEquals(destroyCalls, 1);
  assertEquals(outbound.slice(1), [
    {
      type: "fatal",
      generation,
      token: "destroy-1",
      message: "destroy failed",
    },
    {
      type: "fatal",
      generation,
      token: "destroy-2",
      message: "destroy failed",
    },
  ]);
});

class FakeWorker extends EventTarget implements RuntimeWorkerEndpoint {
  readonly posted: unknown[] = [];
  terminateCalls = 0;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminateCalls++;
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  boundary(type: "error" | "messageerror", message: string): ErrorEvent {
    const event = new ErrorEvent(type, { message, cancelable: true });
    this.dispatchEvent(event);
    return event;
  }
}

function runtimeHandshake() {
  const utility = new FakeWorker();
  const lifecycle = new FakeWorker();
  let token = 0;
  const runtime = createRuntimeWorkerHandshake({
    generation,
    utilityWorker: utility,
    lifecycleWorker: lifecycle,
    createToken: () => `destroy-${++token}`,
  });
  return { runtime, utility, lifecycle };
}

async function readyRuntimeHandshake(onFatalError: (error: Error) => void) {
  const utility = new FakeWorker();
  const lifecycle = new FakeWorker();
  const runtime = createRuntimeWorkerHandshake({
    generation,
    utilityWorker: utility,
    lifecycleWorker: lifecycle,
    createToken: () => "post-ready-destroy",
    onFatalError,
  });
  const startup = runtime.initialize(wasiRef, ctx);
  utility.message({ type: "destroyer", generation, handle: destroyerHandle });
  lifecycle.message({ type: "adopted", generation });
  utility.message({ type: "ready", generation });
  await startup;
  return { runtime, utility, lifecycle };
}

for (const role of ["utility", "lifecycle"] as const) {
  for (const failureType of ["fatal", "error", "messageerror"] as const) {
    Deno.test(`runtime handshake reports one post-ready ${role} ${failureType}`, async () => {
      const fatals: Error[] = [];
      const { runtime, utility, lifecycle } = await readyRuntimeHandshake(
        (error) => fatals.push(error),
      );
      const worker = role === "utility" ? utility : lifecycle;
      if (failureType === "fatal") {
        worker.message({
          type: "fatal",
          generation: "stale-generation",
          message: "stale fatal",
        });
        assertEquals(fatals, []);
        worker.message({
          type: "fatal",
          generation,
          message: `${role} fatal after ready`,
        });
        worker.message({
          type: "fatal",
          generation,
          message: `${role} duplicate fatal`,
        });
      } else {
        worker.boundary(failureType, `${role} ${failureType} after ready`);
        worker.boundary(failureType, `${role} duplicate ${failureType}`);
      }

      assertEquals(fatals.length, 1);
      assert(
        fatals[0].message.includes(`${role} ${failureType}`),
        `post-ready ${role} ${failureType} error changed`,
      );

      if (utility.terminateCalls === 0) {
        const destroy = lifecycle.posted.at(-1) as { token: string };
        lifecycle.message({
          type: "destroyed",
          generation,
          token: destroy.token,
        });
      }
      await assertRejects(() => runtime.dispose(), `${role} ${failureType}`);
    });
  }
}

Deno.test("runtime worker factory creates a fresh pair lazily per generation", async () => {
  const workers: FakeWorker[] = [];
  const urls: string[] = [];
  const factory = createRuntimeWorkerFactory({
    utilityWorkerUrl: "utility.js",
    lifecycleWorkerUrl: "lifecycle.js",
    createWorker(url) {
      urls.push(url);
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });

  assertEquals(workers.length, 0);
  const first = factory.create("generation-1");
  assertEquals(urls, ["utility.js", "lifecycle.js"]);
  await first.dispose();
  const second = factory.create("generation-2");
  assertEquals(urls, [
    "utility.js",
    "lifecycle.js",
    "utility.js",
    "lifecycle.js",
  ]);
  await second.dispose();
  assertEquals(
    workers.map((worker) => worker.terminateCalls),
    [1, 1, 1, 1],
  );
});

Deno.test("runtime worker factory forwards the generation with post-ready fatal", async () => {
  const workers: FakeWorker[] = [];
  const fatals: Array<{ generation: string; error: Error }> = [];
  const factory = createRuntimeWorkerFactory({
    utilityWorkerUrl: "utility.js",
    lifecycleWorkerUrl: "lifecycle.js",
    createWorker() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onFatalError: (runtimeGeneration, error) => {
      fatals.push({ generation: runtimeGeneration, error });
    },
  });
  const runtime = factory.create("factory-generation");
  const startup = runtime.initialize(wasiRef, ctx);
  workers[0].message({
    type: "destroyer",
    generation: "factory-generation",
    handle: destroyerHandle,
  });
  workers[1].message({ type: "adopted", generation: "factory-generation" });
  workers[0].message({ type: "ready", generation: "factory-generation" });
  await startup;

  workers[0].message({
    type: "fatal",
    generation: "factory-generation",
    message: "factory fatal",
  });

  assertEquals(fatals.length, 1);
  assertEquals(fatals[0].generation, "factory-generation");
  assertEquals(fatals[0].error.message, "factory fatal");
  const destroy = workers[1].posted.at(-1) as { token: string };
  workers[1].message({
    type: "destroyed",
    generation: "factory-generation",
    token: destroy.token,
  });
  await assertRejects(() => runtime.dispose(), "factory fatal");
});

Deno.test("runtime handshake disposes deterministically before initialization", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  await runtime.dispose();
  await assertRejects(() => runtime.initialize(wasiRef, ctx), "disposed");
  assertEquals(utility.posted, []);
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
});

Deno.test("runtime handshake observes pre-publication fatal during clean disposal", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  const startup = runtime.initialize(wasiRef, ctx);
  void startup.catch(() => {});
  const disposing = runtime.dispose();
  assertEquals(utility.posted.at(-1), {
    type: "cancel-before-destroyer",
    generation,
  });
  utility.message({
    type: "fatal",
    generation,
    message: "Animal construction failed",
  });

  await disposing;
  await assertRejects(() => startup, "Animal construction failed");
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
});

Deno.test("runtime handshake terminates on confirmed pre-Animal cancellation", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  const startup = runtime.initialize(wasiRef, ctx);
  void startup.catch(() => {});
  const disposing = runtime.dispose();
  utility.message({ type: "cancelled-before-destroyer", generation });

  await disposing;
  await assertRejects(() => startup, "disposed before ready");
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
});

Deno.test("runtime handshake observes fatal between publication and adoption", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  const startup = runtime.initialize(wasiRef, ctx);
  void startup.catch(() => {});
  utility.message({ type: "destroyer", generation, handle: destroyerHandle });
  const disposing = runtime.dispose();
  utility.message({
    type: "fatal",
    generation,
    message: "publish crossing failed",
  });

  await disposing;
  await assertRejects(() => startup, "publish crossing failed");
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
});

Deno.test("runtime handshake queues disposal until destroyer handoff and adoption", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  const startup = runtime.initialize(wasiRef, ctx);
  void startup.catch(() => {});
  const disposing = runtime.dispose();
  assertEquals(utility.posted, [
    {
      type: "initialize",
      generation,
      wasiRef,
      ctx,
    },
    { type: "cancel-before-destroyer", generation },
  ]);
  assertEquals(utility.terminateCalls, 0);
  assertEquals(lifecycle.posted, []);

  utility.message({ type: "destroyer", generation, handle: destroyerHandle });
  assertEquals(lifecycle.posted, [
    {
      type: "adopt",
      generation,
      handle: destroyerHandle,
    },
  ]);
  lifecycle.message({ type: "adopted", generation });
  assertEquals(lifecycle.posted[1], {
    type: "destroy",
    generation,
    token: "destroy-1",
  });
  assertEquals(
    utility.posted.length,
    2,
    "disposed utility was allowed to start",
  );

  lifecycle.message({ type: "destroyed", generation, token: "destroy-1" });
  await disposing;
  await assertRejects(() => startup, "disposed");
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
});

Deno.test("runtime handshake keeps concurrent ready from turning disposal into failure", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  const startup = runtime.initialize(wasiRef, ctx);
  void startup.catch(() => {});
  utility.message({ type: "destroyer", generation, handle: destroyerHandle });
  lifecycle.message({ type: "adopted", generation });

  const disposing = runtime.dispose();
  utility.message({ type: "ready", generation });
  const destroy = lifecycle.posted.at(-1) as { token: string };
  lifecycle.message({ type: "destroyed", generation, token: destroy.token });

  await disposing;
  await assertRejects(() => startup, "disposed");
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
});

Deno.test("runtime handshake observes post-adoption fatal without failing clean disposal", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  const startup = runtime.initialize(wasiRef, ctx);
  void startup.catch(() => {});
  utility.message({ type: "destroyer", generation, handle: destroyerHandle });
  lifecycle.message({ type: "adopted", generation });

  const disposing = runtime.dispose();
  utility.message({ type: "fatal", generation, message: "guest interrupted" });
  const destroy = lifecycle.posted.at(-1) as { token: string };
  lifecycle.message({ type: "destroyed", generation, token: destroy.token });

  await disposing;
  await assertRejects(() => startup, "guest interrupted");
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
});

Deno.test("runtime handshake ignores stale generation and destroy-token messages", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  const startup = runtime.initialize(wasiRef, ctx);
  utility.message({
    type: "destroyer",
    generation: "stale",
    handle: destroyerHandle,
  });
  assertEquals(lifecycle.posted, []);
  utility.message({ type: "destroyer", generation, handle: destroyerHandle });
  lifecycle.message({ type: "adopted", generation });
  utility.message({ type: "ready", generation });
  await startup;

  const disposing = runtime.dispose();
  const destroy = lifecycle.posted.at(-1) as { token: string };
  lifecycle.message({ type: "destroyed", generation, token: "stale-token" });
  await Promise.resolve();
  assertEquals(utility.terminateCalls, 0);
  lifecycle.message({
    type: "destroyed",
    generation: "stale",
    token: destroy.token,
  });
  assertEquals(utility.terminateCalls, 0);
  lifecycle.message({ type: "destroyed", generation, token: destroy.token });
  await disposing;
  assertEquals(utility.terminateCalls, 1);
});

Deno.test("runtime handshake rejects startup on adoption-time lifecycle fatal", async () => {
  const { runtime, utility, lifecycle } = runtimeHandshake();
  const startup = runtime.initialize(wasiRef, ctx);
  utility.message({ type: "destroyer", generation, handle: destroyerHandle });
  lifecycle.message({ type: "fatal", generation, message: "adoption failed" });
  assertEquals(utility.posted.at(-1), {
    type: "destroyer-adoption-failed",
    generation,
    message: "adoption failed",
  });
  assertEquals(utility.terminateCalls, 0);
  utility.message({ type: "fatal", generation, message: "adoption failed" });

  await assertRejects(
    () => withTestTimeout(startup, "adoption startup", 50),
    "adoption failed",
  );
  await assertRejects(() => runtime.dispose(), "adoption failed");
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
});

Deno.test("runtime handshake handles worker error and messageerror boundaries once", async () => {
  for (const owner of ["utility", "lifecycle"] as const) {
    for (const boundary of ["error", "messageerror"] as const) {
      const { runtime, utility, lifecycle } = runtimeHandshake();
      const startup = runtime.initialize(wasiRef, ctx);
      const message = `${owner} ${boundary} failed`;
      const event = (owner === "utility" ? utility : lifecycle).boundary(
        boundary,
        message,
      );
      assert(event.defaultPrevented, `${owner} ${boundary} was not handled`);
      await assertRejects(() => startup, message);
      await assertRejects(() => runtime.dispose(), message);
      assertEquals(
        utility.terminateCalls,
        1,
        `${owner} ${boundary} utility terminate count`,
      );
      assertEquals(
        lifecycle.terminateCalls,
        1,
        `${owner} ${boundary} lifecycle terminate count`,
      );
    }
  }
});

function withTestTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, deadline]).finally(() =>
    clearTimeout(timeout)
  );
}

function waitForAtomicValue(
  view: Int32Array,
  index: number,
  expected: number,
  label: string,
): Promise<void> {
  let poll: ReturnType<typeof setInterval> | undefined;
  const observed = new Promise<void>((resolve) => {
    poll = setInterval(() => {
      if (Atomics.load(view, index) !== expected) return;
      resolve();
    }, 1);
  });
  return withTestTimeout(observed, label).finally(() => clearInterval(poll));
}

class TrackingWorker extends EventTarget implements RuntimeWorkerEndpoint {
  terminateCalls = 0;
  listenerCount = 0;

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.listenerCount++;
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.listenerCount--;
    super.removeEventListener(type, callback, options);
  }

  postMessage(_message: unknown): void {}

  terminate(): void {
    this.terminateCalls++;
  }
}

function trackingTimers() {
  let nextId = 0;
  const active = new Set<number>();
  return {
    active,
    set(_callback: () => void, _delay: number) {
      const id = ++nextId;
      active.add(id);
      return id;
    },
    clear(id: number) {
      active.delete(id);
    },
  };
}

Deno.test("runtime fixture pair terminates the first worker when the second constructor throws", async () => {
  const first = new TrackingWorker();
  const timers = trackingTimers();
  let constructors = 0;

  await assertRejects(
    () =>
      createReadyRuntimeWorkers({
        createWorker() {
          constructors++;
          if (constructors === 2) throw new Error("second constructor failed");
          return first;
        },
        timers,
      }),
    "second constructor failed",
  );

  assertEquals(first.terminateCalls, 1);
  assertEquals(first.listenerCount, 0);
  assertEquals(timers.active.size, 0);
});

Deno.test("runtime fixture pair cancels sibling readiness when one worker rejects", async () => {
  const utility = new TrackingWorker();
  const lifecycle = new TrackingWorker();
  const timers = trackingTimers();
  let constructors = 0;

  const creating = createReadyRuntimeWorkers({
    createWorker() {
      return constructors++ === 0 ? utility : lifecycle;
    },
    timers,
  });
  queueMicrotask(() => {
    lifecycle.dispatchEvent(
      new ErrorEvent("error", {
        message: "lifecycle bootstrap failed",
        cancelable: true,
      }),
    );
  });

  await assertRejects(() => creating, "lifecycle bootstrap failed");
  assertEquals(utility.terminateCalls, 1);
  assertEquals(lifecycle.terminateCalls, 1);
  assertEquals(utility.listenerCount, 0);
  assertEquals(lifecycle.listenerCount, 0);
  assertEquals(timers.active.size, 0);
});

Deno.test("background bootstrap rejection disposes its worker wait immediately", async () => {
  const background = new TrackingWorker();
  const timers = trackingTimers();
  const creating = createRealDestroyer({
    createWorker: () => background,
    timers,
  });
  queueMicrotask(() => {
    background.dispatchEvent(
      new ErrorEvent("error", {
        message: "background bootstrap failed",
        cancelable: true,
      }),
    );
  });

  await assertRejects(() => creating, "background bootstrap failed");
  assertEquals(background.terminateCalls, 1);
  assertEquals(background.listenerCount, 0);
  assertEquals(timers.active.size, 0);
});

Deno.test("worker message waits clean up after success and synchronous send failure", async () => {
  const successful = new TrackingWorker();
  const successfulTimers = trackingTimers();
  assertEquals(
    await nextWorkerMessageAfter(
      successful,
      () =>
        queueMicrotask(() => {
          successful.dispatchEvent(
            new MessageEvent("message", { data: "ready" }),
          );
        }),
      successfulTimers,
    ),
    "ready",
  );
  assertEquals(successful.listenerCount, 0);
  assertEquals(successfulTimers.active.size, 0);
  successful.dispatchEvent(new MessageEvent("message", { data: "late" }));
  successful.dispatchEvent(new MessageEvent("messageerror"));
  successful.dispatchEvent(new ErrorEvent("error", { message: "late" }));

  const failed = new TrackingWorker();
  const failedTimers = trackingTimers();
  await assertRejects(
    () =>
      nextWorkerMessageAfter(
        failed,
        () => {
          throw new Error("send failed");
        },
        failedTimers,
      ),
    "send failed",
  );
  assertEquals(failed.listenerCount, 0);
  assertEquals(failedTimers.active.size, 0);
});

type FixtureRole = "background" | "utility" | "lifecycle";
type TimerHandle = ReturnType<typeof setTimeout> | number;

interface WaitTimers {
  set(callback: () => void, delay: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

interface WorkerWait<T> {
  promise: Promise<T>;
  dispose(reason?: Error): void;
}

interface WorkerFactoryOptions {
  createWorker?: (role: FixtureRole) => RuntimeWorkerEndpoint;
  timers?: WaitTimers;
}

const defaultWaitTimers: WaitTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle),
};

function createFixtureWorker(role: FixtureRole): RuntimeWorkerEndpoint {
  const path = role === "background"
    ? "./worker_process/runtime_worker_test_background.ts"
    : role === "utility"
    ? "./worker_process/runtime_worker_test_utility.ts"
    : "./worker_process/runtime_worker_test_lifecycle.ts";
  return new Worker(new URL(path, import.meta.url).href, { type: "module" });
}

function createWorkerWait<T>(options: {
  worker: RuntimeWorkerEndpoint;
  label: string;
  timeoutMs: number;
  timers?: WaitTimers;
  read(event: MessageEvent): T;
}): WorkerWait<T> {
  const timers = options.timers ?? defaultWaitTimers;
  let settled = false;
  let timer: TimerHandle | undefined;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;

  const cleanup = () => {
    options.worker.removeEventListener("message", onMessage);
    options.worker.removeEventListener("error", onError);
    options.worker.removeEventListener("messageerror", onMessageError);
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  const resolve = (value: T) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  };
  const reject = (reason: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(reason);
  };
  function onMessage(event: Event) {
    if (settled) return;
    try {
      resolve(options.read(event as MessageEvent));
    } catch (error) {
      reject(error);
    }
  }
  function onError(event: Event) {
    event.preventDefault();
    const message = event instanceof ErrorEvent && event.message
      ? event.message
      : `${event.type} during ${options.label}`;
    reject(new Error(message));
  }
  function onMessageError(event: Event) {
    reject(new Error(`${event.type} during ${options.label}`));
  }

  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  options.worker.addEventListener("message", onMessage);
  options.worker.addEventListener("error", onError);
  options.worker.addEventListener("messageerror", onMessageError);
  timer = timers.set(
    () =>
      reject(
        new Error(`${options.label} timed out after ${options.timeoutMs}ms`),
      ),
    options.timeoutMs,
  );

  return {
    promise,
    dispose: (reason = new Error(`${options.label} disposed`)) =>
      reject(reason),
  };
}

function nextWorkerMessage(
  worker: RuntimeWorkerEndpoint,
  timers?: WaitTimers,
): WorkerWait<unknown> {
  return createWorkerWait({
    worker,
    label: "worker message",
    timeoutMs: 2_000,
    timers,
    read: (event) => event.data,
  });
}

async function nextWorkerMessageAfter(
  worker: RuntimeWorkerEndpoint,
  action: () => void,
  timers?: WaitTimers,
): Promise<unknown> {
  const wait = nextWorkerMessage(worker, timers);
  try {
    action();
    return await wait.promise;
  } finally {
    void wait.promise.catch(() => {});
    wait.dispose();
  }
}

function waitForFixtureReady(
  worker: RuntimeWorkerEndpoint,
  role: FixtureRole,
  timers?: WaitTimers,
): WorkerWait<void> {
  return createWorkerWait({
    worker,
    label: `${role} fixture bootstrap`,
    timeoutMs: 10_000,
    timers,
    read(event) {
      assertEquals(event.data, { type: "fixture-ready", worker: role });
    },
  });
}

interface OwnedWorker {
  worker: RuntimeWorkerEndpoint;
  dispose(): void;
}

async function createReadyWorker(
  role: "utility" | "lifecycle",
  options: WorkerFactoryOptions = {},
): Promise<OwnedWorker> {
  let worker: RuntimeWorkerEndpoint | undefined;
  try {
    worker = (options.createWorker ?? createFixtureWorker)(role);
    const ready = waitForFixtureReady(worker, role, options.timers);
    await ready.promise;
    let disposed = false;
    return {
      worker,
      dispose() {
        if (disposed) return;
        disposed = true;
        worker?.terminate();
      },
    };
  } catch (error) {
    worker?.terminate();
    throw error;
  }
}

function createReadyLifecycleWorker(
  options?: WorkerFactoryOptions,
): Promise<OwnedWorker> {
  return createReadyWorker("lifecycle", options);
}

function createReadyUtilityWorker(
  options?: WorkerFactoryOptions,
): Promise<OwnedWorker> {
  return createReadyWorker("utility", options);
}

interface OwnedRuntimeWorkers {
  utility: RuntimeWorkerEndpoint;
  lifecycle: RuntimeWorkerEndpoint;
  dispose(): void;
}

async function createReadyRuntimeWorkers(
  options: WorkerFactoryOptions = {},
): Promise<OwnedRuntimeWorkers> {
  const createWorker = options.createWorker ?? createFixtureWorker;
  let utility: RuntimeWorkerEndpoint | undefined;
  let lifecycle: RuntimeWorkerEndpoint | undefined;
  let utilityReady: WorkerWait<void> | undefined;
  let lifecycleReady: WorkerWait<void> | undefined;
  const dispose = () => {
    utilityReady?.dispose();
    lifecycleReady?.dispose();
    utilityReady = undefined;
    lifecycleReady = undefined;
    lifecycle?.terminate();
    utility?.terminate();
    lifecycle = undefined;
    utility = undefined;
  };

  try {
    utility = createWorker("utility");
    lifecycle = createWorker("lifecycle");
    utilityReady = waitForFixtureReady(utility, "utility", options.timers);
    lifecycleReady = waitForFixtureReady(
      lifecycle,
      "lifecycle",
      options.timers,
    );
    await Promise.all([utilityReady.promise, lifecycleReady.promise]);
    utilityReady = undefined;
    lifecycleReady = undefined;
    const ownedUtility = utility;
    const ownedLifecycle = lifecycle;
    return {
      utility: ownedUtility,
      lifecycle: ownedLifecycle,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

interface OwnedDestroyer {
  background: RuntimeWorkerEndpoint;
  handle: DestroyerHandleObject;
  complete(): Promise<void>;
  dispose(): Promise<void>;
}

async function createRealDestroyer(
  options: WorkerFactoryOptions = {},
): Promise<OwnedDestroyer> {
  let background: RuntimeWorkerEndpoint | undefined;
  const fd = () => new OpenFile(new File([]));
  const farm = new WASIFarm(fd(), fd(), fd());
  let handle: DestroyerHandleObject;
  try {
    background = (options.createWorker ?? createFixtureWorker)("background");
    const bootstrap = waitForFixtureReady(
      background,
      "background",
      options.timers,
    );
    await bootstrap.promise;
    const response = await nextWorkerMessageAfter(
      background,
      () =>
        background?.postMessage({
          type: "create",
          farmRef: farm.get_ref(),
        }),
      options.timers,
    ) as { handle?: DestroyerHandleObject };
    assert(
      response.handle,
      `owner did not supply a public handle: ${JSON.stringify(response)}`,
    );
    handle = response.handle;
  } catch (error) {
    background?.terminate();
    farm.destroy();
    throw error;
  }
  const ownedBackground = background;
  let disposed = false;
  let completion: Promise<void> | undefined;
  const complete = () =>
    completion ??= (async () => {
      assertEquals(
        await nextWorkerMessageAfter(
          ownedBackground,
          () => ownedBackground.postMessage({ type: "finish" }),
        ),
        { type: "finished" },
      );
    })();
  return {
    background: ownedBackground,
    handle,
    complete,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await complete();
      } finally {
        ownedBackground.terminate();
        farm.destroy();
      }
    },
  };
}

Deno.test("lifecycle worker transitions a live destroyer from owned to destroyed", async () => {
  const owned = await createRealDestroyer();
  try {
    const lifecycleOwner = await createReadyLifecycleWorker();
    try {
      const worker = lifecycleOwner.worker;
      assertEquals(
        await nextWorkerMessageAfter(worker, () =>
          worker.postMessage({
            type: "adopt",
            generation,
            handle: owned.handle,
          })),
        { type: "adopted", generation },
      );

      try {
        assertEquals(
          await nextWorkerMessageAfter(worker, () =>
            worker.postMessage({
              type: "destroy",
              generation,
              token: "destroy-real",
            })),
          {
            type: "destroyed",
            generation,
            token: "destroy-real",
          },
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : error}; status=${
            Atomics.load(
              new Int32Array(owned.handle.destroy_status),
              0,
            )
          }`,
        );
      }
      await owned.complete();
    } finally {
      lifecycleOwner.dispose();
    }
  } finally {
    await owned.dispose();
  }
});

Deno.test("owner fixture rejects unexpected commands without blocking later teardown", async () => {
  const owned = await createRealDestroyer();
  try {
    assertEquals(
      await nextWorkerMessageAfter(owned.background, () => {
        owned.background.postMessage({ type: "invalid" });
      }),
      {
        type: "fixture-error",
        message: "Error: invalid owner fixture command",
      },
    );
    await owned.complete();
  } finally {
    await owned.dispose();
  }
});

Deno.test("real disposal during prerequisite fetch creates no Animal", async () => {
  const owned = await createRealDestroyer();
  try {
    const countersBuffer = new SharedArrayBuffer(12);
    const counters = new Int32Array(countersBuffer);
    const prerequisiteBuffer = new SharedArrayBuffer(4);
    const prerequisite = new Int32Array(prerequisiteBuffer);
    const workers = await createReadyRuntimeWorkers();
    try {
      const runtime = createRuntimeWorkerHandshake({
        generation,
        utilityWorker: workers.utility,
        lifecycleWorker: workers.lifecycle,
      });
      const startup = runtime.initialize(
        {
          handle: owned.handle,
          countersBuffer,
          prerequisiteBuffer,
          blockPrerequisite: true,
        } as never,
        ctx,
      );
      void startup.catch(() => {});
      await waitForAtomicValue(prerequisite, 0, 1, "prerequisite fetch start");

      await withTestTimeout(runtime.dispose(), "prerequisite disposal");
      await assertRejects(
        () => withTestTimeout(startup, "prerequisite startup settlement"),
        "disposed before ready",
      );
      assertEquals(Array.from(counters), [0, 0, 0]);
    } finally {
      workers.dispose();
    }
  } finally {
    await owned.dispose();
  }
});

Deno.test("real utility and lifecycle workers complete one ownership handshake", async () => {
  const owned = await createRealDestroyer();
  try {
    const countersBuffer = new SharedArrayBuffer(12);
    const counters = new Int32Array(countersBuffer);
    const workers = await createReadyRuntimeWorkers();
    try {
      const runtime = createRuntimeWorkerHandshake({
        generation,
        utilityWorker: workers.utility,
        lifecycleWorker: workers.lifecycle,
        createToken: () => "destroy-workers",
      });
      await withTestTimeout(
        runtime.initialize(
          { handle: owned.handle, countersBuffer } as never,
          ctx,
        ),
        "two-worker startup",
      );
      assertEquals(Array.from(counters), [1, 1, 0]);
      await withTestTimeout(runtime.dispose(), "two-worker disposal");
      await owned.complete();
      assertEquals(Array.from(counters), [1, 1, 0]);
    } finally {
      workers.dispose();
    }
  } finally {
    await owned.dispose();
  }
});

Deno.test("real ownership handshakes remain clean across repeated generations", async () => {
  for (let round = 0; round < 3; round++) {
    const owned = await createRealDestroyer();
    try {
      const countersBuffer = new SharedArrayBuffer(12);
      const counters = new Int32Array(countersBuffer);
      const workers = await createReadyRuntimeWorkers();
      try {
        const workerErrors: string[] = [];
        const recordError = (event: Event) => {
          event.preventDefault();
          workerErrors.push(
            event instanceof ErrorEvent ? event.message : event.type,
          );
        };
        workers.utility.addEventListener("error", recordError);
        workers.lifecycle.addEventListener("error", recordError);
        owned.background.addEventListener("error", recordError);
        try {
          const runtime = createRuntimeWorkerHandshake({
            generation: `repeated-${round}`,
            utilityWorker: workers.utility,
            lifecycleWorker: workers.lifecycle,
            createToken: () => `destroy-repeated-${round}`,
          });

          await withTestTimeout(
            runtime.initialize(
              { handle: owned.handle, countersBuffer } as never,
              ctx,
            ),
            `repeated startup ${round}`,
          );
          await withTestTimeout(
            runtime.dispose(),
            `repeated disposal ${round}`,
          );
          assertEquals(Array.from(counters), [1, 1, 0]);
          await owned.complete();
          assertEquals(workerErrors, []);
        } finally {
          workers.utility.removeEventListener("error", recordError);
          workers.lifecycle.removeEventListener("error", recordError);
          owned.background.removeEventListener("error", recordError);
        }
      } finally {
        workers.dispose();
      }
    } finally {
      await owned.dispose();
    }
  }
});

Deno.test("real start failure cleans up only through lifecycle worker", async () => {
  const owned = await createRealDestroyer();
  try {
    const countersBuffer = new SharedArrayBuffer(12);
    const counters = new Int32Array(countersBuffer);
    const workers = await createReadyRuntimeWorkers();
    try {
      const runtime = createRuntimeWorkerHandshake({
        generation,
        utilityWorker: workers.utility,
        lifecycleWorker: workers.lifecycle,
        createToken: () => "destroy-start-failure",
      });
      const startup = runtime.initialize(
        { handle: owned.handle, countersBuffer, failStart: true } as never,
        ctx,
      );
      await assertRejects(() => startup, "start failed");
      await assertRejects(
        () => withTestTimeout(runtime.dispose(), "start-failure disposal"),
        "start failed",
      );
      await owned.complete();
      assertEquals(Array.from(counters), [1, 1, 0]);
    } finally {
      workers.dispose();
    }
  } finally {
    await owned.dispose();
  }
});

Deno.test("real adoption failure returns cleanup to utility worker", async () => {
  const countersBuffer = new SharedArrayBuffer(12);
  const counters = new Int32Array(countersBuffer);
  const workers = await createReadyRuntimeWorkers();
  try {
    const runtime = createRuntimeWorkerHandshake({
      generation,
      utilityWorker: workers.utility,
      lifecycleWorker: workers.lifecycle,
    });
    const startup = runtime.initialize(
      { handle: {}, countersBuffer } as never,
      ctx,
    );
    await assertRejects(() => startup, "allocator");
    await assertRejects(
      () => withTestTimeout(runtime.dispose(), "adoption-failure disposal"),
      "allocator",
    );
    assertEquals(Array.from(counters), [1, 0, 1]);
  } finally {
    workers.dispose();
  }
});

Deno.test("real runtime fixtures announce readiness before protocol traffic", async () => {
  const workers = await createReadyRuntimeWorkers();
  try {
    assert(workers.utility instanceof EventTarget);
    assert(workers.lifecycle instanceof EventTarget);
  } finally {
    workers.dispose();
  }
});

Deno.test("real utility worker reports duplicate initialize once without an uncaught error", async () => {
  const owned = await createReadyUtilityWorker();
  try {
    const worker = owned.worker;
    const initialize = {
      type: "initialize",
      generation,
      wasiRef: {
        handle: destroyerHandle,
        countersBuffer: new SharedArrayBuffer(12),
      },
      ctx,
    };
    const workerErrors: string[] = [];
    const recordError = (event: Event) => {
      event.preventDefault();
      workerErrors.push(
        event instanceof ErrorEvent ? event.message : event.type,
      );
    };
    worker.addEventListener("error", recordError);
    try {
      assertEquals(
        await nextWorkerMessageAfter(
          worker,
          () => worker.postMessage(initialize),
        ),
        {
          type: "destroyer",
          generation,
          handle: destroyerHandle,
        },
      );
      assertEquals(
        await nextWorkerMessageAfter(
          worker,
          () => worker.postMessage(initialize),
        ),
        {
          type: "control-fatal",
          message: "utility worker already initialized",
        },
      );
      assertEquals(workerErrors, []);
    } finally {
      worker.removeEventListener("error", recordError);
    }
  } finally {
    owned.dispose();
  }
});

Deno.test("lifecycle worker reports reconstruction failure as a fatal envelope", async () => {
  const owned = await createReadyLifecycleWorker();
  try {
    const worker = owned.worker;
    assertEquals(
      await nextWorkerMessageAfter(
        worker,
        () => worker.postMessage({ type: "adopt", generation, handle: {} }),
      ),
      {
        type: "fatal",
        generation,
        message: "Cannot read properties of undefined (reading 'allocator')",
      },
    );
  } finally {
    owned.dispose();
  }
});

async function sourceFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) files.push(...(await sourceFiles(url)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(url);
  }
  return files;
}

Deno.test("lifecycle completion uses public async destruction rather than private coordinator state", async () => {
  const source = await Deno.readTextFile(
    new URL("./runtime_worker_protocol.ts", import.meta.url),
  );
  assert(source.includes("destroyer!.async_destroy()"));
  assert(source.includes("await animal?.async_destroy()"));
  assert(!source.includes("worker_background_ref"));
});

Deno.test("runtime imports the utility worker directly and removes the forwarding layer", async () => {
  const src = new URL("./", import.meta.url);
  const index = await Deno.readTextFile(new URL("./index.tsx", src));
  const productionRuntime = await Deno.readTextFile(
    new URL("./production_runtime.ts", src),
  );
  assert(
    index.includes("./worker_process/util_cmd.ts?worker&url"),
    "direct utility worker URL missing",
  );
  assert(
    index.includes("./worker_process/lifecycle_worker.ts?worker&url"),
    "lifecycle worker URL missing",
  );
  assert(
    !index.includes("./worker_process/worker"),
    "outer forwarding worker is still selected",
  );
  assert(
    index.includes("createProductionRuntimeDependencies") &&
      productionRuntime.includes("createUtilityWorker: () =>") &&
      productionRuntime.includes("new Worker(options.utilityWorkerUrl") &&
      productionRuntime.includes("createLifecycleWorker: () =>") &&
      productionRuntime.includes("new Worker(options.lifecycleWorkerUrl"),
    "runtime worker ownership no longer creates workers per runtime generation",
  );

  const utility = await Deno.readTextFile(
    new URL("./worker_process/util_cmd.ts", src),
  );
  assert(
    utility.includes("createUtilityWorkerStateMachine"),
    "production utility does not use the tested state machine",
  );
  assert(
    utility.includes("createUtilityWorkerMessageHandler") &&
      !utility.includes("reportError"),
    "production utility lets protocol rejections escape the worker listener",
  );
  assert(
    !utility.includes("EMPTY_THREAD_SPAWN_MODULE") &&
      !utility.includes("installThreadSpawnModule") &&
      !utility.includes("thread_spawner") &&
      !utility.includes("worker_background_ref_object") &&
      !utility.includes("override_object"),
    "production utility still mutates and reinitializes the private coordinator",
  );
  assert(
    !utility.includes("destroyerAdopted"),
    "production utility retains a divergent adoption state machine",
  );
  const prerequisiteFetch = utility.indexOf(
    "async function prepareUtilityAnimal",
  );
  const prerequisiteModuleFetch = utility.indexOf("fetch(", prerequisiteFetch);
  const animalConstruction = utility.indexOf("new WASIFarmAnimal");
  const realConstructionModule = utility.indexOf(
    "thread_spawn_wasm: threadSpawnModule",
  );
  const deferredFetch = utility.indexOf("async function startUtilityGuest");
  const vfsInstantiated = utility.indexOf(
    "const vfs_root = await custom_instantiate",
  );
  const guestStarted = utility.indexOf("animal.start(vfs_root as any)");
  const handlersRegistered = utility.indexOf("shared.push(");
  assert(
    prerequisiteFetch >= 0 &&
      prerequisiteFetch < prerequisiteModuleFetch &&
      prerequisiteModuleFetch < animalConstruction &&
      animalConstruction < realConstructionModule &&
      realConstructionModule < deferredFetch &&
      deferredFetch < vfsInstantiated,
    "thread module is not prepared for construction before deferred VFS guest work",
  );
  assertEquals(
    utility.match(/thread_spawn_wasm:/g)?.length,
    1,
    "production initializes the coordinator more than once",
  );
  assert(
    vfsInstantiated < guestStarted && guestStarted < handlersRegistered,
    "VFS runtime start/registration order changed",
  );

  const backgroundFixture = await Deno.readTextFile(
    new URL("./worker_process/runtime_worker_test_background.ts", src),
  );
  assert(
    backgroundFixture.includes("await owner.async_destroy()") &&
      !backgroundFixture.includes("Atomics"),
    "owner fixture must use public destruction instead of recreating coordinator state",
  );
  assert(
    utility.includes('[`VFS_THREADS=${vfs_threads}`, "VFS_DEBUG_TRACE=1"]'),
    "pre-existing VFS debug environment changed",
  );
  assert(
    utility.indexOf("await vfs_ready({ ok: true })") > handlersRegistered &&
      !utility.includes("waitForRustSrcBootstrap"),
    "runtime readiness no longer follows start/session/all handlers",
  );

  for (const file of await sourceFiles(src)) {
    if (file.pathname.endsWith("runtime_worker_protocol_test.ts")) continue;
    const source = await Deno.readTextFile(file);
    assert(
      !source.includes("./worker_process/worker"),
      `${file.pathname} imports forwarding worker`,
    );
  }
  await assertRejects(
    () => Deno.stat(new URL("./worker_process/worker.ts", src)),
    "No such file",
  );
});
