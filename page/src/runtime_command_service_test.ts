import type { Ctx } from "./ctx.ts";
import { compile_and_run, download } from "./compile_and_run.ts";
import {
  RuntimeCommandService,
  RuntimeParserService,
  type RuntimeSharedObjectFactories,
} from "./runtime_command_service.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualValue = JSON.stringify(actual);
  const expectedValue = JSON.stringify(expected);
  if (actualValue !== expectedValue) {
    throw new Error(
      `${message}: expected ${expectedValue}, got ${actualValue}`,
    );
  }
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("operation did not reject");
}

type WaiterMethods = {
  is_all_done(): boolean;
  is_cmd_run_end(): boolean;
  set_end_of_exec(value: boolean): void;
};

type Endpoint = (...args: never[]) => unknown;

class FakeChannel {
  closes = 0;
  readonly bc = {
    close: () => {
      this.closes++;
      if (this.closeError !== undefined) throw this.closeError;
    },
  };

  constructor(private readonly closeError?: unknown) {}
}

class FakeRef extends FakeChannel {
  proxyCalls = 0;

  constructor(
    readonly id: string,
    private readonly endpoint: Endpoint,
    private readonly proxyError?: unknown,
    private readonly onProxy?: () => void,
    closeError?: unknown,
  ) {
    super(closeError);
  }

  proxy<T>(): T {
    this.proxyCalls++;
    this.onProxy?.();
    if (this.proxyError !== undefined) throw this.proxyError;
    return this.endpoint as T;
  }
}

class FakeSharedObject extends FakeChannel {
  constructor(
    readonly value: unknown,
    readonly id: string,
    closeError?: unknown,
  ) {
    super(closeError);
  }
}

class FakeGenerationSignal {
  aborted = false;
  reason: unknown;
  readonly abortListeners = new Set<EventListenerOrEventListenerObject>();

  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type === "abort") this.abortListeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type === "abort") this.abortListeners.delete(listener);
  }

  abort(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.abortListeners]) {
      if (!this.abortListeners.has(listener)) continue;
      if (typeof listener === "function") {
        listener.call(this, new Event("abort"));
      } else {
        listener.handleEvent(new Event("abort"));
      }
    }
    this.abortListeners.clear();
  }
}

function ctx(generation: string): Ctx {
  return {
    waiter_id: `${generation}-waiter`,
    terminal_id: `${generation}-terminal`,
    input_string_id: `${generation}-input`,
  } as Ctx;
}

function channels(endpoints: Map<string, Endpoint>) {
  const objects: FakeSharedObject[] = [];
  const refs: FakeRef[] = [];
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject(value, id) {
      const object = new FakeSharedObject(value, id);
      objects.push(object);
      return object;
    },
    createSharedObjectRef(id) {
      const endpoint = endpoints.get(id);
      if (!endpoint) throw new Error(`missing endpoint ${id}`);
      const ref = new FakeRef(id, endpoint);
      refs.push(ref);
      return ref;
    },
  };
  return { factories, objects, refs };
}

function commandEndpoints(
  generation: string,
  commands: string[],
  terminal: Uint8Array[],
  isReady: () => boolean = () => true,
) {
  return new Map<string, Endpoint>([
    [`${generation}-waiter`, (() => undefined) as Endpoint],
    [
      `${generation}-terminal`,
      (({ data }: { data: Uint8Array }) => {
        terminal.push(data);
        return Promise.resolve();
      }) as Endpoint,
    ],
    [
      `${generation}-input`,
      (({ data }: { data: string }) => {
        commands.push(data);
        return Promise.resolve();
      }) as Endpoint,
    ],
  ]).set(
    `${generation}-waiter`,
    ({ is_all_done: () => Promise.resolve(isReady()) } as unknown) as Endpoint,
  );
}

