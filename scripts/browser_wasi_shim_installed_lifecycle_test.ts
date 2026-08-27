import { afterAll, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { WorkerBackgroundRefObjectConstructor } from "../node_modules/@oligami/browser_wasi_shim-threads/src/shared_array_buffer/worker_background/worker_export.ts";

const workerDir = new URL("../node_modules/@oligami/browser_wasi_shim-threads/src/shared_array_buffer/worker_background/", import.meta.url);
const sourceUrl = new URL("worker.ts", workerDir);
const testableUrl = new URL("worker_task1_testable.ts", workerDir);
const coordinatorUrl = new URL("worker_task1_coordinator.ts", workerDir);
const source = readFileSync(sourceUrl, "utf8");
const testable = source
  .replace("class WorkerBackground<T>", "export class WorkerBackground<T>")
  .replace(/\/\/ biome-ignore lint:complexity\/noUnusedVariables:[\s\S]*$/, "");
writeFileSync(testableUrl, testable);
writeFileSync(coordinatorUrl, `
  import { WorkerBackground } from "./worker_task1_testable.ts";

  self.onmessage = (event) => {
    const { refObject, eventsBuffer } = event.data;
    const events = new Int32Array(eventsBuffer);
    const record = (id) => {
      const index = Atomics.add(events, 0, 1);
      Atomics.store(events, index + 1, id);
    };
    const background = Object.create(WorkerBackground.prototype);
    background.lock = refObject.lock;
    background.signature_input = refObject.signature_input;
    background.workers = [
      undefined,
      { terminate: () => { record(1); throw new Error("terminate failed"); } },
      { terminate: () => { record(2); } },
    ];
    background.start_worker = { terminate: () => { record(3); } };
    background.animal_workers = new Map([[1, background.workers[1]], [2, background.workers[2]]]);

    const originalNotify = Atomics.notify;
    globalThis.close = () => { record(4); };
    Atomics.notify = (view, index, count) => {
      if (view.buffer === refObject.lock && index === 2 && count === 1) record(5);
      return originalNotify(view, index, count);
    };

    const listening = background.listen();
    postMessage("ready");
    listening.then(() => {
      Atomics.store(events, 7, Number(background.workers.length === 1 && background.workers[0] === undefined));
      Atomics.store(events, 8, Number(background.start_worker === undefined));
      Atomics.store(events, 9, Number(background.animal_workers.size === 0));
      postMessage("done");
    }).catch((error) => postMessage({ error: error instanceof Error ? error.message : String(error) }));
  };
`);

afterAll(() => {
  for (const url of [testableUrl, coordinatorUrl]) {
    try {
      unlinkSync(url);
    } catch {}
  }
});

function workerMessage<T>(worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = reject;
  });
}

test("installed coordinator exceptions cannot deadlock public dist destroyer clones", async () => {
  const refObject = WorkerBackgroundRefObjectConstructor();
  const eventsBuffer = new SharedArrayBuffer(40);
  const events = new Int32Array(eventsBuffer);
  const coordinator = new Worker(coordinatorUrl.href);
  const ready = workerMessage<string>(coordinator);
  coordinator.postMessage({ refObject, eventsBuffer });
  expect(await ready).toBe("ready");
  const coordinatorDone = workerMessage<string | { error: string }>(coordinator);

  const destroyStatus = new SharedArrayBuffer(8);
  const object = { sender: refObject, destroy_status: destroyStatus };
  const first = new Worker(new URL("./browser_wasi_shim_public_dist_worker.ts", import.meta.url).href);
  const second = new Worker(new URL("./browser_wasi_shim_public_dist_worker.ts", import.meta.url).href);
  const firstResult = workerMessage<{ error?: string; state?: number }>(first);
  const secondResult = workerMessage<{ error?: string; state?: number }>(second);
  first.postMessage({ object, mode: "destroy" });
  second.postMessage({ object, mode: "destroy" });

  try {
    const [results, done] = await Promise.race([
      Promise.all([Promise.all([firstResult, secondResult]), coordinatorDone]),
      Bun.sleep(1_500).then(() => {
        throw new Error(`installed lifecycle timed out: status=${Atomics.load(new Int32Array(destroyStatus), 1)} events=${Array.from(events)}`);
      }),
    ]);
    expect(results).toEqual([{ state: 2 }, { state: 2 }]);
    expect(done).toBe("done");
    expect(Array.from(events.slice(1, 6))).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(events.slice(7, 10))).toEqual([1, 1, 1]);
    expect(Atomics.load(new Int32Array(destroyStatus), 1)).toBe(2);
  } finally {
    first.terminate();
    second.terminate();
    coordinator.terminate();
  }
});
