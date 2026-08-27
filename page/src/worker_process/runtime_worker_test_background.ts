globalThis.postMessage({ type: "fixture-ready", worker: "background" });

globalThis.addEventListener("message", (event) => {
  const sender = event.data.worker_background_ref_object as {
    lock: SharedArrayBuffer;
    signature_input: SharedArrayBuffer;
  };
  const lock = new Int32Array(sender.lock);
  const signature = new Int32Array(sender.signature_input);
  Atomics.store(lock, 0, 0);
  Atomics.store(lock, 1, 1);
  globalThis.postMessage("ready");

  const poll = setInterval(() => {
    if (Atomics.load(lock, 1) !== 0 || Atomics.load(lock, 2) !== 1) return;
    if (Atomics.load(signature, 0) !== 5) {
      clearInterval(poll);
      Atomics.store(lock, 1, 1);
      Atomics.store(lock, 2, 0);
      Atomics.notify(lock, 2);
      globalThis.postMessage({
        type: "fixture-error",
        message: "test coordinator received a non-destroy request",
      });
      globalThis.close();
      return;
    }
    Atomics.store(lock, 1, 1);
    Atomics.store(lock, 2, 0);
    Atomics.notify(lock, 2, 1);
    clearInterval(poll);
  }, 1);
});
