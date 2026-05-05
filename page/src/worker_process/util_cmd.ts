import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { wasi } from "@bjorn3/browser_wasi_shim";
import type { Ctx } from "../ctx";
import { get_data } from "../cat";
import { write_data } from "../write_data";
import { custom_instantiate } from "./vfs_bindings/inst";
import { set_fake_worker } from "./vfs_bindings/common";

import thread_spawn_path from "./vfs_bindings/thread_spawn.ts?worker&url";
import worker_background_worker_url from "./vfs_bindings/worker_background_worker.ts?worker&url";

await set_fake_worker();

const shared: SharedObject[] = [];

globalThis.addEventListener("message", async (event) => {
	const {
		wasi_refs,
		ctx,
	}: {
		wasi_refs: any[];
		ctx: Ctx;
	} = event.data;

	console.log("loading virtualized vfs component");

	const terminal = new SharedObjectRef(ctx.terminal_id).proxy<
		(string: string) => Promise<void>
	>();
	const waiter = new SharedObjectRef(ctx.waiter_id).proxy<{
		set_end_of_exec: (_end_of_exec: boolean) => Promise<void>;
	}>();
	const download_by_url = new SharedObjectRef(ctx.download_by_url_id).proxy<
		(url: string, name: string) => Promise<void>
	>();

	const vfs_wasm_path = new URL("./vfs_bindings/vfs.core.wasm", import.meta.url).href;
	const vfs_wasm = await fetch(vfs_wasm_path).then(WebAssembly.compileStreaming);

	const animal = new WASIFarmAnimal(
		wasi_refs,
		[], // args
		[], // env
		{
			can_thread_spawn: true,
			thread_spawn_worker_url: new URL(thread_spawn_path, import.meta.url).href,
			thread_spawn_wasm: vfs_wasm,
			worker_background_worker_url: new URL(worker_background_worker_url, import.meta.url).href,
			share_memory: {
				memory: new WebAssembly.Memory({
					initial: 83,
					maximum: 32775,
					shared: true,
				}),
			},
		}
	);

	await animal.wait_worker_background_worker();

	const vfs_root = await custom_instantiate(
		vfs_wasm,
		animal.wasiImport as any,
		animal.wasiThreadImport as any,
		animal.get_share_memory(),
	);

	console.log("vfs component instantiated", vfs_root);

	// Initialize VFS component (runs its main function which sets up thread pool etc.)
	animal.start(vfs_root as any);

	// --- Command delegation ---
	shared.push(
		new SharedObject((...args: string[]) => {
			(async () => {
				try {
					// Sync TS → Rust before command processing
					vfs_root.flushToVfs();

					const request = vfs_root.runCommand(args);

					// Sync Rust → TS after command processing
					vfs_root.flushFromVfs();

					if (request.tag === 'handled') {
						// Done
					} else if (request.tag === 'exec-file') {
						const [exec_file, exec_args] = request.val;

						// Read the file from TS WASI filesystem
						const file = get_data(exec_file, animal);
						const compiled_wasm = await WebAssembly.compile(file);
						const inst = (await WebAssembly.instantiate(compiled_wasm, {
							wasi_snapshot_preview1: animal.wasiImport,
						})) as any;
						animal.args = [exec_file, ...exec_args];

						// --- Before Wasm execution: TS → Rust ---
						vfs_root.flushToVfs();

						animal.start(inst);

						// --- After Wasm execution: Rust → TS ---
						vfs_root.flushFromVfs();

					} else if (request.tag === 'download') {
						const file_path = request.val;
						const file_data = get_data(file_path, animal);
						const blob = new Blob([file_data]);
						const url = URL.createObjectURL(blob);
						await download_by_url(url, file_path.split("/").pop() || "download");
						URL.revokeObjectURL(url);
					} else if (request.tag === 'not-found') {
						await terminal(`command not found: ${request.val}\r\n`);
					}
				} catch (e) {
					await terminal(`Error: ${e}\r\n`);
				}
				await waiter.set_end_of_exec(true);
			})();
		}, ctx.exec_file_id),
	);

	// Keep other shared objects for backward compatibility
	shared.push(new SharedObject((...args: string[]) => {
		(async () => {
			const delegated = new SharedObjectRef(ctx.exec_file_id).proxy<(...a: string[]) => Promise<void>>();
			await delegated("ls", ...args);
		})();
	}, ctx.ls_id));

	shared.push(new SharedObject((...args: string[]) => {
		(async () => {
			const delegated = new SharedObjectRef(ctx.exec_file_id).proxy<(...a: string[]) => Promise<void>>();
			await delegated("tree", ...args);
		})();
	}, ctx.tree_id));
});