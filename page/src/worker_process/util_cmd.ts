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

/**
 * List all files recursively under a given directory fd in the WASI filesystem.
 * Returns an array of { path, content } entries.
 */
function listFilesRecursive(
	animal: any,
	base_fd: number,
	wasi_farm_ref_n: number,
	base_path: string,
): { path: string; content: Uint8Array }[] {
	const results: { path: string; content: Uint8Array }[] = [];

	// Read directory entries
	const mapped_fd_info = animal.get_fd_and_wasi_ref_n(base_fd);
	if (!mapped_fd_info) return results;

	const [mapped_fd] = mapped_fd_info;

	// Try to read directory contents using fd_readdir
	const buf_size = 4096;
	const [dir_entries, readdir_ret] = animal.wasi_farm_refs[
		wasi_farm_ref_n
	].fd_readdir(mapped_fd, buf_size, 0n);

	if (readdir_ret !== wasi.ERRNO_SUCCESS || !dir_entries) {
		return results;
	}

	// Parse directory entries from the buffer
	let offset = 0;
	const buf = dir_entries;
	while (offset + 24 <= buf.length) {
		// dirent structure: d_next(8) + d_ino(8) + d_namlen(4) + d_type(1) = 25 bytes header
		// But aligned, the standard WASI dirent is 24 bytes
		const d_namlen = buf[offset + 16] | (buf[offset + 17] << 8) | (buf[offset + 18] << 16) | (buf[offset + 19] << 24);
		const d_type = buf[offset + 20];

		if (offset + 24 + d_namlen > buf.length) break;

		const name = new TextDecoder().decode(buf.slice(offset + 24, offset + 24 + d_namlen));
		offset += 24 + d_namlen;

		// Skip . and ..
		if (name === "." || name === "..") continue;

		const full_path = base_path ? `${base_path}/${name}` : name;

		if (d_type === 4) {
			// Directory - recurse
			// Open the sub-directory
			const [sub_fd, open_ret] = animal.wasi_farm_refs[wasi_farm_ref_n].path_open(
				mapped_fd,
				0,
				new TextEncoder().encode(name),
				wasi.OFLAGS_DIRECTORY,
				0n,
				0n,
				0,
			);
			if (open_ret === wasi.ERRNO_SUCCESS) {
				const sub_mapped_fd = animal.map_new_fd_and_notify(sub_fd, wasi_farm_ref_n);
				const sub_results = listFilesRecursive(animal, sub_mapped_fd, wasi_farm_ref_n, full_path);
				results.push(...sub_results);
				animal.wasi_farm_refs[wasi_farm_ref_n].fd_close(sub_fd);
			}
		} else {
			// File - read content
			try {
				const abs_path = base_path ? `/${base_path}/${name}` : `/${name}`;
				const content = get_data(abs_path, animal);
				results.push({ path: abs_path, content });
			} catch (e) {
				console.warn(`Failed to read file for sync: ${full_path}`, e);
			}
		}
	}

	return results;
}

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

	// --- Sync functions ---

	/**
	 * Sync files from TS WASI filesystem → Rust VFS.
	 * Reads all files from the TS filesystem and sends them to the Rust VFS via flushToVfs.
	 */
	const syncToRust = () => {
		try {
			const files: { path: string; content: Uint8Array }[] = [];

			// Iterate over all preopen directories and collect files
			for (let fd = 0; fd < animal.fd_map.length; fd++) {
				const fd_info = animal.get_fd_and_wasi_ref(fd);
				if (!fd_info) continue;
				const [mapped_fd, wasi_farm_ref] = fd_info;
				if (mapped_fd === undefined || wasi_farm_ref === undefined) continue;

				const [prestat, ret] = wasi_farm_ref.fd_prestat_get(mapped_fd);
				if (ret !== wasi.ERRNO_SUCCESS || !prestat) continue;

				const [tag, name_len] = prestat;
				if (tag !== wasi.PREOPENTYPE_DIR) continue;

				const [path_buf, dir_ret] = wasi_farm_ref.fd_prestat_dir_name(mapped_fd, name_len);
				if (dir_ret !== wasi.ERRNO_SUCCESS || !path_buf) continue;

				const dir_path = new TextDecoder().decode(path_buf);
				const [, wasi_farm_ref_n] = animal.get_fd_and_wasi_ref_n(fd);

				const dir_files = listFilesRecursive(animal, fd, wasi_farm_ref_n, dir_path === "/" ? "" : dir_path.replace(/^\//, ""));
				files.push(...dir_files);
			}

			if (files.length > 0) {
				console.log(`syncToRust: syncing ${files.length} files`);
				vfs_root.flushToVfs(files);
			}
		} catch (e) {
			console.error("syncToRust failed:", e);
		}
	};

	/**
	 * Sync files from Rust VFS → TS WASI filesystem.
	 * Retrieves all files from the Rust VFS and writes them to the TS filesystem.
	 */
	const syncFromRust = () => {
		try {
			const files = vfs_root.flushFromVfs();
			if (files.length > 0) {
				console.log(`syncFromRust: syncing ${files.length} files`);
			}
			for (const file of files) {
				try {
					write_data(file.path, file.content, animal);
				} catch (e) {
					console.warn(`syncFromRust: failed to write ${file.path}:`, e);
				}
			}
		} catch (e) {
			console.error("syncFromRust failed:", e);
		}
	};

	// --- Command delegation ---
	shared.push(
		new SharedObject((...args: string[]) => {
			(async () => {
				try {
					// Sync TS → Rust before command processing
					syncToRust();

					const request = vfs_root.runCommand(args);

					// Sync Rust → TS after command processing
					syncFromRust();

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
						syncToRust();

						animal.start(inst);

						// --- After Wasm execution: Rust → TS ---
						syncFromRust();

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
