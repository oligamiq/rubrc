import { afterAll, expect, test } from "bun:test";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { DestroyerHandle } from "../node_modules/@oligami/browser_wasi_shim-threads/src/destroyer_handle.ts";
import { ThreadSpawner } from "../node_modules/@oligami/browser_wasi_shim-threads/src/shared_array_buffer/thread_spawn.ts";
import { WorkerBackgroundRef } from "../node_modules/@oligami/browser_wasi_shim-threads/src/shared_array_buffer/worker_background/worker_background_ref.ts";
import { WorkerBackgroundRefObjectConstructor } from "../node_modules/@oligami/browser_wasi_shim-threads/src/shared_array_buffer/worker_background/worker_export.ts";

const originalInitSelf = WorkerBackgroundRef.init_self;

afterAll(() => {
  WorkerBackgroundRef.init_self = originalInitSelf;
});

function structuredCloneThroughPort<T>(value: T): T {
  const { port1, port2 } = new MessageChannel();
  try {
    port1.postMessage(value);
    return receiveMessageOnPort(port2)!.message;
  } finally {
    port1.close();
    port2.close();
  }
}

function senderObject() {
  return {
    allocator: { share_arrays_memory: new SharedArrayBuffer(1024) },
    lock: new SharedArrayBuffer(24),
    signature_input: new SharedArrayBuffer(24),
  };
}

function makeSender(destroy: () => void) {
  const sender = Object.create(WorkerBackgroundRef.prototype);
  sender.destroy = destroy;
  sender.get_object = senderObject;
  return sender;
}

function waitForWorker(worker: Worker): Promise<{ error?: string; state: number }> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = reject;
  });
}

test("public package DestroyerHandle reconstructs a real structured-cloned sender object", async () => {
  const object = {
    sender: WorkerBackgroundRefObjectConstructor(),
    destroy_status: new SharedArrayBuffer(8),
  };
  const worker = new Worker(new URL("./browser_wasi_shim_public_dist_worker.ts", import.meta.url).href);
  const result = waitForWorker(worker);
  worker.postMessage({ object, mode: "reconstruct" });

  try {
    expect(await result).toEqual({ allocatorShared: true, destroyStatusShared: true });
  } finally {
    worker.terminate();
  }
});

test("installed DestroyerHandle transfers, reconstructs, and destroys once", () => {
  let destroyCalls = 0;
  const sender = makeSender(() => { destroyCalls++; });
  WorkerBackgroundRef.init_self = () => sender;
  const status = new SharedArrayBuffer(8);
  const handle = new DestroyerHandle(sender, status);

  const object = structuredCloneThroughPort(handle.get_object());
  expect(object.destroy_status).toBeInstanceOf(SharedArrayBuffer);
  const restored = DestroyerHandle.init_self(object);
  restored.destroy();
  restored.destroy();

  expect(destroyCalls).toBe(1);
  expect(Atomics.load(new Int32Array(status), 1)).toBe(2);
});

test("installed DestroyerHandle wakes concurrent loser after success", async () => {
  const status = new SharedArrayBuffer(8);
  const sender = makeSender(() => { throw new Error("main sender must lose"); });
  const object = structuredCloneThroughPort(new DestroyerHandle(sender, status).get_object());
  WorkerBackgroundRef.init_self = () => sender;
  const loser = DestroyerHandle.init_self(object);
  const syncBuffer = new SharedArrayBuffer(12);
  const sync = new Int32Array(syncBuffer);
  const worker = new Worker(new URL("./browser_wasi_shim_destroy_worker.ts", import.meta.url).href);
  const result = waitForWorker(worker);
  worker.postMessage({ object, syncBuffer, fail: false });
  Atomics.wait(sync, 1, 0, 1_000);

  loser.destroy();
  expect(Atomics.load(new Int32Array(status), 1)).toBe(2);
  const workerResult = await result;
  worker.terminate();

  expect(workerResult).toEqual({ state: 2 });
  expect(Atomics.load(sync, 0)).toBe(1);
  expect(Atomics.load(new Int32Array(status), 1)).toBe(2);
});

test("installed DestroyerHandle publishes failure and wakes concurrent loser", async () => {
  const status = new SharedArrayBuffer(8);
  const sender = makeSender(() => { throw new Error("main sender must lose"); });
  const object = structuredCloneThroughPort(new DestroyerHandle(sender, status).get_object());
  WorkerBackgroundRef.init_self = () => sender;
  const loser = DestroyerHandle.init_self(object);
  const syncBuffer = new SharedArrayBuffer(12);
  const sync = new Int32Array(syncBuffer);
  const worker = new Worker(new URL("./browser_wasi_shim_destroy_worker.ts", import.meta.url).href);
  const result = waitForWorker(worker);
  worker.postMessage({ object, syncBuffer, fail: true });
  Atomics.wait(sync, 1, 0, 1_000);

  expect(() => loser.destroy()).toThrow("destroy failed");
  const workerResult = await result;
  worker.terminate();

  expect(workerResult).toEqual({ error: "sender destroy failed", state: 3 });
  expect(Atomics.load(sync, 0)).toBe(1);
  expect(Atomics.load(new Int32Array(status), 1)).toBe(3);
});

test("installed ThreadSpawner terminates its directly held coordinator before success", () => {
  const spawner = Object.create(ThreadSpawner.prototype) as any;
  spawner.destroy_status = new SharedArrayBuffer(8);
  spawner.worker_background_ref = { destroy: () => {} };
  let terminateCalls = 0;
  let stateDuringTerminate = -1;
  spawner.worker_background_worker = {
    terminate: () => {
      terminateCalls++;
      stateDuringTerminate = Atomics.load(new Int32Array(spawner.destroy_status), 1);
    },
  };

  spawner.destroy();

  expect(terminateCalls).toBe(1);
  expect(stateDuringTerminate).toBe(1);
  expect(spawner.worker_background_worker).toBeUndefined();
  expect(Atomics.load(new Int32Array(spawner.destroy_status), 1)).toBe(2);
});