Deno.test("parser generations own synchronous cloneable waiter state", async () => {
  const firstChannels = channels(new Map());
  const secondChannels = channels(new Map());
  const first = new RuntimeParserService(
    ctx("first"),
    new AbortController().signal,
    firstChannels.factories,
  );
  const second = new RuntimeParserService(
    ctx("second"),
    new AbortController().signal,
    secondChannels.factories,
  );
  const firstMethods = firstChannels.objects[0].value as WaiterMethods;
  const secondMethods = secondChannels.objects[0].value as WaiterMethods;

  assertEquals(firstChannels.objects[0].id, "first-waiter", "first waiter id");
  assertEquals(
    secondChannels.objects[0].id,
    "second-waiter",
    "second waiter id",
  );
  assertEquals(firstMethods.is_all_done(), false, "first initial readiness");
  assertEquals(secondMethods.is_all_done(), false, "second initial readiness");
  const synchronousResult: unknown = firstMethods.is_all_done();
  assert(!(synchronousResult instanceof Promise), "waiter became async");
  firstMethods.set_end_of_exec(false);
  assertEquals(firstMethods.is_cmd_run_end(), false, "first execution flag");
  assertEquals(secondMethods.is_cmd_run_end(), true, "shared execution flag");
  assertEquals(
    structuredClone(firstMethods.is_cmd_run_end()),
    false,
    "waiter result is not cloneable",
  );
  assertEquals(
    structuredClone(firstMethods.set_end_of_exec(true)),
    undefined,
    "waiter setter result is not cloneable",
  );
  assertEquals(firstMethods.is_cmd_run_end(), true, "execution flag update");

  await first.ready;
  assertEquals(firstMethods.is_all_done(), true, "first ready completion");
  await second.ready;
  assertEquals(secondMethods.is_all_done(), true, "second ready completion");
});

Deno.test("command generations retain distinct ids and proxy instances", async () => {
  const firstCommands: string[] = [];
  const secondCommands: string[] = [];
  const firstChannels = channels(
    commandEndpoints("first", firstCommands, []),
  );
  const secondChannels = channels(
    commandEndpoints("second", secondCommands, []),
  );
  const first = new RuntimeCommandService(
    ctx("first"),
    new AbortController().signal,
    firstChannels.factories,
  );
  const second = new RuntimeCommandService(
    ctx("second"),
    new AbortController().signal,
    secondChannels.factories,
  );

  assertEquals(
    firstChannels.refs.map(({ id }) => id),
    ["first-waiter", "first-terminal", "first-input"],
    "first proxy ids",
  );
  assertEquals(
    secondChannels.refs.map(({ id }) => id),
    ["second-waiter", "second-terminal", "second-input"],
    "second proxy ids",
  );
  assert(
    firstChannels.refs.every((ref) => ref.proxyCalls === 1),
    "first generation did not retain one proxy per ref",
  );
  await first.run();
  await second.run("wasm32-wasip1");
  assertEquals(firstCommands, ["cargo run\r"], "first command");
  assertEquals(
    secondCommands,
    ["cargo run --target wasm32-wasip1\r"],
    "second command",
  );
});

Deno.test("run preserves not-ready output and caches waiter readiness", async () => {
  let ready = false;
  let waiterCalls = 0;
  const commands: string[] = [];
  const terminal: Uint8Array[] = [];
  const endpoints = commandEndpoints(
    "readiness",
    commands,
    terminal,
    () => {
      waiterCalls++;
      return ready;
    },
  );
  const fake = channels(endpoints);
  const service = new RuntimeCommandService(
    ctx("readiness"),
    new AbortController().signal,
    fake.factories,
  );

  await service.run();
  assertEquals(commands, [], "command ran before readiness");
  assertEquals(
    new TextDecoder().decode(terminal[0]),
    "this is not done yet\r\n",
    "not-ready terminal output",
  );
  ready = true;
  await service.run();
  await service.run();
  assertEquals(commands, ["cargo run\r", "cargo run\r"], "ready commands");
  assertEquals(waiterCalls, 2, "ready waiter was not cached");
});

Deno.test("run and download preserve exact command text and carriage return", async () => {
  const commands: string[] = [];
  const fake = channels(commandEndpoints("exact", commands, []));
  const service = new RuntimeCommandService(
    ctx("exact"),
    new AbortController().signal,
    fake.factories,
  );

  await service.run();
  await service.run("x86_64-unknown-linux-musl");
  await service.download("/target/wasm32-wasip1/debug/main.wasm");

  assertEquals(
    commands,
    [
      "cargo run\r",
      "cargo run --target x86_64-unknown-linux-musl\r",
      "download /target/wasm32-wasip1/debug/main.wasm\r",
    ],
    "exact command stream",
  );
});

