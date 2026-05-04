import type { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { wasi } from "@bjorn3/browser_wasi_shim";

/**
 * Write data to a file in the WASI filesystem (inverse of get_data in cat.ts).
 * Creates or overwrites the file at the given absolute path.
 */
export const write_data = (
	path__: string,
	data: Uint8Array,
	_animal: WASIFarmAnimal,
): void => {
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	const animal = _animal as any;

	// path is absolute
	let path = path__;
	if (!path.startsWith("/")) {
		path = `/${path}`;
	}

	// first: get opened fd dir name
	let root_fd: number | undefined;
	const dir_names: Map<number, string> = new Map();
	for (let fd = 0; fd < animal.fd_map.length; fd++) {
		const [mapped_fd, wasi_farm_ref] = animal.get_fd_and_wasi_ref(fd);
		if (mapped_fd === undefined || wasi_farm_ref === undefined) {
			continue;
		}
		const [prestat, ret] = wasi_farm_ref.fd_prestat_get(mapped_fd);
		if (ret !== wasi.ERRNO_SUCCESS) {
			continue;
		}
		if (prestat) {
			const [tag, name_len] = prestat;
			if (tag === wasi.PREOPENTYPE_DIR) {
				const [path_buf, ret] = wasi_farm_ref.fd_prestat_dir_name(
					mapped_fd,
					name_len,
				);
				if (ret !== wasi.ERRNO_SUCCESS) {
					continue;
				}
				if (path_buf) {
					const decoded_path = new TextDecoder().decode(path_buf);
					dir_names.set(fd, decoded_path);
					if (decoded_path === "/") {
						root_fd = fd;
					}
				}
			}
		}
	}

	// second: most match path
	let matched_fd = root_fd;
	let matched_dir_len = 1;
	const parts_path = path.split("/");
	for (const [fd, dir_name] of dir_names) {
		const parts_dir_name = dir_name.split("/");
		let dir_len = 0;
		for (let i = 0; i < parts_dir_name.length; i++) {
			if (parts_dir_name[i] === parts_path[i]) {
				dir_len++;
			} else {
				break;
			}
		}
		if (dir_len > matched_dir_len) {
			matched_fd = fd;
			matched_dir_len = dir_len;
		}
	}

	if (matched_fd === undefined || matched_dir_len === 0) {
		throw new Error("no matched dir");
	}

	// third: get the rest of path
	const rest_path = parts_path.slice(matched_dir_len).join("/");

	// fourth: ensure parent directories exist and open file with O_CREAT | O_TRUNC
	const [mapped_fd, wasi_farm_ref_n] =
		animal.get_fd_and_wasi_ref_n(matched_fd);
	const oflags = wasi.OFLAGS_CREAT | wasi.OFLAGS_TRUNC;
	const rights_base =
		BigInt(wasi.RIGHTS_FD_WRITE) | BigInt(wasi.RIGHTS_FD_SEEK);
	const rights_inheriting = 0n;
	const fdflags = 0;

	const [opened_fd, ret] = animal.wasi_farm_refs[wasi_farm_ref_n].path_open(
		mapped_fd,
		0, // dirflags
		new TextEncoder().encode(rest_path),
		oflags,
		rights_base,
		rights_inheriting,
		fdflags,
	);

	if (ret !== wasi.ERRNO_SUCCESS) {
		throw new Error(`failed to open file for writing: ${rest_path} (errno: ${ret})`);
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const mapped_opened_fd = animal.map_new_fd_and_notify(
		opened_fd,
		wasi_farm_ref_n,
	);

	// fifth: write data
	let offset = 0;
	while (offset < data.length) {
		const chunk = data.slice(offset, offset + 4096);
		const iovs = new Uint32Array(2);
		iovs[0] = 0; // buf_ptr (managed by wasi_farm_ref)
		iovs[1] = chunk.length;

		const [nwritten, write_ret] = animal.wasi_farm_refs[
			wasi_farm_ref_n
		].fd_write(opened_fd, chunk);

		if (write_ret !== wasi.ERRNO_SUCCESS) {
			animal.wasi_farm_refs[wasi_farm_ref_n].fd_close(opened_fd);
			throw new Error(`failed to write file: ${rest_path}`);
		}
		offset += nwritten;
	}

	// sixth: close file
	animal.wasi_farm_refs[wasi_farm_ref_n].fd_close(opened_fd);
};
