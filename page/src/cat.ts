import type { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { wasi } from "@bjorn3/browser_wasi_shim";

export const get_data = (
  path__: string,
  _animal: WASIFarmAnimal,
): Uint8Array => {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  const animal = _animal as any;

  // path is absolute
  let path = path__;
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  // first: get opened fd dir name
  let root_fd: number;
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
        const [path, ret] = wasi_farm_ref.fd_prestat_dir_name(
          mapped_fd,
          name_len,
        );
        if (ret !== wasi.ERRNO_SUCCESS) {
          continue;
        }
        if (path) {
          const decoded_path = new TextDecoder().decode(path);
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

  if (matched_dir_len === 0) {
    throw new Error("no matched dir");
  }

  console.log("matched_dir_name", dir_names.get(matched_fd));

  // third: tale the rest of path
  const rest_path = parts_path.slice(matched_dir_len).join("/");
  console.log("rest_path", rest_path);

  // fourth: open file
  const [mapped_fd, wasi_farm_ref_n] = animal.get_fd_and_wasi_ref_n(matched_fd);
  const [opened_fd, ret] = animal.wasi_farm_refs[wasi_farm_ref_n].path_open(
    mapped_fd,
    0,
    new TextEncoder().encode(rest_path),
    0,
    0n,
    0n,
    0,
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const mapped_opened_fd = animal.map_new_fd_and_notify(
    opened_fd,
    wasi_farm_ref_n,
  );

  if (ret !== wasi.ERRNO_SUCCESS) {
    throw new Error("failed to open file");
  }

  // fifth: read file
  let file_data: Uint8Array = new Uint8Array();
  let offset = 0n;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log("offset", offset);

    const iovs = new Uint32Array(2);
    // buf_ptr so any value
    iovs[0] = 0;
    // buf_len
    iovs[1] = 1024;
    const [nread_and_buf, ret] = animal.wasi_farm_refs[
      wasi_farm_ref_n
    ].fd_pread(opened_fd, iovs, offset);
    if (ret !== wasi.ERRNO_SUCCESS) {
      throw new Error("failed to read file");
    }
    if (!nread_and_buf) {
      throw new Error("failed to read file");
    }
    const [nread, buf] = nread_and_buf;
    if (nread === 0) {
      break;
    }
    const new_data = new Uint8Array(file_data.length + nread);
    new_data.set(file_data);
    new_data.set(buf, file_data.length);
    file_data = new_data;
    offset += BigInt(nread);
    if (nread < 1024) {
      break;
    }
  }

  animal.wasi_farm_refs[wasi_farm_ref_n].fd_close(opened_fd);

  return file_data;
};
