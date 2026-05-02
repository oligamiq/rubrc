// deno run --allow-read --allow-env dist/test_run.ts

import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim";

// Catch the leaked promise rejection from jco task wrappers on proc_exit
globalThis.addEventListener("unhandledrejection", (e) => {
    if (e.reason instanceof Error && e.reason.message.includes("exit with exit code 0")) {
        e.preventDefault();
    }
});

    import { instantiate } from "./vfs.js";
const args = ["bin", "arg1", "arg2"];
const env = ["FOO=bar"];
const fds = [
	new OpenFile(new File([])), // stdin
	ConsoleStdout.lineBuffered((msg) => console.log(`[WASI stdout] ${msg}`)),
	ConsoleStdout.lineBuffered((msg) => console.warn(`[WASI stderr] ${msg}`)),
	new PreopenDirectory(".", new Map()),
];
const wasi = new WASI(args, env, fds);

let inst: WebAssembly.Instance | undefined = undefined;

function snakeToCamel(snakeCaseString) {
    return snakeCaseString.toLowerCase().replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

const imports = {};
for (const key in wasi.wasiImport) {
    const inner_key = `${snakeToCamel(key)}Import`;
    imports[inner_key] = (...args) => {
        // console.log(`[WASI ${inner_key}]`, ...args);
        const ret = wasi.wasiImport[key](...args);
        // console.log(`[WASI ${inner_key}] ret`, ret);
        return ret;
    }
}
console.log(imports);


const root = await instantiate(undefined, {
	"wasip1-vfs:host/virtual-file-system-wasip1-core": {
        Wasip1: imports,
    }
}, async (module, imports) => {
    inst = await WebAssembly.instantiate(module, imports);
    return inst;
});

if (inst === undefined) {
    throw new Error("inst is not an instance");
}
inst = inst as WebAssembly.Instance;

let p;
try {
    wasi.start({
        exports: {
            memory: inst.exports.memory as WebAssembly.Memory,
            _start: () => {
                // init only
                console.log("[WASI main]");
                if (root.main) {
                    p = root.main();
                } else if (root._start) {
                    p = root._start();
                } else if (inst.exports._start) {
                    p = (inst.exports._start as Function)();
                } else if (inst.exports.main) {
                    p = (inst.exports.main as Function)();
                }
                console.log("[WASI main] done.");
            }
        },
    });
} catch (e) {
    // Ignore proc_exit errors (exit code 0 is success)
    if (e instanceof Error && e.message.includes("exit with exit code 0")) {
        // Expected behavior - normal exit
    } else {
        throw e;
    }
}

if (p) {
    await Promise.resolve(p).catch((e: any) => {
        if (e instanceof Error && e.message.includes("exit with exit code 0")) {
            // Expected behavior - normal exit
        } else {
            throw e;
        }
    });
}
