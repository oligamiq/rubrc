import type { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { type ImportObject, instantiate } from "./vfs.js";function snakeToCamel(snakeCaseString) {
	return snakeCaseString
		.toLowerCase()
		.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

// call_unknown_fn serializes Uint8Array as plain objects {0: v, 1: v, ...}.
// This helper converts any serialized form back to a proper Uint8Array.
function _toUint8Array(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) {
		return data;
	}
	if (data && (data as any).buffer instanceof ArrayBuffer) {
		return new Uint8Array((data as any).buffer);
	}
	if (Array.isArray(data)) {
		return new Uint8Array(data);
	}
	if (typeof data === 'object' && data !== null) {
		const vals = Object.values(data) as number[];
		return new Uint8Array(vals);
	}
	return new Uint8Array();
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
            }) as { has_file: boolean | number, name_len?: number, data_len?: number };
            const view32 = new Int32Array(memory.memory.buffer);

            if (res.has_file === 1 || res.has_file === true) {
              view32[name_len_ptr / 4] = res.name_len!;
              view32[data_len_ptr / 4] = res.data_len!;
            }
            return res.has_file ? 1 : 0;
          },
          sysrootReadFileName: (name_ptr: number): void => {
            const res = call_unknown_fn(0, {
              name: "sysrootReadFileName",
              args: {},
            }) as { name: unknown };
            const name_bytes = _toUint8Array(res.name);
            const view8 = new Uint8Array(memory.memory.buffer);
            view8.set(name_bytes, name_ptr);
          },
          sysrootReadFileChunk: (data_ptr: number, chunk_len: number): void => {
            const res = call_unknown_fn(0, {
              name: "sysrootReadFileChunk",
              args: { chunk_len },
            }) as { chunk: unknown };
            const chunk_bytes = _toUint8Array(res.chunk);
            const view8 = new Uint8Array(memory.memory.buffer);
            view8.set(chunk_bytes, data_ptr);
          },
        },
        Terminal: {
          terminalWrite: (session_id: number, data_ptr: number, data_len: number) => {
            const view = new Uint8Array(memory.memory.buffer, data_ptr, data_len);
            const data = new Uint8Array(view); // copy
            call_unknown_fn(0, {
              name: "terminalWrite",
              args: { session_id, data },
            });
          }
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
