import { File, OpenFile, PreopenDirectory, WASI } from "https://esm.sh/@bjorn3/browser_wasi_shim@0.3.0";
import { instantiate } from "./page/src/worker_process/vfs_bindings/vfs.js";

const wasmPath = "./page/src/worker_process/vfs_bindings/vfs.core.wasm";
const LSP_SESSION_ID = 0xFFFFFFFF;

function snakeToCamel(snakeCaseString: string) {
	return snakeCaseString
		.toLowerCase()
		.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

async function runLspTest() {
    console.log("Starting LSP CLI Test...");

    const testDir = "./lsp_test_workspace";
    try { await Deno.remove(testDir, { recursive: true }); } catch {}
    await Deno.mkdir(testDir, { recursive: true });

    const args = ["vfs.core.wasm"];
    const env = ["HOME=/", "VFS_THREADS=1"];
    const fds = [
        new OpenFile(new File([])), // stdin
        new OpenFile(new File([])), // stdout
        new OpenFile(new File([])), // stderr
        new PreopenDirectory(testDir, new Map()),
    ];

    const wasi = new WASI(args, env, fds);
    const wasmBytes = await Deno.readFile(wasmPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    const wasip1Imports: any = {};
    for (const key in wasi.wasiImport) {
        const inner_key = `${snakeToCamel(key)}Import`;
        wasip1Imports[inner_key] = (wasi.wasiImport as any)[key];
    }

    const memory = new WebAssembly.Memory({
        initial: 127,
        maximum: 32775,
        shared: true,
    });

    let lspResponseReceived = false;

    const root = await instantiate(
        () => wasmModule,
        {
            "wasip1-vfs:host/virtual-file-system-wasip1-core": {
                Wasip1: wasip1Imports,
            },
            "wasip1-vfs:host/virtual-file-system-wasip1-threads-import": {
                Wasip1Threads: {
                    threadSpawnImport: (start_arg: number) => {
                        console.log("[Test] Thread spawn requested. start_arg:", start_arg);
                        return -1; 
                    }
                },
            },
            "vfs:host/bridge": {
                Terminal: {
                    terminalWrite: (sessionId: number, ptr: number, len: number) => {
                        const view = new Uint8Array(memory.buffer, ptr, len);
                        const data = new TextDecoder().decode(view);
                        console.log(`[Test] Terminal Write (session ${sessionId}):`, data);
                        if (sessionId === LSP_SESSION_ID) {
                            lspResponseReceived = true;
                        }
                    }
                },
                Downloader: {
                    downloadFileStart: () => {},
                    downloadFileChunk: () => {},
                    downloadFileEnd: () => {},
                    sysrootStartFetch: () => {},
                    sysrootGetNextFileMeta: () => 0,
                    sysrootReadFileName: () => {},
                    sysrootReadFileChunk: () => {},
                }
            }
        } as any,
        async (module, imports) => {
            imports.env = { memory };
            const instance = await WebAssembly.instantiate(module, imports);
            wasi.inst = instance; // SET INSTANCE HERE
            return instance;
        },
    );

    console.log("Component instantiated.");

    // Initialize VFS
    if (root.main) root.main();

    // Start LSP session
    console.log("\n--- Sending LSP Initialize Request ---");
    const initializeRequest = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            processId: null,
            rootUri: "file:///",
            capabilities: {}
        }
    });

    const bytes = new TextEncoder().encode(initializeRequest);
    const ptr = root.allocBuf(bytes.length);
    const view = new Uint8Array(memory.buffer);
    view.set(bytes, ptr);

    // Dispatch LSP message (eventType 6 is EVENT_TYPE_LSP)
    console.log(`Dispatching to session ${LSP_SESSION_ID}...`);
    root.dispatch(LSP_SESSION_ID, 6, ptr, bytes.length);
    root.freeBuf(ptr, bytes.length);

    // Wait a bit for LSP thread to start and respond
    console.log("Waiting for LSP response...");
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (lspResponseReceived) break;
    }

    if (lspResponseReceived) {
        console.log("\nSUCCESS: LSP response received!");
    } else {
        console.log("\nFAILURE: No LSP response received.");
        console.log("Note: This might be because thread spawning is not fully simulated in this CLI test.");
    }

    console.log("\nTest completed!");
}

runLspTest().catch(console.error);
