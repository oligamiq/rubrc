import * as sharedObject from "@oligami/shared-object";
import type {
  CommandWaiterEndpoint,
  CommandWaiterProxy,
} from "./cmd_parser.ts";
import {
  cargoRunArgs,
  commandText,
  downloadArgs,
  type InputStringEndpoint,
  notReadyOutput,
  type TerminalWriteEndpoint,
} from "./compile_and_run.ts";
import type { Ctx } from "./ctx.ts";
import { closeUnderlyingChannel } from "./shared_object_channel.ts";

type SharedChannel = object;

interface SharedRefChannel extends SharedChannel {
  proxy<T>(): T;
}

export interface RuntimeSharedObjectFactories {
  createSharedObject(value: unknown, id: string): SharedChannel;
  createSharedObjectRef(id: string): SharedRefChannel;
}

const defaultFactories: RuntimeSharedObjectFactories = {
  createSharedObject: (value, id) => new sharedObject.SharedObject(value, id),
  createSharedObjectRef: (id) => new sharedObject.SharedObjectRef(id),
};

function closeChannelErrors(channels: readonly SharedChannel[]): unknown[] {
  const errors: unknown[] = [];
  for (const channel of channels) {
    try {
      closeUnderlyingChannel(channel);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function channelCleanupError(errors: readonly unknown[]): unknown {
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(
    errors,
    "runtime SharedObject channel cleanup failed",
  );
}

function observeChannelCleanupErrors(errors: readonly unknown[]): void {
  const error = channelCleanupError(errors);
  if (error === undefined) return;
  try {
    console.error(error);
  } catch {
    // Cleanup reporting cannot replace the primary setup/abort failure.
  }
}

function closeChannels(channels: readonly SharedChannel[]): void {
  const error = channelCleanupError(closeChannelErrors(channels));
  if (error !== undefined) throw error;
}

export class RuntimeParserService {
  readonly ready: Promise<void>;
  private readonly controller = new AbortController();
  private readonly disposedReason = new Error(
    "runtime parser service is disposed",
  );
  private readonly waiter: SharedChannel;
  private readonly abortFromGeneration: () => void;
  private allDone = false;
  private commandRunEnded = true;
  private disposed = false;

  constructor(
    _ctx: Ctx,
    readonly signal: AbortSignal,
    factories: RuntimeSharedObjectFactories = defaultFactories,
  ) {
    signal.throwIfAborted();
    this.abortFromGeneration = () => this.controller.abort(signal.reason);
    signal.addEventListener("abort", this.abortFromGeneration, {
      once: true,
    });
    const methods: CommandWaiterEndpoint = {
      is_all_done: () => {
        this.assertActive();
        return this.allDone;
      },
      is_cmd_run_end: () => {
        this.assertActive();
        return this.commandRunEnded;
      },
      set_end_of_exec: (endOfExec) => {
        this.assertActive();
        this.commandRunEnded = endOfExec;
      },
    };
    let waiter: SharedChannel | undefined;
    try {
      signal.throwIfAborted();
      waiter = factories.createSharedObject(methods, _ctx.waiter_id);
      signal.throwIfAborted();
    } catch (error) {
      const primary = signal.aborted ? signal.reason : error;
      signal.removeEventListener("abort", this.abortFromGeneration);
      this.controller.abort(primary);
      observeChannelCleanupErrors(
        waiter === undefined ? [] : closeChannelErrors([waiter]),
      );
      throw primary;
    }
    this.waiter = waiter;

    this.ready = Promise.resolve().then(() => {
      this.controller.signal.throwIfAborted();
      this.allDone = true;
    });
    void this.ready.catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal.removeEventListener("abort", this.abortFromGeneration);
    this.controller.abort(this.disposedReason);
    closeUnderlyingChannel(this.waiter);
  }

  private assertActive(): void {
    this.controller.signal.throwIfAborted();
  }
}

export class RuntimeCommandService {
  private readonly controller = new AbortController();
  private readonly disposedReason = new Error(
    "runtime command service is disposed",
  );
  private readonly channels: SharedRefChannel[];
  private readonly waiter: CommandWaiterProxy;
  private readonly terminal: TerminalWriteEndpoint;
  private readonly inputString: InputStringEndpoint;
  private readonly abortFromGeneration: () => void;
  private ready = false;
  private disposed = false;

  constructor(
    ctx: Ctx,
    readonly signal: AbortSignal,
    factories: RuntimeSharedObjectFactories = defaultFactories,
  ) {
    signal.throwIfAborted();
    this.abortFromGeneration = () => this.controller.abort(signal.reason);
    signal.addEventListener("abort", this.abortFromGeneration, {
      once: true,
    });
    const channels: SharedRefChannel[] = [];
    let waiter: CommandWaiterProxy;
    let terminal: TerminalWriteEndpoint;
    let inputString: InputStringEndpoint;
    try {
      signal.throwIfAborted();
      const waiterRef = factories.createSharedObjectRef(ctx.waiter_id);
      channels.push(waiterRef);
      signal.throwIfAborted();
      waiter = waiterRef.proxy<CommandWaiterProxy>();
      signal.throwIfAborted();

      const terminalRef = factories.createSharedObjectRef(ctx.terminal_id);
      channels.push(terminalRef);
      signal.throwIfAborted();
      terminal = terminalRef.proxy<TerminalWriteEndpoint>();
      signal.throwIfAborted();

      const inputStringRef = factories.createSharedObjectRef(
        ctx.input_string_id,
      );
      channels.push(inputStringRef);
      signal.throwIfAborted();
      inputString = inputStringRef.proxy<InputStringEndpoint>();
      signal.throwIfAborted();
    } catch (error) {
      const primary = signal.aborted ? signal.reason : error;
      signal.removeEventListener("abort", this.abortFromGeneration);
      this.controller.abort(primary);
      observeChannelCleanupErrors(closeChannelErrors(channels));
      throw primary;
    }
    this.channels = channels;
    this.waiter = waiter;
    this.terminal = terminal;
    this.inputString = inputString;
  }

  async run(triple?: string): Promise<void> {
    this.controller.signal.throwIfAborted();
    if (!this.ready) {
      const allDone = await this.proxyOperation(() =>
        this.waiter.is_all_done()
      );
      this.controller.signal.throwIfAborted();
      if (!allDone) {
        await this.proxyOperation(() =>
          this.terminal({ sessionId: 0, data: notReadyOutput() })
        );
        return;
      }
      this.ready = true;
    }
    await this.command(cargoRunArgs(triple));
  }

  async download(file: string): Promise<void> {
    await this.command(downloadArgs(file));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal.removeEventListener("abort", this.abortFromGeneration);
    this.controller.abort(this.disposedReason);
    closeChannels(this.channels);
  }

  private command(args: readonly string[]): Promise<void> {
    return this.proxyOperation(() =>
      this.inputString({ sessionId: 0, data: commandText(args) })
    );
  }

  private proxyOperation<T>(operation: () => Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    let proxy: Promise<T>;
    try {
      signal.throwIfAborted();
      proxy = operation();
    } catch (error) {
      const rejected = Promise.reject<T>(
        signal.aborted ? signal.reason : error,
      );
      void rejected.catch(() => undefined);
      return rejected;
    }
    void proxy.catch(() => undefined);
    if (signal.aborted) {
      const rejected = Promise.reject<T>(signal.reason);
      void rejected.catch(() => undefined);
      return rejected;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => settle(() => reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      proxy.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    });
  }
}
