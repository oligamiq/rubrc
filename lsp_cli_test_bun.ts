import { File, OpenFile, WASI } from "@bjorn3/browser_wasi_shim";
import { custom_instantiate } from "./page/src/worker_process/vfs_bindings/inst.ts";
import { thread_spawn_on_worker, WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import thread_spawn_path from "./page/src/worker_process/vfs_bindings/thread_spawn.ts?worker&url";
import worker_background_worker_url from "./page/src/worker_process/vfs_bindings/worker_background_worker.ts?worker&url";
import { set_fake_worker } from "./page/src/worker_process/vfs_bindings/common.ts";

const wasmPath = "./page/src/worker_process/vfs_bindings/vfs.core.wasm";
const LSP_SESSION_ID = 0xFFFFFFFF;

async function runLspCliTest() {
    console.log("Starting Direct LSP CLI Test (Bun)...");
    await set_fake_worker();
    
    const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
    const wasmModule = await WebAssembly.compile(wasmBytes);

    const memory = new WebAssembly.Memory({
        initial: 127,
        maximum: 32775,
        shared: true,
    });

    const animal = new WASIFarmAnimal(
        [], // wasi_refs
        [], // args
        ["VFS_THREADS=1"], // env
        {
          can_thread_spawn: true,
          thread_spawn_worker_url: new URL(thread_spawn_path, import.meta.url).href,
          thread_spawn_wasm: wasmModule,
          worker_background_worker_url: new URL(worker_background_worker_url, import.meta.url).href,
          share_memory: {
            memory,
          },
        }
      );

    await animal.wait_worker_background_worker();

    let lspResponseReceived = false;

    // Use custom_instantiate which handles all the mapping
    const root = await custom_instantiate(
        wasmModule,
        animal.wasiImport as any,
        animal.wasiThreadImport as any,
        animal.get_share_memory(),
        (idx, unknown: any) => {
            if (unknown.name === "terminalWrite") {
                const { session_id, data } = unknown.args;
                const decoded = new TextDecoder().decode(data);
                console.log(`[Test] VFS terminalWrite (session ${session_id}):`, decoded);
                if (session_id === LSP_SESSION_ID) {
                    lspResponseReceived = true;
                }
            } else {
                animal.call_unknown_fn(idx, unknown);
            }
        }
    );

    console.log("[Test] Initializing VFS...");
    animal.start(root as any);
    
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

    // wait some time
    await new Promise(r => setTimeout(r, 2000));
    console.log("[Test] Test completed (Direct). Response received:", lspResponseReceived);
}

runLspCliTest().catch(console.error);
