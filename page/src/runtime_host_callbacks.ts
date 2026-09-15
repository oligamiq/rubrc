import {
  type ChildProcessBridgeOwner,
  isChildProcessMessage,
} from "../../lib/src/child_process_bridge.ts";
import {
  type HttpBridgeOwner,
  isHttpBridgeMessage,
} from "../../lib/src/http_bridge.ts";

export interface RuntimeHostCallbackOwner {
  handle(message: unknown): Promise<unknown> | unknown;
  abort(reason?: unknown): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RuntimeHostCallbackOwnerOptions {
  signal: AbortSignal;
  sysroot(message: unknown): unknown;
  http: HttpBridgeOwner;
  child: ChildProcessBridgeOwner;
  handleSynchronousMessage(message: unknown): unknown;
}

export function createRuntimeHostCallbackOwner(
  options: RuntimeHostCallbackOwnerOptions,
): RuntimeHostCallbackOwner {
  const controller = new AbortController();
  const active = new Set<Promise<unknown>>();
  let disposePromise: Promise<void> | undefined;

  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    void operation
      .catch(() => undefined)
      .finally(() => active.delete(operation));
    return operation;
  };

  const settle = async () => {
    const dependencies = [options.http.settle(), options.child.settle()];
    await Promise.allSettled([...active, ...dependencies]);
  };

  const abort = (
    reason: unknown = new DOMException("runtime disposed", "AbortError"),
  ) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    options.http.abort(reason);
    options.child.abort(reason);
  };

  const abortFromSignal = () => abort(options.signal.reason);
  if (options.signal.aborted) {
    abort(options.signal.reason);
  } else {
    options.signal.addEventListener("abort", abortFromSignal, { once: true });
  }

  const handle = (message: unknown): Promise<unknown> | unknown => {
    controller.signal.throwIfAborted();
    const sysroot = options.sysroot(message);
    if (sysroot !== undefined) return sysroot;
    if (isHttpBridgeMessage(message))
      return track(options.http.handle(message));
    if (isChildProcessMessage(message)) {
      return track(options.child.handle(message));
    }
    return options.handleSynchronousMessage(message);
  };

  const dispose = () => {
    if (!disposePromise) {
      disposePromise = (async () => {
        abort();
        const dependencies = Promise.allSettled([
          options.http.dispose(),
          options.child.dispose(),
        ]);
        await settle();
        await dependencies;
        options.signal.removeEventListener("abort", abortFromSignal);
      })();
    }
    return disposePromise;
  };

  return { handle, abort, settle, dispose };
}
