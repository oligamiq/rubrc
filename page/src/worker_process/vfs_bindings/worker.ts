import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "./common.ts";
import { custom_instantiate } from "./inst.ts";

await set_fake_worker();

const isNode =
	(typeof process !== "undefined" && !!process.versions?.node) ||
	(typeof Deno !== "undefined");
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
let _fs: any = null;
async function fetchCompile(url) {
    if (isNode) {
        _fs = _fs || (await import("node:fs/promises"));
        return WebAssembly.compile(await _fs.readFile(new URL(url, import.meta.url)));
    }
    return fetch(url).then(WebAssembly.compileStreaming);
}

globalThis.onmessage = async (message) => {
	const { wasi_ref } = message.data;

	const wasm_path = "./vfs.core.wasm";
	const wasm = await fetchCompile(wasm_path);

	const args = ["bin", "arg1", "arg2"];
	const env = ["FOO=bar"];

	const wasi = new WASIFarmAnimal(
		wasi_ref,
		args, // args
		env, // env
		{
			can_thread_spawn: true,
			thread_spawn_worker_url: "./thread_spawn.ts",
			thread_spawn_wasm: wasm,
			worker_background_worker_url: "./worker_background_worker.ts",
            share_memory: {
                memory: new WebAssembly.Memory({
                    initial:74,
                    maximum:32779,
                    shared:true,
                }),
            },
        },
	);

	await wasi.wait_worker_background_worker();

	const root = await custom_instantiate(
		wasm,
		wasi.wasiImport,
		wasi.wasiThreadImport,
		wasi.get_share_memory(),
	);

	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	wasi.start(root as any);

    globalThis.process?.exit(0);
    globalThis.Deno?.exit(0);
};