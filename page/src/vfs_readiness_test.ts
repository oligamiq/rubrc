import {
  ADDITIONAL_SYSROOT_SESSION_ID,
  awaitStartupSysroots,
  createAdditionalSysrootStatusEndpoint,
  createStartupSysrootStatusEndpoint,
  nextVisibleTerminalSessionId,
  STARTUP_SYSROOT_TIMEOUT_MS,
  type StartupSysrootKind,
  type StartupSysrootStatus,
  waitForStartupSysroots,
} from "./vfs_readiness.ts";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const workerSourcePermission = await Deno.permissions.query({
  name: "read",
  path: new URL("./worker_process", import.meta.url),
});
const canReadWorkerSource = workerSourcePermission.state === "granted";

Deno.test("visible terminal sessions stop before hidden sysroot range", () => {
  const firstHiddenSessionId = ADDITIONAL_SYSROOT_SESSION_ID - 7;
  assert(
    nextVisibleTerminalSessionId(firstHiddenSessionId - 1) ===
      firstHiddenSessionId - 1,
    "last visible session id was rejected",
  );
  let error: unknown;
  try {
    nextVisibleTerminalSessionId(firstHiddenSessionId);
  } catch (caught) {
    error = caught;
  }
  assert(
    error instanceof Error && error.message === "session capacity exhausted",
    `reserved session id was accepted: ${error}`,
  );
});

const failedRoot = (kind: StartupSysrootKind, errorCode: number) => ({
  dispatch() {},
  startupSysrootLoadState(candidate: number) {
    return candidate === kind ? 3 : 2;
  },
  startupSysrootErrorCode(candidate: number) {
    return candidate === kind ? errorCode : 0;
  },
});

Deno.test("startup sysroot installation default timeout is 300 seconds", () => {
  assert(
    Number(STARTUP_SYSROOT_TIMEOUT_MS) === 300_000,
    `wrong default timeout: ${STARTUP_SYSROOT_TIMEOUT_MS}`,
  );
});

Deno.test("startup sysroot installation dispatches both events once", async () => {
  const calls: string[] = [];
  const result = await waitForStartupSysroots({
    dispatch(session, event, arg1, arg2) {
      calls.push(`${session}:${event}:${arg1}:${arg2}`);
    },
    startupSysrootLoadState: () => 2,
    startupSysrootErrorCode: () => 0,
  });

  assert(result.ok, "ready result failed");
  assert(
    calls.join(",") === "0:8:0:0,0:9:0:0",
    `startup events dispatched incorrectly: ${calls.join(",")}`,
  );
});

Deno.test("startup sysroot installation waits until both states are ready", async () => {
  const rustSrcStates = [2, 2, 2];
  const targetStates = [0, 1, 2];
  let sleeps = 0;
  const result = await waitForStartupSysroots(
    {
      dispatch() {},
      startupSysrootLoadState(kind) {
        const states = kind === 0 ? rustSrcStates : targetStates;
        return states.shift() ?? 2;
      },
      startupSysrootErrorCode: () => 0,
    },
    {
      sleep: async () => {
        sleeps++;
      },
    },
  );

  assert(result.ok, "ready result failed");
  assert(sleeps === 2, `settled before both states were ready: ${sleeps}`);
});

for (const [kind, errorCode, expected] of [
  [0, 1, "rust-src fetch failed before core installation"],
  [0, 2, "rust-src extraction failed"],
  [
    0,
    3,
    "rust-src extraction completed without /sysroot/lib/rustlib/src/rust/library/core/src/lib.rs",
  ],
  [1, 1, "wasm32-wasip1 fetch failed before target installation"],
  [1, 2, "wasm32-wasip1 extraction failed"],
  [1, 3, "wasm32-wasip1 extraction completed without a libcore-*.rlib"],
  [0, 4, "rust-src installation failed: invalid startup sysroot kind 0"],
  [1, 4, "wasm32-wasip1 installation failed: invalid startup sysroot kind 1"],
] as const) {
  Deno.test(`startup sysroot failure ${kind}:${errorCode} is specific`, async () => {
    const result = await waitForStartupSysroots(failedRoot(kind, errorCode));
    assert(
      "error" in result && result.error === expected,
      `wrong failure: ${JSON.stringify(result)}`,
    );
  });
}

