import type { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { type ImportObject, instantiate } from "./vfs.js";function snakeToCamel(snakeCaseString) {
	return snakeCaseString
		.toLowerCase()
		.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

export const custom_instantiate = async (
	wasm_module: WebAssembly.Module,
	wasiImport: {
		[key: string]: (...args: unknown[]) => unknown;
	},
	wasiThreadImport: {
		"thread-spawn": (start_arg: number) => number;
	},
	memory: {
		[key: string]: WebAssembly.Memory;
	},
  call_unknown_fn: (idx: number, unknown: unknown) => unknown = (idx, unknown) => {
    console.warn("call_unknown_fn is not set", idx, unknown);
  },
): Promise<WebAssembly.Instance> => {
	const imports = {};
	for (const key in wasiImport) {
		const inner_key = `${snakeToCamel(key)}Import`;
		imports[inner_key] = wasiImport[key];
	}

	const threadSpawnImports = {
		threadSpawnImport: (start_arg) => {
			const tid = wasiThreadImport["thread-spawn"](start_arg);
			return tid;
		},
	};

	let inst: WebAssembly.Instance | undefined = undefined;

	const root = await instantiate(
		(_path) => {
			return wasm_module;
		}, // instantiate has default function if undefined
		{
			"wasip1-vfs:host/virtual-file-system-wasip1-core": {
				Wasip1: imports,
			},
			"wasip1-vfs:host/virtual-file-system-wasip1-threads-import": {
				Wasip1Threads: threadSpawnImports,
			},
      'vfs:host/bridge': {
        Downloader: {
          downloadFileStart: (name_ptr: number, name_len: number) => {
            const view = new Uint8Array(memory.memory.buffer, name_ptr, name_len);
            const bytes = new Uint8Array(view); // copy
            const name = new TextDecoder().decode(bytes);
            console.log("Download file start", { name });
            call_unknown_fn(0, {
              name: "downloadFileStart",
              args: { name },
            });
          },
          downloadFileChunk: (data_ptr: number, data_len: number) => {
            const view = new Uint8Array(memory.memory.buffer, data_ptr, data_len);
            const data = new Uint8Array(view); // copy
            console.log("Download file chunk", { data_len });
            call_unknown_fn(0, {
              name: "downloadFileChunk",
              args: { data },
            });
          },
          downloadFileEnd: () => {
            call_unknown_fn(0, {
              name: "downloadFileEnd",
              args: {},
            });
          },
          sysrootStartFetch: (triple_ptr: number, triple_len: number) => {
            const view = new Uint8Array(memory.memory.buffer, triple_ptr, triple_len);
            const bytes = new Uint8Array(view); // copy
            const triple = new TextDecoder().decode(bytes);
            console.log("Sysroot fetch start", { triple });
            call_unknown_fn(0, {
              name: "sysrootStartFetch",
              args: { triple },
            });
          },
          sysrootGetNextFileMeta: (name_len_ptr: number, data_len_ptr: number): number => {
            const res = call_unknown_fn(0, {
              name: "sysrootGetNextFileMeta",
              args: {},
            }) as { has_file: boolean, is_waiting?: boolean, name_len: number, data_len: number };
            if (res && res.has_file) {
              const view32 = new Int32Array(memory.memory.buffer);
              view32[name_len_ptr / 4] = res.name_len;
              view32[data_len_ptr / 4] = res.data_len;
              return 1;
            } else if (res && res.is_waiting) {
              return 2;
            }
            return 0;
          },
          sysrootReadFileName: (name_ptr: number) => {
            const res = call_unknown_fn(0, {
              name: "sysrootReadFileName",
              args: {},
            }) as { name_bytes: Uint8Array };
            const view = new Uint8Array(memory.memory.buffer);
            view.set(res.name_bytes, name_ptr);
          },
          sysrootReadFileChunk: (data_ptr: number, chunk_len: number) => {
            const res = call_unknown_fn(0, {
              name: "sysrootReadFileChunk",
              args: { chunk_len },
            }) as { data_bytes: Uint8Array };
            const view = new Uint8Array(memory.memory.buffer);
            view.set(res.data_bytes, data_ptr);
          },
        }
      },
		} as ImportObject,
		async (module, imports) => {
			imports.env = {
				...memory,
			};

			inst = await WebAssembly.instantiate(module, imports);
			return inst;
		},
	);

	if (inst === undefined) {
		throw new Error("inst is not an instance");
	}
	inst = inst as WebAssembly.Instance;

	const fake = {
		exports: {
			memory: inst.exports.memory as WebAssembly.Memory,
			_start: () => {
				// init only
				if (root.main) {
					root.main();
				} else if (root._start) {
					root._start();
				} else if (inst.exports._start) {
					(inst.exports._start as Function)();
				} else if (inst.exports.main) {
					(inst.exports.main as Function)();
				}
				console.log("[WASI main] done.");
			},
			wasi_thread_start: (tid, arg) => {
				console.log("[WASI wasi_thread_start] tid", tid, "arg", arg);
				root.virtualFileSystemWasip1ThreadsExport.wasiThreadStart(tid, arg);
			},
		},
	};

    for (const key in root) {
        if (typeof root[key] !== "function") {
            continue;
        }
        fake[key] = root[key].bind(root);
    }

	return fake;
};
