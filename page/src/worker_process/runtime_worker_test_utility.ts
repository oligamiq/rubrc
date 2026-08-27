import type { DestroyerHandleObject } from "@oligami/browser_wasi_shim-threads";
import {
  createUtilityWorkerMessageHandler,
  createUtilityWorkerStateMachine,
} from "../runtime_worker_protocol.ts";

const utility = createUtilityWorkerStateMachine({
  prepareAnimal(message, signal) {
    const fixture = message.wasiRef as unknown as {
      prerequisiteBuffer?: SharedArrayBuffer;
      blockPrerequisite?: boolean;
    };
    if (!fixture.blockPrerequisite || !fixture.prerequisiteBuffer) return;

    const prerequisite = new Int32Array(fixture.prerequisiteBuffer);
    Atomics.store(prerequisite, 0, 1);
    Atomics.notify(prerequisite, 0);
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason),
        { once: true },
      );
    });
  },
  createAnimal(message) {
    const fixture = message.wasiRef as unknown as {
      handle: DestroyerHandleObject;
      countersBuffer: SharedArrayBuffer;
      failStart?: boolean;
    };
    const counters = new Int32Array(fixture.countersBuffer);
    Atomics.add(counters, 0, 1);
    return {
      create_destroyer: () => ({ get_object: () => fixture.handle }),
      start(_root: unknown) {
        Atomics.add(counters, 1, 1);
        if (fixture.failStart) throw new Error("start failed");
      },
      destroy() {
        Atomics.add(counters, 2, 1);
      },
    };
  },
  startGuest(animal) {
    animal.start({});
  },
  postMessage: (message) => globalThis.postMessage(message),
});

const handleUtilityMessage = createUtilityWorkerMessageHandler({
  machine: utility,
  postMessage: (message) => globalThis.postMessage(message),
});

globalThis.addEventListener("message", (event) => {
  void handleUtilityMessage(event.data);
});

globalThis.postMessage({ type: "fixture-ready", worker: "utility" });
