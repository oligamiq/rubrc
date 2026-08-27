export type VfsReadyResult = { ok: true } | { ok: false; error: string };

export type StartupSysrootKind = 0 | 1;

export type StartupSysrootRoot = {
  dispatch(
    sessionId: number,
    eventType: number,
    arg1: number,
    arg2: number,
  ): void;
  startupSysrootLoadState(kind: number): number;
  startupSysrootErrorCode(kind: number): number;
};

export type StartupSysrootTiming = {
  timeoutMs?: number;
  now?: () => number;
  sleep?: () => Promise<void>;
};

export type StartupSysrootStatus =
  | { state: "loading" }
  | { state: "complete"; result: VfsReadyResult };

export type StartupSysrootStatusEndpoint = () => StartupSysrootStatus;

export type AdditionalSysrootRequest =
  | { operation: "start"; triple: string }
  | { operation: "state"; requestId: number }
  | { operation: "error"; requestId: number }
  | { operation: "cancel"; requestId: number }
  | { operation: "release"; requestId: number };

export type AdditionalSysrootRoot = {
  additionalSysrootRegister(): number;
  additionalSysrootState(requestId: number): number;
  additionalSysrootErrorCode(requestId: number): number;
  additionalSysrootCancel(requestId: number): number;
  additionalSysrootRelease(requestId: number): number;
  dispatch(
    sessionId: number,
    eventType: number,
    arg1: number,
    arg2: number,
  ): void;
};

const STARTUP_SYSROOTS = [
  { kind: 0, name: "rust-src", event: 8 },
  { kind: 1, name: "wasm32-wasip1", event: 9 },
] as const;
export const RUST_SRC_BOOTSTRAP_TIMEOUT_MS = 300_000;
export const STARTUP_SYSROOT_TIMEOUT_MS = RUST_SRC_BOOTSTRAP_TIMEOUT_MS;
export const ADDITIONAL_SYSROOT_SESSION_ID = 0xdddd_dddd;
const ADDITIONAL_SYSROOT_SESSION_CAPACITY = 8;
const FIRST_ADDITIONAL_SYSROOT_SESSION_ID =
  ADDITIONAL_SYSROOT_SESSION_ID - ADDITIONAL_SYSROOT_SESSION_CAPACITY + 1;

export function nextVisibleTerminalSessionId(sessionId: number): number {
  if (sessionId >= FIRST_ADDITIONAL_SYSROOT_SESSION_ID) {
    throw new Error("session capacity exhausted");
  }
  return sessionId;
}

const stateName = (state: number) =>
  ["NotStarted", "Loading", "Ready", "Failed"][state] ?? `Invalid(${state})`;

const startupSysrootError = (
  kind: StartupSysrootKind,
  errorCode: number,
): string => {
  const name = STARTUP_SYSROOTS[kind].name;
  if (errorCode === 1) {
    const installation = kind === 0 ? "core" : "target";
    return `${name} fetch failed before ${installation} installation`;
  }
  if (errorCode === 2) return `${name} extraction failed`;
  if (errorCode === 3) {
    return kind === 0
      ? "rust-src extraction completed without /sysroot/lib/rustlib/src/rust/library/core/src/lib.rs"
      : "wasm32-wasip1 extraction completed without a libcore-*.rlib";
  }
  if (errorCode === 4) {
    return `${name} installation failed: invalid startup sysroot kind ${kind}`;
  }
  return `${name} installation failed with error code ${errorCode}`;
};

export function dispatchStartupSysroots(root: StartupSysrootRoot): void {
  for (const sysroot of STARTUP_SYSROOTS) {
    root.dispatch(0, sysroot.event, 0, 0);
  }
}

export function readStartupSysrootSnapshot(root: StartupSysrootRoot): {
  states: [number, number];
  result?: VfsReadyResult;
} {
  const states = STARTUP_SYSROOTS.map(({ kind }) =>
    root.startupSysrootLoadState(kind),
  ) as [number, number];
  for (const [index, sysroot] of STARTUP_SYSROOTS.entries()) {
    const state = states[index];
    if (state === 3) {
      return {
        states,
        result: {
          ok: false,
          error: startupSysrootError(
            sysroot.kind,
            root.startupSysrootErrorCode(sysroot.kind),
          ),
        },
      };
    }
    if (state !== 0 && state !== 1 && state !== 2) {
      return {
        states,
        result: {
          ok: false,
          error: `${sysroot.name} installation returned invalid state ${state}`,
        },
      };
    }
  }
  return {
    states,
    result: states.every((state) => state === 2) ? { ok: true } : undefined,
  };
}

