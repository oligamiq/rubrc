import { thread_spawn_on_worker, type WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "./common.ts";
import { custom_instantiate } from "./inst.ts";

await set_fake_worker();

let animal: WASIFarmAnimal | undefined = undefined;

globalThis.onmessage = async (event) => {
	thread_spawn_on_worker(
		event.data,
		async (
			thread_spawn_wasm: WebAssembly.Module,
			imports: {
				env: {
					[key: string]: WebAssembly.Memory;
				};
				wasi: { "thread-spawn": (start_arg: number) => number };
				// biome-ignore lint/suspicious/noExplicitAny: <explanation>
				wasi_snapshot_preview1: { [key: string]: (...args: any[]) => unknown };
			},
		) => {
			return custom_instantiate(
				thread_spawn_wasm,
				imports.wasi_snapshot_preview1,
				imports.wasi,
				imports.env,
                (idx, unknown) => {
                    if (!animal) {
                        console.warn("Animal is not set yet", idx, unknown);
                        return;
                    }
                    animal.call_unknown_fn(idx, unknown);
                },
			);
		},
		(new_animal) => {
			animal = new_animal;
		}
	);
};