Deno.test("startup sysroot installation rejects an invalid guest state", async () => {
  const result = await waitForStartupSysroots({
    dispatch() {},
    startupSysrootLoadState: (kind) => (kind === 0 ? 99 : 2),
    startupSysrootErrorCode: () => 0,
  });
  assert(
    "error" in result &&
      result.error === "rust-src installation returned invalid state 99",
    `invalid state accepted: ${JSON.stringify(result)}`,
  );
});

Deno.test("startup sysroot installation has one overall timeout", async () => {
  let now = 0;
  let dispatches = 0;
  let reads = 0;
  const result = await waitForStartupSysroots(
    {
      dispatch() {
        dispatches++;
      },
      startupSysrootLoadState(kind) {
        reads++;
        return kind === 0 ? 2 : 1;
      },
      startupSysrootErrorCode: () => 0,
    },
    {
      timeoutMs: 100,
      now: () => now,
      sleep: async () => {
        now += 25;
      },
    },
  );

  assert(
    "error" in result &&
      result.error ===
        "startup sysroot installation timed out after 100ms while rust-src=Ready, wasm32-wasip1=Loading",
    `wrong timeout result: ${JSON.stringify(result)}`,
  );
  const readsAtSettlement = reads;
  await Promise.resolve();
  assert(dispatches === 2, `startup dispatched ${dispatches} events`);
  assert(reads === readsAtSettlement, "waiter polled after timeout settlement");
});

class FakeSynchronousSharedObject<Args extends unknown[], Result> {
  constructor(private readonly callback: (...args: Args) => Result) {}

  call(...args: Args): Result {
    const result = this.callback(...args);
    structuredClone(result);
    return result;
  }
}

Deno.test("startup status endpoint synchronously starts once and exposes completion", async () => {
  let phase = 0;
  const dispatches: number[] = [];
  const endpoint = createStartupSysrootStatusEndpoint(
    {
      dispatch(_sessionId, eventType) {
        dispatches.push(eventType);
      },
      startupSysrootLoadState(kind) {
        if (phase === 0) return kind === 0 ? 2 : 1;
        return 2;
      },
      startupSysrootErrorCode: () => 0,
    },
    {
      sleep: async () => {
        phase++;
      },
    },
  );
  const sharedObject = new FakeSynchronousSharedObject(endpoint);

  const first = sharedObject.call();
  assert(
    !(first instanceof Promise),
    "SharedObject callback returned a Promise",
  );
  assert(first.state === "loading", `unexpected first status: ${first.state}`);
  assert(
    dispatches.join(",") === "8,9",
    `startup events were not dispatched exactly once: ${dispatches}`,
  );

  const second = sharedObject.call();
  assert(
    second.state === "loading",
    "second call restarted or completed early",
  );
  assert(dispatches.length === 2, "second call redispatched startup events");

  await Promise.resolve();
  await Promise.resolve();
  const complete = sharedObject.call();
  assert(complete.state === "complete", "completed result was not retained");
  assert(complete.state === "complete" && complete.result.ok, "wrong result");
  assert(dispatches.length === 2, "completed call redispatched startup events");
});

Deno.test("startup status endpoint retains a first-dispatch failure", async () => {
  const dispatches: number[] = [];
  let stateReads = 0;
  const endpoint = createStartupSysrootStatusEndpoint({
    dispatch(_sessionId, eventType) {
      dispatches.push(eventType);
      throw new Error("rust-src dispatch trapped");
    },
    startupSysrootLoadState() {
      stateReads++;
      return 1;
    },
    startupSysrootErrorCode: () => 0,
  });
  const sharedObject = new FakeSynchronousSharedObject(endpoint);

  const first = sharedObject.call();
  assert(
    first.state === "complete",
    "first dispatch failure escaped or wedged",
  );
  assert(
    first.state === "complete" &&
      "error" in first.result &&
      first.result.error.includes("rust-src dispatch trapped"),
    `wrong first dispatch failure: ${JSON.stringify(first)}`,
  );
  const later = sharedObject.call();
  assert(later === first, "first dispatch failure snapshot was not retained");
  assert(dispatches.join(",") === "8", `dispatch retried: ${dispatches}`);
  assert(stateReads === 0, "polling started after dispatch failure");
  await Promise.resolve();
});