Deno.test("legacy command names are stateless explicit-service adapters", async () => {
  const calls: string[] = [];
  const service = {
    run: (triple?: string) => {
      calls.push(`run:${triple}`);
      return Promise.resolve();
    },
    download: (file: string) => {
      calls.push(`download:${file}`);
      return Promise.resolve();
    },
  };

  await compile_and_run(service, "wasm32-wasip1");
  await download(service, "/target/main.wasm");

  assertEquals(
    calls,
    ["run:wasm32-wasip1", "download:/target/main.wasm"],
    "explicit command adapters",
  );
});

Deno.test("generation abort rejects a pending command with the exact reason", async () => {
  const generation = new AbortController();
  const reason = { generation: "replaced" };
  const commands: string[] = [];
  const endpoints = commandEndpoints("abort", commands, []);
  endpoints.set(
    "abort-input",
    (() => new Promise<void>(() => {})) as Endpoint,
  );
  const fake = channels(endpoints);
  const service = new RuntimeCommandService(
    ctx("abort"),
    generation.signal,
    fake.factories,
  );
  const pending = service.run();
  void pending.catch(() => undefined);

  generation.abort(reason);

  assert(
    (await rejection(pending)) === reason,
    "abort reason identity changed",
  );
  assert(
    (await rejection(service.run())) === reason,
    "future call lost abort reason",
  );
});

Deno.test("stale disposal rejects in-flight work and cannot affect a newer service", async () => {
  let rejectOld!: (reason: unknown) => void;
  const oldCommands: string[] = [];
  const oldEndpoints = commandEndpoints("old", oldCommands, []);
  oldEndpoints.set(
    "old-input",
    (() =>
      new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      })) as Endpoint,
  );
  const oldChannels = channels(oldEndpoints);
  const nextCommands: string[] = [];
  const nextChannels = channels(commandEndpoints("next", nextCommands, []));
  const oldService = new RuntimeCommandService(
    ctx("old"),
    new AbortController().signal,
    oldChannels.factories,
  );
  const nextService = new RuntimeCommandService(
    ctx("next"),
    new AbortController().signal,
    nextChannels.factories,
  );
  const pending = oldService.run();
  void pending.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert(rejectOld !== undefined, "old input command did not start");

  oldService.dispose();
  const disposedError = await rejection(pending);
  assert(
    disposedError instanceof Error &&
      disposedError.message === "runtime command service is disposed",
    "in-flight disposal reason changed",
  );
  rejectOld(new Error("late old-generation proxy rejection"));
  await Promise.resolve();
  await nextService.run();

  assertEquals(
    nextCommands,
    ["cargo run\r"],
    "stale dispose reached new service",
  );
  assert(
    nextChannels.refs.every((ref) => ref.closes === 0),
    "stale dispose closed a new channel",
  );
});

Deno.test("partial command setup failure closes every acquired ref", () => {
  const setupError = new Error("input proxy setup failed");
  const refs: FakeRef[] = [];
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject() {
      throw new Error("unexpected SharedObject");
    },
    createSharedObjectRef(id) {
      const ref = new FakeRef(
        id,
        (() => Promise.resolve()) as Endpoint,
        id.endsWith("-input") ? setupError : undefined,
      );
      refs.push(ref);
      return ref;
    },
  };

  let caught: unknown;
  try {
    new RuntimeCommandService(
      ctx("partial"),
      new AbortController().signal,
      factories,
    );
  } catch (error) {
    caught = error;
  }

  assert(caught === setupError, "setup failure identity changed");
  assertEquals(
    refs.map(({ id, closes }) => ({ id, closes })),
    [
      { id: "partial-waiter", closes: 1 },
      { id: "partial-terminal", closes: 1 },
      { id: "partial-input", closes: 1 },
    ],
    "partial setup cleanup",
  );
});

