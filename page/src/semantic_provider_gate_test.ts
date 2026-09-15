import { SemanticProviderGate } from "./semantic_provider_gate.ts";

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const token = () => {
  let cancelled = false;
  const listeners = new Set<() => unknown>();
  return {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(listener: () => unknown) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
};

Deno.test("semantic provider gate defers requests until opened", async () => {
  const gate = new SemanticProviderGate();
  const cancellation = token();
  let settled = false;
  const waiting = gate.wait(cancellation).then((allowed) => {
    settled = true;
    return allowed;
  });
  await Promise.resolve();
  assert(!settled, "closed gate did not defer the provider request");
  gate.open();
  assert(await waiting, "opened gate did not release the provider request");
  assert(
    cancellation.listenerCount() === 0,
    "gate leaked cancellation listener",
  );
});

Deno.test("semantic provider gate drops cancelled and disposed requests", async () => {
  const cancelledGate = new SemanticProviderGate();
  const cancellation = token();
  const cancelledWait = cancelledGate.wait(cancellation);
  cancellation.cancel();
  assert(!(await cancelledWait), "cancelled provider request was released");
  assert(
    cancellation.listenerCount() === 0,
    "cancelled request leaked listener",
  );

  const disposedGate = new SemanticProviderGate();
  const pending = disposedGate.wait(token());
  disposedGate.dispose();
  assert(!(await pending), "disposed gate released a provider request");
});
