import { File, OpenFile, WASI } from "@bjorn3/browser_wasi_shim";
import { custom_instantiate } from "./page/src/worker_process/vfs_bindings/inst.ts";

const wasmPath = "./page/src/worker_process/vfs_bindings/vfs.core.wasm";
const LSP_SESSION_ID = 0xFFFFFFFF;

async function runLspCliTest() {
    console.log("Starting Direct LSP CLI Test (Bun)...");

    const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
    const wasmModule = await WebAssembly.compile(wasmBytes);

    const memory = new WebAssembly.Memory({
        initial: 1000,
        maximum: 32775,
        shared: true,
    });

    const wasi = new WASI(["vfs.core.wasm"], ["HOME=/", "VFS_THREADS=8"], [
        new OpenFile(new File([])),
        new OpenFile(new File([])),
        new OpenFile(new File([])),
    ]);

    let lspResponseReceived = false;

    // Use custom_instantiate which handles all the mapping
    const root = await custom_instantiate(
        wasmModule,
        wasi.wasiImport as any,
        {
            "thread-spawn": (start_arg: number) => {
                console.log("[Test] thread-spawn called. start_arg:", start_arg);
                // Mock: just return -1 to signal no thread actually spawned in this simple test
                // but let's see if we get this far.
                return -1;
            }
        },
        { memory },
        (idx, unknown: any) => {
            if (unknown.name === "terminalWrite") {
                const { session_id, data } = unknown.args;
                const decoded = new TextDecoder().decode(data);
                console.log(`[Test] VFS terminalWrite (session ${session_id}):`, decoded);
                if (session_id === LSP_SESSION_ID) {
                    lspResponseReceived = true;
                }
            }
            return {};
        }
    );

    // Set wasi instance for imports to work
    // @ts-ignore
    wasi.inst = root; // Note: custom_instantiate returns the 'fake' object with exports

    console.log("[Test] Initializing VFS...");
    // @ts-ignore
    if (root.exports._start) root.exports._start();

    console.log("\n--- Sending LSP Initialize Request ---");
    const initializeRequest = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: {} }
    });

    const bytes = new TextEncoder().encode(initializeRequest);
    // @ts-ignore
    const ptr = root.allocBuf(bytes.length);
    const view = new Uint8Array(memory.buffer);
    view.set(bytes, ptr);

    console.log(`[Test] Dispatching LSP message...`);
    // @ts-ignore
    root.dispatch(LSP_SESSION_ID, 6, ptr, bytes.length);

    console.log("[Test] Test completed (Direct).");
}

runLspCliTest().catch(console.error);
