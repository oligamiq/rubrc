import type { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import {
  sysrootArchiveMetaStatus,
  type SysrootArchiveMetaResponse,
  validateExactSysrootChunk,
} from "../../sysroot_protocol.ts";
import { traceVfsHostCall } from "../../vfs_debug_trace.ts";
import { createChildProcessImports } from "./child_process_import.ts";
import { createHttpImports } from "./http_import.ts";
import { type ImportObject, type Root, instantiate } from "./vfs.js";function snakeToCamel(snakeCaseString: string) {
	return snakeCaseString
		.toLowerCase()
		.replace(/_([a-z])/g, (_match: string, letter: string) => letter.toUpperCase());
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

type VfsInstanceExports = WebAssembly.Exports & {
	memory: WebAssembly.Memory;
	_start: () => unknown;
	wasi_thread_start: (tid: number, arg: number) => unknown;
};

export type VfsInstance = WebAssembly.Instance & Root & {
	exports: VfsInstanceExports;
};

const tracedHostCallNames = new Set([
  "sysrootStartFetch",
  "sysrootArchiveGetMeta",
  "sysrootReadArchiveChunk",
  "hostRunCargo",
]);

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
): Promise<VfsInstance> => {
  const debugTraceEnabled = import.meta.env?.VITE_RUBRC_LSP_TEST === "1";
  let hostCallId = 0;
  const tracedCallUnknownFn = (idx: number, unknown: unknown): unknown => {
    const name =
      typeof unknown === "object" && unknown !== null
        ? (unknown as { name?: unknown }).name
        : undefined;
    if (
      debugTraceEnabled &&
      typeof name === "string" &&
      tracedHostCallNames.has(name)
    ) {
      return traceVfsHostCall(
        ++hostCallId,
        name,
        (line) => console.debug("[vfs-stall-trace]", line),
        () => call_unknown_fn(idx, unknown),
      );
    }
    return call_unknown_fn(idx, unknown);
  };
	const imports: Record<string, (...args: unknown[]) => unknown> = {};
	for (const key in wasiImport) {
		const inner_key = `${snakeToCamel(key)}Import`;
		imports[inner_key] = wasiImport[key];
	}

	const threadSpawnImports = {
		threadSpawnImport: (start_arg: number) => {
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
            const view = new Uint8Array(memory.memory.buffer, name_ptr >>> 0, name_len >>> 0);
            const bytes = new Uint8Array(view); // copy
            const name = new TextDecoder().decode(bytes);
            console.log("Download file start", { name });
            call_unknown_fn(0, {
              name: "downloadFileStart",
              args: { name },
            });
          },
          downloadFileChunk: (data_ptr: number, data_len: number) => {
            const view = new Uint8Array(memory.memory.buffer, data_ptr >>> 0, data_len >>> 0);
            const data = new Uint8Array(view); // copy
            console.log("Download file chunk", { data_len });
            call_unknown_fn(0, {
              name: "downloadFileChunk",
              args: { data: Array.from(data) },
            });
          },
          downloadFileEnd: () => {
            call_unknown_fn(0, {
              name: "downloadFileEnd",
              args: {},
            });
          },
          sysrootStartFetch: (triple_ptr: number, triple_len: number) => {
            const view = new Uint8Array(memory.memory.buffer, triple_ptr >>> 0, triple_len >>> 0);
            const bytes = new Uint8Array(view); // copy
            const triple = new TextDecoder().decode(bytes);
            console.log("Sysroot fetch start", { triple });
            tracedCallUnknownFn(0, {
              name: "sysrootStartFetch",
              args: { triple },
            });
          },
          sysrootGetArchiveMeta: (data_len_ptr: number): number => {
            const res = tracedCallUnknownFn(0, {
              name: "sysrootArchiveGetMeta",
              args: {},
            }) as SysrootArchiveMetaResponse;
            console.log("sysrootArchiveGetMeta returned", res);
            const view32 = new Int32Array(memory.memory.buffer);
            const status = sysrootArchiveMetaStatus(res);

            if (status === 1) {
              view32[(data_len_ptr >>> 0) / 4] = res.data_len!;
            }
            return status;
          },
          sysrootReadArchiveChunk: (data_ptr: number, chunk_len: number): void => {
            const res = tracedCallUnknownFn(0, {
              name: "sysrootReadArchiveChunk",
              args: { chunk_len },
            }) as { chunk: unknown };
            const chunk_bytes = validateExactSysrootChunk(
              _toUint8Array(res?.chunk),
              chunk_len,
            );
            const view8 = new Uint8Array(memory.memory.buffer);
            view8.set(chunk_bytes, data_ptr >>> 0);
          },
        },
        ChildProcess: createChildProcessImports(memory, call_unknown_fn),
        Http: createHttpImports(memory, call_unknown_fn),
        Terminal: {
          terminalWrite: (session_id: number, data_ptr: number, data_len: number) => {
            const view = new Uint8Array(memory.memory.buffer, data_ptr >>> 0, data_len >>> 0);
            const data = new Uint8Array(view); // copy
            call_unknown_fn(0, {
              name: "terminalWrite",
              args: { session_id, data: Array.from(data) },
            });
          }
        },
        Lsp: {
          hostRunCargo: (req_ptr: number, req_len: number, out_stdout_ptr: number, out_stdout_len: number, out_stderr_ptr: number, out_stderr_len: number, out_status: number): number => {
            const view = new Uint8Array(memory.memory.buffer, req_ptr >>> 0, req_len >>> 0);
            const req = new TextDecoder().decode(view);
            const res = tracedCallUnknownFn(0, {
              name: "hostRunCargo",
              args: { req },
            }) as { stdout: unknown, stderr: unknown, status: number };
            const stdoutBytes = _toUint8Array(res.stdout);
            const stderrBytes = _toUint8Array(res.stderr);

            let stdout_ptr = 0;
            let stderr_ptr = 0;

            if (stdoutBytes.length > 0) {
              stdout_ptr = root.allocBuf(stdoutBytes.length);
              const view8 = new Uint8Array(memory.memory.buffer);
              view8.set(stdoutBytes, stdout_ptr >>> 0);
            }
            if (stderrBytes.length > 0) {
              stderr_ptr = root.allocBuf(stderrBytes.length);
              const view8 = new Uint8Array(memory.memory.buffer);
              view8.set(stderrBytes, stderr_ptr >>> 0);
            }

            const view32 = new Int32Array(memory.memory.buffer);
            view32[(out_stdout_ptr >>> 0) / 4] = stdout_ptr;
            view32[(out_stdout_len >>> 0) / 4] = stdoutBytes.length;
            view32[(out_stderr_ptr >>> 0) / 4] = stderr_ptr;
            view32[(out_stderr_len >>> 0) / 4] = stderrBytes.length;
            view32[(out_status >>> 0) / 4] = res.status;

            return 0; // success
          },
          hostFreeMemory: (ptr: number, len: number) => {
             if (ptr !== 0) {
               root.freeBuf(ptr, len);
             }
          }
        }
      },
		} as unknown as ImportObject,
		async (module, imports) => {
			imports.env = {
				...memory,
			};

			inst = await WebAssembly.instantiate(module, imports);
			return inst;
		},
	);

	const coreInstance = inst as WebAssembly.Instance | undefined;
	if (coreInstance === undefined) {
		throw new Error("inst is not an instance");
	}
	const coreExports = coreInstance.exports as WebAssembly.Exports & {
		memory: WebAssembly.Memory;
	};

	const fake = {
		exports: {
			memory: coreExports.memory,
			_start: () => {
				root.main();
				console.log("[WASI main] done.");
			},
			wasi_thread_start: (tid: number, arg: number) => {
				console.log("[WASI wasi_thread_start] tid", tid, "arg", arg);
				root.virtualFileSystemWasip1ThreadsExport.wasiThreadStart(tid, arg);
			},
		},
	} as VfsInstance;

	for (const [key, value] of Object.entries(root)) {
		(fake as unknown as Record<string, unknown>)[key] =
			typeof value === "function" ? value.bind(root) : value;
	}

	return fake;
};
