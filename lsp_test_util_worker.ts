import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { custom_instantiate } from "./page/src/worker_process/vfs_bindings/inst.ts";
import { set_fake_worker } from "./page/src/worker_process/vfs_bindings/common.ts";

await set_fake_worker();

const LSP_SESSION_ID = 0xFFFFFFFF;

// @ts-ignore
globalThis.addEventListener("message", async (event) => {
    const { wasi_ref, wasm_module, memory } = event.data;
    
    if (wasi_ref) {
        console.log("[Util Worker] Starting VFS...");
        
        try {
            const animal = new WASIFarmAnimal(
                wasi_ref,
                ["vfs.core.wasm"],
                ["HOME=/", "VFS_THREADS=8"],
                {
                    can_thread_spawn: true,
                    // Use the existing thread_spawn script or my test one
                    thread_spawn_worker_url: new URL("./lsp_test_worker.ts", import.meta.url).href,
                    thread_spawn_wasm: wasm_module,
                    share_memory: { memory },
                }
            );

            await animal.wait_worker_background_worker();

            const root = await custom_instantiate(
                wasm_module,
                animal.wasiImport as any,
                animal.wasiThreadImport as any,
                { memory },
                (idx, unknown: any) => {
                    if (unknown.name === "terminalWrite") {
                        const { session_id, data } = unknown.args;
                        const decoded = new TextDecoder().decode(data);
                        console.log(`[Util Worker] VFS terminalWrite (session ${session_id}):`, decoded);
                        
                        // Forward to main test script
                        globalThis.postMessage({ type: "lsp_response", session_id, data: decoded });
                    }
                    return animal.call_unknown_fn(idx, unknown);
                }
            );

            // Start VFS main
            animal.start(root as any);
            console.log("[Util Worker] VFS started.");

            // Listen for input from main test script
            globalThis.addEventListener("message", async (msg) => {
                if (msg.data.type === "lsp_request") {
                    const { sessionId, data } = msg.data;
                    const bytes = new TextEncoder().encode(data);
                    // @ts-ignore
                    const ptr = root.allocBuf(bytes.length);
                    const view = new Uint8Array(memory.buffer);
                    view.set(bytes, ptr);
                    
                    console.log(`[Util Worker] Dispatching LSP request to VFS...`);
                    // @ts-ignore
                    root.dispatch(sessionId, 6, ptr, bytes.length);
                    // @ts-ignore
                    root.freeBuf(ptr, bytes.length);
                }
            });

            // Signal ready
            globalThis.postMessage({ type: "vfs_ready" });

        } catch (e) {
            console.error("[Util Worker] Error:", e);
        }
    }
});