Deno.test("startup status endpoint retains a second-dispatch failure without retry", async () => {
  const dispatches: number[] = [];
  let stateReads = 0;
  const endpoint = createStartupSysrootStatusEndpoint({
    dispatch(_sessionId, eventType) {
      dispatches.push(eventType);
      if (eventType === 9) throw new Error("target dispatch trapped");
    },
    startupSysrootLoadState() {
      stateReads++;
      return 1;
    },
    startupSysrootErrorCode: () => 0,
  });
  const sharedObject = new FakeSynchronousSharedObject(endpoint);

  const first = sharedObject.call();
  assert(
    first.state === "complete",
    "second dispatch failure escaped or wedged",
  );
  assert(
    first.state === "complete" &&
      "error" in first.result &&
      first.result.error.includes("target dispatch trapped"),
    `wrong second dispatch failure: ${JSON.stringify(first)}`,
  );
  const later = sharedObject.call();
  assert(later === first, "second dispatch failure snapshot was not retained");
  assert(dispatches.join(",") === "8,9", `dispatch retried: ${dispatches}`);
  assert(stateReads === 0, "polling started after dispatch failure");
  await Promise.resolve();
});

Deno.test("caller helper polls synchronous status proxy until complete", async () => {
  const statuses = [
    { state: "loading" } as const,
    { state: "complete", result: { ok: true } } as const,
  ];
  let sleeps = 0;
  const result = await awaitStartupSysroots(
    async () => statuses.shift() ?? statuses[0],
    {
      sleep: async () => {
        sleeps++;
      },
    },
  );

  assert(result.ok, "caller helper lost completion result");
  assert(sleeps === 1, `caller helper polled incorrectly: ${sleeps}`);
});

Deno.test("aborted startup installation settles its guest mutation before rejecting", async () => {
  const module = await import("./vfs_readiness.ts");
  const settle = (module as Record<string, unknown>)
    .awaitStartupSysrootsSettlement as
    | ((
        endpoint: () => Promise<
          { state: "loading" } | { state: "complete"; result: { ok: true } }
        >,
        signal: AbortSignal,
        timing: { sleep: () => Promise<void> },
      ) => Promise<{ ok: true }>)
    | undefined;
  assert(
    typeof settle === "function",
    "settling startup-installation helper is missing",
  );
  if (settle === undefined) return;

  const controller = new AbortController();
  const abortReason = new Error("generation disposed");
  let reads = 0;
  let mutationSettled = false;
  let releaseSleep!: () => void;
  const sleeping = new Promise<void>((resolve) => {
    releaseSleep = resolve;
  });
  const operation = settle(
    async () => {
      reads++;
      return mutationSettled
        ? { state: "complete", result: { ok: true } }
        : { state: "loading" };
    },
    controller.signal,
    { sleep: () => sleeping },
  );

  await Promise.resolve();
  controller.abort(abortReason);
  let rejected = false;
  void operation.catch(() => {
    rejected = true;
  });
  await Promise.resolve();
  assert(!rejected, "abort rejected before the guest mutation settled");

  mutationSettled = true;
  releaseSleep();
  const caught = await operation.then(
    () => undefined,
    (error) => error,
  );
  assert(caught === abortReason, "abort reason identity was replaced");
  assert(reads === 2, `stale generation read after settlement: ${reads}`);
});

Deno.test("aborted startup settlement preserves abort over late endpoint rejection", async () => {
  const { awaitStartupSysrootsSettlement } = await import("./vfs_readiness.ts");
  const controller = new AbortController();
  const pending = deferred<StartupSysrootStatus>();
  const operation = awaitStartupSysrootsSettlement(
    () => pending.promise,
    controller.signal,
  );
  const abortReason = new Error("generation disposed");
  controller.abort(abortReason);
  pending.reject(new Error("late channel rejection"));

  const caught = await operation.then(
    () => undefined,
    (error) => error,
  );
  assert(caught === abortReason, "late rejection replaced generation abort");
});

