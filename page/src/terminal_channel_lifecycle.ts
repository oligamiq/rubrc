import { closeUnderlyingChannel } from "./shared_object_channel.ts";

export type SharedChannelLease<T = unknown> = {
  channel: T;
  release(): void;
};
type SharedChannelEntry = { channel: unknown; leases: number };

const sharedChannels = new Map<string, SharedChannelEntry>();
const terminalCaptures = new Map<
  string,
  {
    leases: number;
    limit: number;
    out: string;
    outBytes: number;
    error: string;
    errorBytes: number;
  }
>();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const utf8Length = (value: string) => textEncoder.encode(value).byteLength;

export const appendBounded = (
  current: string,
  currentBytes: number,
  value: string,
  limit: number,
): { value: string; bytes: number } => {
  const valueBytes = utf8Length(value);
  if (valueBytes >= limit) {
    const bytes = textEncoder.encode(value);
    for (
      let offset = bytes.byteLength - limit;
      offset < bytes.byteLength;
      offset++
    ) {
      try {
        const bounded = textDecoder.decode(bytes.subarray(offset));
        return { value: bounded, bytes: utf8Length(bounded) };
      } catch {
        // Move to the next UTF-8 character boundary.
      }
    }
    return { value: "", bytes: 0 };
  }
  const overflow = currentBytes + valueBytes - limit;
  if (overflow <= 0) {
    return { value: current + value, bytes: currentBytes + valueBytes };
  }
  let removedBytes = 0;
  let offset = 0;
  for (const character of current) {
    removedBytes += utf8Length(character);
    offset += character.length;
    if (removedBytes >= overflow) break;
  }
  const bounded = current.slice(offset) + value;
  return {
    value: bounded,
    bytes: currentBytes - removedBytes + valueBytes,
  };
};

export function createTerminalGenerationRouter<TTarget, TData>(
  deliver: (target: TTarget, data: TData) => void,
) {
  const generations = new Map<string, Map<number, TTarget>>();
  return {
    register(generationKey: string, sessionId: number, target: TTarget): void {
      const sessions = generations.get(generationKey) ?? new Map();
      sessions.set(sessionId, target);
      generations.set(generationKey, sessions);
    },
    unregister(
      generationKey: string,
      sessionId: number,
      target: TTarget,
    ): void {
      const sessions = generations.get(generationKey);
      if (sessions?.get(sessionId) !== target) return;
      sessions.delete(sessionId);
      if (sessions.size === 0) generations.delete(generationKey);
    },
    write(generationKey: string, sessionId: number, data: TData): void {
      const target = generations.get(generationKey)?.get(sessionId);
      if (target !== undefined) deliver(target, data);
    },
  };
}

export function acquireTerminalCapture(key: string, limit = 64 * 1024) {
  const entry = terminalCaptures.get(key) ?? {
    leases: 0,
    limit,
    out: "",
    outBytes: 0,
    error: "",
    errorBytes: 0,
  };
  entry.leases++;
  terminalCaptures.set(key, entry);
  let released = false;
  return {
    capture: {
      appendOut(value: string) {
        const bounded = appendBounded(
          entry.out,
          entry.outBytes,
          value,
          entry.limit,
        );
        entry.out = bounded.value;
        entry.outBytes = bounded.bytes;
      },
      appendError(value: string) {
        const bounded = appendBounded(
          entry.error,
          entry.errorBytes,
          value,
          entry.limit,
        );
        entry.error = bounded.value;
        entry.errorBytes = bounded.bytes;
      },
      out: () => entry.out,
      error: () => entry.error,
      resetOut() {
        entry.out = "";
        entry.outBytes = 0;
      },
      resetError() {
        entry.error = "";
        entry.errorBytes = 0;
      },
    },
    release() {
      if (released) return;
      released = true;
      entry.leases--;
      if (entry.leases === 0) terminalCaptures.delete(key);
    },
  };
}

export function observeAsyncFailure(
  operation: Promise<unknown>,
  report: (error: unknown) => void,
): void {
  void operation.catch(report);
}

export function acquireSharedChannel<T>(
  key: string,
  create: () => T,
): SharedChannelLease<T> {
  const entry = sharedChannels.get(key) ?? { channel: create(), leases: 0 };
  entry.leases++;
  sharedChannels.set(key, entry);
  let released = false;
  return {
    channel: entry.channel as T,
    release() {
      if (released) return;
      released = true;
      entry.leases--;
      if (entry.leases === 0) {
        sharedChannels.delete(key);
        closeUnderlyingChannel(entry.channel);
      }
    },
  };
}

export function createChannelOwner(channels: readonly unknown[] = []) {
  const owned = [...channels];
  let disposed = false;
  return {
    add<T>(channel: T): T {
      if (disposed) {
        closeUnderlyingChannel(channel);
      } else {
        owned.push(channel);
      }
      return channel;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const channel of owned) {
        try {
          closeUnderlyingChannel(channel);
        } catch (error) {
          errors.push(error);
        }
      }
      owned.length = 0;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "runtime channel cleanup failed");
      }
    },
  };
}

export function createTerminalSessionChannels<TChannel>(
  ids: {
    resize: string;
    inputChar: string;
    inputString: string;
    lsp: string;
    interrupt: string;
    createSession: string;
  },
  create: (id: string) => TChannel,
) {
  const owner = createChannelOwner();
  let createSessionRef: TChannel | undefined;
  try {
    const resize = owner.add(create(ids.resize));
    const inputChar = owner.add(create(ids.inputChar));
    const inputString = owner.add(create(ids.inputString));
    const lsp = owner.add(create(ids.lsp));
    const interrupt = owner.add(create(ids.interrupt));
    return {
      resize,
      inputChar,
      inputString,
      lsp,
      interrupt,
      createSession(): TChannel {
        createSessionRef ??= owner.add(create(ids.createSession));
        return createSessionRef;
      },
      dispose: owner.dispose,
    };
  } catch (error) {
    try {
      owner.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [cleanupError],
        "terminal channel construction cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