Deno.test("repeated disposal closes every owned channel exactly once", async () => {
  const parserChannels = channels(new Map());
  const commandChannels = channels(commandEndpoints("dispose", [], []));
  const parser = new RuntimeParserService(
    ctx("parser-dispose"),
    new AbortController().signal,
    parserChannels.factories,
  );
  void parser.ready.catch(() => undefined);
  const command = new RuntimeCommandService(
    ctx("dispose"),
    new AbortController().signal,
    commandChannels.factories,
  );

  parser.dispose();
  parser.dispose();
  command.dispose();
  command.dispose();

  assertEquals(parserChannels.objects[0].closes, 1, "parser close count");
  assert(
    commandChannels.refs.every((ref) => ref.closes === 1),
    "command channel was not closed exactly once",
  );
  const futureError = await rejection(command.download("late"));
  assert(
    futureError instanceof Error &&
      futureError.message === "runtime command service is disposed",
    "future disposal reason changed",
  );
});

Deno.test("disposal releases generation abort listeners", () => {
  const generation = new FakeGenerationSignal();
  const signal = generation as unknown as AbortSignal;
  const parserChannels = channels(new Map());
  const commandChannels = channels(commandEndpoints("listeners", [], []));
  const parser = new RuntimeParserService(
    ctx("parser-listeners"),
    signal,
    parserChannels.factories,
  );
  const command = new RuntimeCommandService(
    ctx("listeners"),
    signal,
    commandChannels.factories,
  );
  assertEquals(generation.abortListeners.size, 2, "generation listener count");

  parser.dispose();
  command.dispose();
  parser.dispose();
  command.dispose();

  assertEquals(
    generation.abortListeners.size,
    0,
    "disposed generation listeners",
  );
});

Deno.test("settled proxy operations release their abort race listeners", async () => {
  const NativeAbortController = globalThis.AbortController;
  const activeListeners: Array<() => number> = [];
  class TrackingAbortController {
    readonly inner = new NativeAbortController();
    readonly signal = this.inner.signal;

    constructor() {
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const add = this.signal.addEventListener.bind(this.signal);
      const remove = this.signal.removeEventListener.bind(this.signal);
      this.signal.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions | boolean,
      ) => {
        if (type === "abort") listeners.add(listener);
        add(type, listener, options);
      }) as typeof this.signal.addEventListener;
      this.signal.removeEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: EventListenerOptions | boolean,
      ) => {
        if (type === "abort") listeners.delete(listener);
        remove(type, listener, options);
      }) as typeof this.signal.removeEventListener;
      activeListeners.push(() => listeners.size);
    }

    abort(reason?: unknown): void {
      this.inner.abort(reason);
    }
  }

  globalThis.AbortController =
    TrackingAbortController as unknown as typeof AbortController;
  try {
    const fake = channels(commandEndpoints("race-listeners", [], []));
    const service = new RuntimeCommandService(
      ctx("race-listeners"),
      new NativeAbortController().signal,
      fake.factories,
    );
    await service.run();
    await service.download("/target/main.wasm");

    assertEquals(activeListeners.length, 1, "internal controller count");
    assertEquals(activeListeners[0](), 0, "settled abort race listeners");
    service.dispose();
  } finally {
    globalThis.AbortController = NativeAbortController;
  }
});

Deno.test("parser rolls back a waiter acquired during reentrant generation abort", () => {
  const generation = new FakeGenerationSignal();
  const reason = { parser: "replaced" };
  let waiter: FakeSharedObject | undefined;
  let methods: WaiterMethods | undefined;
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject(value, id) {
      methods = value as WaiterMethods;
      waiter = new FakeSharedObject(value, id);
      generation.abort(reason);
      return waiter;
    },
    createSharedObjectRef() {
      throw new Error("unexpected ref factory");
    },
  };

  let caught: unknown;
  try {
    new RuntimeParserService(
      ctx("parser-reentrant-abort"),
      generation as unknown as AbortSignal,
      factories,
    );
  } catch (error) {
    caught = error;
  }

  assert(caught === reason, "parser abort reason identity changed");
  assertEquals(waiter?.closes, 1, "aborted parser waiter close count");
  assertEquals(generation.abortListeners.size, 0, "parser abort relay cleanup");
  let callbackError: unknown;
  try {
    methods?.is_all_done();
  } catch (error) {
    callbackError = error;
  }
  assert(callbackError === reason, "aborted parser callback remained active");
});

