import { type ImportObject, instantiate } from "./vfs.js"; function snakeToCamel(snakeCaseString) {
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
