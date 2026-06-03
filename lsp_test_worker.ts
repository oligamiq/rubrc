import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { custom_instantiate } from "./page/src/worker_process/vfs_bindings/inst.ts";
import { set_fake_worker } from "./page/src/worker_process/vfs_bindings/common.ts";

await set_fake_worker();

// @ts-ignore
globalThis.addEventListener("message", async (event) => {
    const { wasm_module, thread_id, start_arg, memory, wasi_ref } = event.data;
    
    if (wasm_module) {
        console.log(`[Worker ${thread_id}] Initializing thread...`);
        try {
            const animal = new WASIFarmAnimal(
                wasi_ref,
                ["vfs.core.wasm"],
                ["HOME=/", "VFS_THREADS=8"],
                {
                    share_memory: { memory },
                }
            );

            const root = await custom_instantiate(
                wasm_module,
                animal.wasiImport as any,
                animal.wasiThreadImport as any,
                { memory },
                (idx, unknown) => {
                    return animal.call_unknown_fn(idx, unknown);
                }
            );

            console.log(`[Worker ${thread_id}] Calling wasiThreadStart...`);
            // @ts-ignore
            const threadsExport = root.virtualFileSystemWasip1ThreadsExport || root.exports;
            if (threadsExport && threadsExport.wasiThreadStart) {
                threadsExport.wasiThreadStart(thread_id, start_arg);
            } else {
                console.error(`[Worker ${thread_id}] wasiThreadStart not found!`);
            }
            console.log(`[Worker ${thread_id}] Thread finished.`);
        } catch (e) {
            console.error(`[Worker ${thread_id}] Error in worker:`, e);
        }
    }
});