Deno.test("parser factory failure removes its relay and preserves the factory error", () => {
  const generation = new FakeGenerationSignal();
  const factoryError = new Error("parser factory failed");
  let listenersDuringFactory = 0;
  const factories: RuntimeSharedObjectFactories = {
    createSharedObject() {
      listenersDuringFactory = generation.abortListeners.size;
      throw factoryError;
    },
    createSharedObjectRef() {
      throw new Error("unexpected ref factory");
    },
  };

  let caught: unknown;
  try {
    new RuntimeParserService(
      ctx("parser-factory-failure"),
      generation as unknown as AbortSignal,
      factories,
    );
  } catch (error) {
    caught = error;
  }

  assert(caught === factoryError, "parser factory error identity changed");
  assertEquals(listenersDuringFactory, 1, "parser relay installation order");
  assertEquals(
    generation.abortListeners.size,
    0,
    "failed parser relay cleanup",
  );
});

Deno.test("parser abort wins over throwing waiter cleanup and observes the cleanup error", () => {
  const generation = new FakeGenerationSignal();
  const reason = new Error("parser generation replaced");
  const closeError = new Error("parser waiter close failed");
  let waiter: FakeSharedObject | undefined;
  const observed: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => observed.push(args);
  try {
    const factories: RuntimeSharedObjectFactories = {
      createSharedObject(value, id) {
        waiter = new FakeSharedObject(value, id, closeError);
        generation.abort(reason);
        return waiter;
      },
      createSharedObjectRef() {
        throw new Error("unexpected ref factory");
      },
    };

    let caught: unknown;
    try {
      new RuntimeParserService(
        ctx("parser-close-failure"),
        generation as unknown as AbortSignal,
        factories,
      );
    } catch (error) {
      caught = error;
    }

    assert(caught === reason, "parser cleanup replaced abort reason");
    assertEquals(waiter?.closes, 1, "throwing parser waiter close count");
    assertEquals(
      generation.abortListeners.size,
      0,
      "throwing parser relay cleanup",
    );
    assertEquals(observed.length, 1, "parser cleanup observation count");
    assert(observed[0][0] === closeError, "parser cleanup error changed");
  } finally {
    console.error = originalConsoleError;
  }
});

for (
  const boundary of [
    "waiter-factory",
    "waiter-proxy",
    "terminal-factory",
    "terminal-proxy",
    "input-factory",
    "input-proxy",
  ] as const
) {
  Deno.test(`command constructor rolls back a ${boundary} failure`, () => {
    const setupError = new Error(`${boundary} failed`);
    const refs: FakeRef[] = [];
    const calls: string[] = [];
    const endpoints = commandEndpoints("setup-boundary", [], []);
    const factories: RuntimeSharedObjectFactories = {
      createSharedObject() {
        throw new Error("unexpected SharedObject factory");
      },
      createSharedObjectRef(id) {
        const name = id.split("-").at(-1)!;
        calls.push(`${name}-factory`);
        if (boundary === `${name}-factory`) throw setupError;
        const ref = new FakeRef(
          id,
          endpoints.get(id)!,
          boundary === `${name}-proxy` ? setupError : undefined,
          () => calls.push(`${name}-proxy`),
        );
        refs.push(ref);
        return ref;
      },
    };

    let caught: unknown;
    try {
      new RuntimeCommandService(
        ctx("setup-boundary"),
        new AbortController().signal,
        factories,
      );
    } catch (error) {
      caught = error;
    }

    assert(caught === setupError, `${boundary} error identity changed`);
    assert(
      refs.every((ref) => ref.closes === 1),
      `${boundary} did not close every acquired ref once`,
    );
    assertEquals(
      calls.at(-1),
      boundary,
      `${boundary} continued constructor acquisition`,
    );
  });
}

