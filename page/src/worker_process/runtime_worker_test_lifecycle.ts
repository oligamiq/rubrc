import "./lifecycle_worker.ts";

globalThis.postMessage({ type: "fixture-ready", worker: "lifecycle" });
