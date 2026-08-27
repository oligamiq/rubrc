import { DestroyerHandle } from "@oligami/browser_wasi_shim-threads";
import {
  createLifecycleWorkerStateMachine,
  isLifecycleWorkerInbound,
  type LifecycleWorkerOutbound,
  toErrorMessage,
} from "../runtime_worker_protocol.ts";

const machine = createLifecycleWorkerStateMachine({
  restoreDestroyer: (handle) => DestroyerHandle.init_self(handle),
  postMessage: (message) => globalThis.postMessage(message),
});

globalThis.addEventListener("message", (event) => {
  void machine.handle(event.data).catch((error) => {
    const message = isLifecycleWorkerInbound(event.data)
      ? event.data
      : undefined;
    const fatal = {
      type: "fatal",
      generation: message?.generation ?? "invalid",
      ...(message?.type === "destroy" ? { token: message.token } : {}),
      message: toErrorMessage(error),
    } satisfies LifecycleWorkerOutbound;
    globalThis.postMessage(fatal);
  });
});