for (
  const boundary of [
    "waiter-factory",
    "waiter-proxy",
    "terminal-factory",
    "terminal-proxy",
    "input-factory",
    "input-proxy",
  ] as const
) {
  Deno.test(`command constructor stops at reentrant abort from ${boundary}`, () => {
    const generation = new FakeGenerationSignal();
    const reason = { boundary };
    const laterError = new Error(`${boundary} later error`);
    const refs: FakeRef[] = [];
    const calls: string[] = [];
    const endpoints = commandEndpoints("abort-boundary", [], []);
    const factories: RuntimeSharedObjectFactories = {
      createSharedObject() {
        throw new Error("unexpected SharedObject factory");
      },
      createSharedObjectRef(id) {
        const name = id.split("-").at(-1)!;
        calls.push(`${name}-factory`);
        const ref = new FakeRef(
          id,
          endpoints.get(id)!,
          boundary === `${name}-proxy` ? laterError : undefined,
          () => {
            calls.push(`${name}-proxy`);
            if (boundary === `${name}-proxy`) generation.abort(reason);
          },
        );
        refs.push(ref);
        if (boundary === `${name}-factory`) generation.abort(reason);
        return ref;
      },
    };

    let caught: unknown;
    try {
      new RuntimeCommandService(
        ctx("abort-boundary"),
        generation as unknown as AbortSignal,
        factories,
      );
    } catch (error) {
      caught = error;
    }

    assert(caught === reason, `${boundary} abort reason identity changed`);
    assert(
      refs.every((ref) => ref.closes === 1),
      `${boundary} abort did not close every acquired ref once`,
    );
    assertEquals(
      calls.at(-1),
      boundary,
      `${boundary} abort continued constructor acquisition`,
    );
    assertEquals(
      generation.abortListeners.size,
      0,
      `${boundary} relay cleanup`,
    );
  });
}

for (const outcome of ["setup", "abort"] as const) {
  Deno.test(`command ${outcome} error wins over aggregated rollback failures`, () => {
    const generation = new FakeGenerationSignal();
    const primary = new Error(`${outcome} primary`);
    const closeErrors = [0, 1, 2].map((index) =>
      new Error(`${outcome} close ${index}`)
    );
    const refs: FakeRef[] = [];
    const observed: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => observed.push(args);
    try {
      const endpoints = commandEndpoints("rollback-errors", [], []);
      const factories: RuntimeSharedObjectFactories = {
        createSharedObject() {
          throw new Error("unexpected SharedObject factory");
        },
        createSharedObjectRef(id) {
          const index = refs.length;
          const isInput = id.endsWith("-input");
          const ref = new FakeRef(
            id,
            endpoints.get(id)!,
            isInput && outcome === "setup" ? primary : undefined,
            isInput && outcome === "abort"
              ? () => generation.abort(primary)
              : undefined,
            closeErrors[index],
          );
          refs.push(ref);
          return ref;
        },
      };

      let caught: unknown;
      try {
        new RuntimeCommandService(
          ctx("rollback-errors"),
          generation as unknown as AbortSignal,
          factories,
        );
      } catch (error) {
        caught = error;
      }

      assert(caught === primary, `${outcome} primary error changed`);
      assert(
        refs.every((ref) => ref.closes === 1),
        `${outcome} rollback skipped a throwing close`,
      );
      assertEquals(observed.length, 1, `${outcome} cleanup observation count`);
      const aggregate = observed[0][0];
      assert(
        aggregate instanceof AggregateError,
        `${outcome} cleanup not aggregated`,
      );
      assertEquals(
        aggregate.errors,
        closeErrors,
        `${outcome} cleanup aggregate errors`,
      );
    } finally {
      console.error = originalConsoleError;
    }
  });
}

