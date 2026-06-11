import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI } from "https://esm.sh/@bjorn3/browser_wasi_shim@0.3.0";
import { instantiate } from "./page/src/worker_process/vfs_bindings/vfs.js";

const wasmPath = "./dist/vfs.core.wasm";

function snakeToCamel(snakeCaseString: string) {
	return snakeCaseString
		.toLowerCase()
		.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

async function runTest() {
    console.log("Starting Panic test...");

    const args = ["vfs.wasm"];
    const env = ["HOME=/"];
    const fds = [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered((msg) => console.log(`[STDOUT] ${msg}`)),
        ConsoleStdout.lineBuffered((msg) => console.warn(`[STDERR] ${msg}`)),
    ];

    const wasi = new WASI(args, env, fds);
    const wasmBytes = await Deno.readFile(wasmPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    const wasip1Imports: any = {};
    for (const key in wasi.wasiImport) {
        const inner_key = `${snakeToCamel(key)}Import`;
        wasip1Imports[inner_key] = (wasi.wasiImport as any)[key];
    }

    const root = await instantiate(
        () => wasmModule,
        {
            "wasip1-vfs:host/virtual-file-system-wasip1-core": {
                Wasip1: wasip1Imports,
            },
            "wasip1-vfs:host/virtual-file-system-wasip1-threads-import": {
                Wasip1Threads: {
                    threadSpawnImport: (start_arg: number) => {
                        console.log("Thread spawn requested.");
                        return -1;
                    }
                },
            },
            "vfs:host/bridge": {
                callUnknownFn: (name: string, payload: Uint8Array) => {
                    return new Uint8Array();
                },
                Downloader: {
                    sysrootGetNextFileMeta: () => [0, 0, 0],
                    sysrootReadFileChunk: () => {},
                    sysrootReadFileName: () => "",
                    sysrootStartFetch: () => {},
                    downloadFileStart: () => {},
                    downloadFileChunk: () => {},
                    downloadFileEnd: () => {},
                },
                Lsp: {
                    start: () => {},
                    sendMsg: () => {},
                    receiveMsg: () => "",
                    stop: () => {},
                },
                Terminal: {
                    print: () => {},
                    printErr: () => {},
                    prompt: () => "",
                }
            }
        } as any,
        async (module, imports) => {
            return await WebAssembly.instantiate(module, imports);
        },
    );

    console.log("\n--- Running 'rustc' in VFS ---");
    try {
        const res = root.runCommand(["rustc"]);
        console.log("Command finished normally. Result:", res);
        
        console.log("Running another command to check if VFS is still alive...");
        root.runCommand(["ls"]);
        console.log("VFS is still alive!");
    } catch (e) {
        console.error("VFS crashed or threw an error:", e);
    }
}

runTest().catch(console.error);