async function pollStartupSysroots(
  root: StartupSysrootRoot,
  timing: StartupSysrootTiming = {},
): Promise<VfsReadyResult> {
  const timeoutMs = timing.timeoutMs ?? STARTUP_SYSROOT_TIMEOUT_MS;
  const now = timing.now ?? performance.now.bind(performance);
  const sleep =
    timing.sleep ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  const deadline = now() + timeoutMs;

  while (true) {
    const { states, result } = readStartupSysrootSnapshot(root);
    if (result) return result;
    if (now() >= deadline) {
      return {
        ok: false,
        error: `startup sysroot installation timed out after ${timeoutMs}ms while rust-src=${stateName(
          states[0],
        )}, wasm32-wasip1=${stateName(states[1])}`,
      };
    }
    await sleep();
  }
}

export async function waitForStartupSysroots(
  root: StartupSysrootRoot,
  timing: StartupSysrootTiming = {},
): Promise<VfsReadyResult> {
  dispatchStartupSysroots(root);
  return await pollStartupSysroots(root, timing);
}

export function createStartupSysrootStatusEndpoint(
  root: StartupSysrootRoot,
  timing: StartupSysrootTiming = {},
): StartupSysrootStatusEndpoint {
  let started = false;
  let status: StartupSysrootStatus = { state: "loading" };

  return () => {
    if (!started) {
      started = true;
      try {
        dispatchStartupSysroots(root);
        const operation = pollStartupSysroots(root, timing);
        void operation
          .then((result) => {
            status = { state: "complete", result };
          })
          .catch((error) => {
            status = {
              state: "complete",
              result: { ok: false, error: String(error) },
            };
          });
      } catch (error) {
        status = {
          state: "complete",
          result: { ok: false, error: String(error) },
        };
      }
    }
    return status;
  };
}

export async function awaitStartupSysroots(
  endpoint: () => Promise<StartupSysrootStatus>,
  timing: Pick<StartupSysrootTiming, "sleep"> = {},
): Promise<VfsReadyResult> {
  const sleep =
    timing.sleep ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  while (true) {
    const status = await endpoint();
    if (status.state === "complete") return status.result;
    await sleep();
  }
}

export async function awaitStartupSysrootsSettlement(
  endpoint: () => Promise<StartupSysrootStatus>,
  signal: AbortSignal,
  timing: Pick<StartupSysrootTiming, "sleep"> = {},
): Promise<VfsReadyResult> {
  signal.throwIfAborted();
  const sleep =
    timing.sleep ??
    (() =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  let abortReason: unknown;
  while (true) {
    let status: StartupSysrootStatus;
    try {
      status = await endpoint();
    } catch (error) {
      if (signal.aborted) throw abortReason ?? signal.reason;
      throw error;
    }
    if (signal.aborted && abortReason === undefined)
      abortReason = signal.reason;
    if (status.state === "complete") {
      if (abortReason !== undefined) throw abortReason;
      return status.result;
    }
    await sleep();
  }
}

export function createAdditionalSysrootStatusEndpoint(
  root: AdditionalSysrootRoot,
): (request: AdditionalSysrootRequest) => number {
  const sessions = new Map<number, number>();
  const availableSessions = Array.from(
    { length: ADDITIONAL_SYSROOT_SESSION_CAPACITY },
    (_, index) => ADDITIONAL_SYSROOT_SESSION_ID - index,
  );
  return (request) => {
    if (request.operation === "state") {
      return root.additionalSysrootState(request.requestId);
    }
    if (request.operation === "error") {
      return root.additionalSysrootErrorCode(request.requestId);
    }
    if (request.operation === "cancel") {
      return root.additionalSysrootCancel(request.requestId);
    }
    if (request.operation === "release") {
      const released = root.additionalSysrootRelease(request.requestId);
      if (released === 1) {
        const sessionId = sessions.get(request.requestId);
        if (sessionId !== undefined) {
          root.dispatch(sessionId, 5, 0, 0);
          sessions.delete(request.requestId);
          availableSessions.push(sessionId);
        }
      }
      return released;
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(request.triple)) {
      throw new Error(`invalid additional sysroot triple: ${request.triple}`);
    }
    const requestId = root.additionalSysrootRegister();
    if (requestId === 0) {
      throw new Error("additional sysroot request capacity exhausted");
    }
    const sessionId = availableSessions.shift();
    if (sessionId === undefined) {
      root.additionalSysrootCancel(requestId);
      root.additionalSysrootRelease(requestId);
      throw new Error("additional sysroot hidden session capacity exhausted");
    }
    try {
      root.dispatch(sessionId, 3, 0, 0);
      sessions.set(requestId, sessionId);
      for (const char of `load_sysroot ${request.triple} ${requestId}\r`) {
        const codePoint = char.codePointAt(0);
        if (codePoint !== undefined) {
          root.dispatch(sessionId, 0, codePoint, 0);
        }
      }
    } catch (error) {
      root.additionalSysrootCancel(requestId);
      root.additionalSysrootRelease(requestId);
      root.dispatch(sessionId, 5, 0, 0);
      sessions.delete(requestId);
      availableSessions.unshift(sessionId);
      throw error;
    }
    return requestId;
  };
}