Deno.test("synchronous proxy throws reject and reentrant abort reason wins", async () => {
  for (const boundary of ["waiter", "send"] as const) {
    const generation = new FakeGenerationSignal();
    const reason = { operation: boundary };
    const laterError = new Error(`${boundary} invocation failed`);
    const endpoints = commandEndpoints("sync-operation", [], []);
    if (boundary === "waiter") {
      endpoints.set(
        "sync-operation-waiter",
        ({
          is_all_done: () => {
            generation.abort(reason);
            throw laterError;
          },
        } as unknown) as Endpoint,
      );
    } else {
      endpoints.set(
        "sync-operation-input",
        (() => {
          generation.abort(reason);
          throw laterError;
        }) as Endpoint,
      );
    }
    const fake = channels(endpoints);
    const service = new RuntimeCommandService(
      ctx("sync-operation"),
      generation as unknown as AbortSignal,
      fake.factories,
    );

    const pending = boundary === "waiter"
      ? service.run()
      : service.download("x");
    assert(
      pending instanceof Promise,
      `${boundary} throw escaped Promise contract`,
    );
    assert(
      (await rejection(pending)) === reason,
      `${boundary} reentrant abort lost exact reason`,
    );
  }

  const syncError = new Error("plain synchronous send failure");
  const endpoints = commandEndpoints("plain-sync", [], []);
  endpoints.set(
    "plain-sync-input",
    (() => {
      throw syncError;
    }) as Endpoint,
  );
  const fake = channels(endpoints);
  const service = new RuntimeCommandService(
    ctx("plain-sync"),
    new AbortController().signal,
    fake.factories,
  );
  const pending = service.download("x");
  assert(
    pending instanceof Promise,
    "plain synchronous throw escaped Promise contract",
  );
  assert(
    (await rejection(pending)) === syncError,
    "plain synchronous error changed",
  );
});

Deno.test("dispose during cached-ready send rejects and observes late success", async () => {
  let service!: RuntimeCommandService;
  let inputCalls = 0;
  let resolveLate!: () => void;
  let waiterCalls = 0;
  const endpoints = commandEndpoints(
    "cached-dispose",
    [],
    [],
    () => {
      waiterCalls++;
      return true;
    },
  );
  endpoints.set(
    "cached-dispose-input",
    (() => {
      inputCalls++;
      if (inputCalls === 1) return Promise.resolve();
      const late = new Promise<void>((resolve) => (resolveLate = resolve));
      service.dispose();
      return late;
    }) as Endpoint,
  );
  const fake = channels(endpoints);
  service = new RuntimeCommandService(
    ctx("cached-dispose"),
    new AbortController().signal,
    fake.factories,
  );
  await service.run();

  const pending = service.run();
  const error = await rejection(pending);
  assert(
    error instanceof Error &&
      error.message === "runtime command service is disposed",
    "cached-ready disposal reason changed",
  );
  resolveLate();
  await Promise.resolve();
  assertEquals(waiterCalls, 1, "cached-ready run rechecked waiter");
  assert(
    fake.refs.every((ref) => ref.closes === 1),
    "cached dispose close count",
  );
});

Deno.test("late proxy success cannot replace generation abort", async () => {
  const generation = new AbortController();
  const reason = { generation: "late-success" };
  let resolveLate!: () => void;
  const endpoints = commandEndpoints("late-success", [], []);
  endpoints.set(
    "late-success-input",
    (() => new Promise<void>((resolve) => (resolveLate = resolve))) as Endpoint,
  );
  const fake = channels(endpoints);
  const service = new RuntimeCommandService(
    ctx("late-success"),
    generation.signal,
    fake.factories,
  );
  const pending = service.download("x");
  void pending.catch(() => undefined);

  generation.abort(reason);
  assert(
    (await rejection(pending)) === reason,
    "late success changed abort reason",
  );
  resolveLate();
  await Promise.resolve();
});

Deno.test("download explicitly bypasses waiter readiness", async () => {
  let waiterCalls = 0;
  const commands: string[] = [];
  const endpoints = commandEndpoints("download-bypass", commands, [], () => {
    waiterCalls++;
    throw new Error("download must not query readiness");
  });
  const fake = channels(endpoints);
  const service = new RuntimeCommandService(
    ctx("download-bypass"),
    new AbortController().signal,
    fake.factories,
  );

  await service.download("file with spaces.wasm");

  assertEquals(waiterCalls, 0, "download queried waiter readiness");
  assertEquals(
    commands,
    ["download file with spaces.wasm\r"],
    "download command behavior changed",
  );
});
