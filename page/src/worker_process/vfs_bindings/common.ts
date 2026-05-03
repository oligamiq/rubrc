// biome-ignore lint/suspicious/noExplicitAny: <explanation>
let _worker: any = null;
const set_fake_worker = async () => {
	if (
		(typeof process !== "undefined" &&
			process.versions &&
			process.versions.node &&
            typeof Deno === "undefined")
	) {
		_worker = _worker || (await import("node:worker_threads"));
		const { Worker, isMainThread, parentPort } = _worker;

        class FakeWorker {
            worker;
            onmessage;

            constructor(url) {
                let absolute_url;
                if (url instanceof URL) {
                    absolute_url = url;
                } else {
                    absolute_url = new URL(url, import.meta.url);
                }
                this.worker = new Worker(absolute_url, {
                    type: "module",
                });

                this.worker.on("message", (message) => {
                    if (this.onmessage) {
                        this.onmessage({ data: message });
                    }
                });
            }
            postMessage(message) {
                this.worker.postMessage(message);
            }
        }

		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		(globalThis as any).Worker = FakeWorker;
	}
};

export { set_fake_worker };