Deno.test("already-aborted startup settlement does not start guest installation", async () => {
  const { awaitStartupSysrootsSettlement } = await import("./vfs_readiness.ts");
  const controller = new AbortController();
  const abortReason = new Error("disposed before installation");
  controller.abort(abortReason);
  let calls = 0;
  const caught = await awaitStartupSysrootsSettlement(async () => {
    calls++;
    return { state: "loading" };
  }, controller.signal).then(
    () => undefined,
    (error) => error,
  );
  assert(caught === abortReason, "pre-start abort reason was replaced");
  assert(calls === 0, "aborted generation started guest installation");
});

Deno.test("startup status endpoint retains polling exceptions as cloneable failures", async () => {
  const endpoint = createStartupSysrootStatusEndpoint({
    dispatch() {},
    startupSysrootLoadState() {
      throw new Error("state read trapped");
    },
    startupSysrootErrorCode: () => 0,
  });
  const sharedObject = new FakeSynchronousSharedObject(endpoint);

  assert(sharedObject.call().state === "loading", "endpoint did not start");
  await Promise.resolve();
  await Promise.resolve();
  const complete = sharedObject.call();
  assert(complete.state === "complete", "polling exception was not retained");
  assert(
    complete.state === "complete" &&
      "error" in complete.result &&
      complete.result.error.includes("state read trapped"),
    `wrong polling exception result: ${JSON.stringify(complete)}`,
  );
});

Deno.test("additional sysroot endpoint synchronously correlates command and scalar status", () => {
  const calls: string[] = [];
  let nextRequestId = 16;
  const endpoint = createAdditionalSysrootStatusEndpoint({
    additionalSysrootRegister() {
      calls.push("register");
      return ++nextRequestId;
    },
    additionalSysrootState(requestId) {
      calls.push(`state:${requestId}`);
      return 2;
    },
    additionalSysrootErrorCode(requestId) {
      calls.push(`error:${requestId}`);
      return 1;
    },
    additionalSysrootCancel(requestId) {
      calls.push(`cancel:${requestId}`);
      return 1;
    },
    additionalSysrootRelease(requestId) {
      calls.push(`release:${requestId}`);
      return 1;
    },
    dispatch(sessionId, eventType, arg1) {
      calls.push(`dispatch:${sessionId}:${eventType}:${arg1}`);
    },
  });
  const sharedObject = new FakeSynchronousSharedObject(endpoint);

  assert(
    sharedObject.call({ operation: "start", triple: "wasm32-wasip2" }) === 17,
    "start did not return request id",
  );
  const command = "load_sysroot wasm32-wasip2 17\r";
  const firstSessionId = ADDITIONAL_SYSROOT_SESSION_ID;
  assert(calls[0] === "register", "command dispatched before registration");
  assert(
    calls.slice(1).join(",") ===
      [
        `dispatch:${firstSessionId}:3:0`,
        ...[...command].map(
          (char) => `dispatch:${firstSessionId}:0:${char.codePointAt(0)}`,
        ),
      ].join(","),
    `wrong correlated command: ${calls.slice(1).join(",")}`,
  );
  calls.length = 0;
  assert(
    sharedObject.call({ operation: "start", triple: "wasm32-wasip3" }) === 18,
    "second start did not return its request id",
  );
  assert(
    calls[1] === `dispatch:${ADDITIONAL_SYSROOT_SESSION_ID - 1}:3:0`,
    "concurrent request did not receive a distinct hidden session",
  );
  calls.length = 0;
  assert(
    sharedObject.call({ operation: "state", requestId: 17 }) === 2,
    "wrong state",
  );
  assert(
    sharedObject.call({ operation: "error", requestId: 17 }) === 1,
    "wrong error",
  );
  assert(
    sharedObject.call({ operation: "cancel", requestId: 17 }) === 1,
    "wrong cancel",
  );
  assert(
    sharedObject.call({ operation: "release", requestId: 17 }) === 1,
    "wrong release",
  );
  assert(
    calls.at(-1) === `dispatch:${firstSessionId}:5:0`,
    "released request did not close its hidden session",
  );
  assert(
    sharedObject.call({ operation: "release", requestId: 18 }) === 1,
    "second release failed",
  );
});

Deno.test("additional sysroot endpoint releases registration when dispatch fails", () => {
  const cleanup: string[] = [];
  const endpoint = createAdditionalSysrootStatusEndpoint({
    additionalSysrootRegister: () => 9,
    additionalSysrootState: () => 0,
    additionalSysrootErrorCode: () => 0,
    additionalSysrootCancel(requestId) {
      cleanup.push(`cancel:${requestId}`);
      return 1;
    },
    additionalSysrootRelease(requestId) {
      cleanup.push(`release:${requestId}`);
      return 1;
    },
    dispatch() {
      throw new Error("dispatch failed");
    },
  });

  let rejected = false;
  try {
    endpoint({ operation: "start", triple: "x86_64-unknown-linux-gnu" });
  } catch {
    rejected = true;
  }
  assert(rejected, "dispatch failure was accepted");
  assert(
    cleanup.join(",") === "cancel:9,release:9",
    `registration leaked: ${cleanup}`,
  );
});

Deno.test({
  name: "VFS runtime readiness follows startup and handler registration",
  ignore: !canReadWorkerSource,
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./worker_process/util_cmd.ts", import.meta.url),
    );
    const ready = source.indexOf("await vfs_ready({ ok: true })");
    assert(ready >= 0, "VFS runtime readiness does not report exact success");

    for (const marker of [
      "animal.start(vfs_root as any)",
      "vfs_root.dispatch(0, 3, 0, 0)",
      "const { cols, rows } = await get_terminal_size()",
      "vfs_root.dispatch(0, 1, cols, rows)",
      "ctx.create_session_id",
      "ctx.input_char_id",
      "ctx.input_string_id",
      "ctx.interrupt_id",
      "ctx.resize_id",
      "ctx.close_session_id",
      "ctx.load_additional_sysroot_id",
      "ctx.install_startup_sysroots_id",
    ]) {
      const position = source.indexOf(marker);
      assert(position >= 0, `missing startup marker: ${marker}`);
      assert(position < ready, `${marker} is registered after VFS readiness`);
    }
  },
});

Deno.test({
  name: "runtime-ready source does not await sysroot installation",
  ignore: !canReadWorkerSource,
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./worker_process/util_cmd.ts", import.meta.url),
    );
    const ready = source.indexOf("await vfs_ready({ ok: true })");
    const endpoint = source.slice(
      source.indexOf("ctx.close_session_id"),
      ready,
    );

    assert(
      endpoint.includes("createStartupSysrootStatusEndpoint(vfs_root"),
      "startup status endpoint is not backed by the generated root",
    );
    assert(!endpoint.includes("async ()"), "status callback is async");
    assert(
      !endpoint.includes("await waitForStartupSysroots"),
      "runtime-ready awaits sysroots",
    );
    assert(!endpoint.includes("as unknown as"), "generated root is still cast");
  },
});

Deno.test({
  name: "generated VFS root exposes startup sysroot state and error methods",
  ignore: !canReadWorkerSource,
  async fn() {
    const declarations = await Deno.readTextFile(
      new URL("./worker_process/vfs_bindings/vfs.d.ts", import.meta.url),
    );
    const runtime = await Deno.readTextFile(
      new URL("./worker_process/vfs_bindings/vfs.js", import.meta.url),
    );

    for (const method of [
      "startupSysrootLoadState",
      "startupSysrootErrorCode",
      "additionalSysrootRegister",
      "additionalSysrootState",
      "additionalSysrootErrorCode",
      "additionalSysrootCancel",
      "additionalSysrootRelease",
    ]) {
      assert(
        declarations.includes(`${method}(`),
        `${method} declaration missing`,
      );
      assert(
        runtime.includes(`function ${method}(`),
        `${method} runtime missing`,
      );
    }
  },
});
