import { File, OpenFile, WASI, PreopenDirectory, Directory } from "@bjorn3/browser_wasi_shim";
import { WASIFarm, wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";
import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { gen_ctx } from "./page/src/ctx.ts";
import { set_fake_worker } from "./page/src/worker_process/vfs_bindings/common.ts";

await set_fake_worker();
wait_async_polyfill();

async function runLspIntegrationTest() {
    console.log("\n=== Starting LSP Integration Test (Lightweight) ===");

    const ctx = gen_ctx();
    const LSP_SESSION_ID = 0xFFFFFFFF;
    const wasmPath = "./page/src/worker_process/vfs_bindings/vfs.core.wasm";
    
    console.log("[Test] Loading WASM...");
    let fs;
    try {
        fs = (await import("node:fs")).default;
    } catch {
        fs = (await import("fs")).default;
    }
    const wasmBytes = fs.readFileSync(wasmPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    let diagnosticReceived = false;
    let initializeResponseReceived = false;

    // 1. WASIFarm Setup
    const farm = new WASIFarm(
        new OpenFile(new File([])),
        new OpenFile(new File([])),
        new OpenFile(new File([])),
        [],
        {
            unknown_fn: async (unknown: any) => {
                if (unknown.name === "terminalWrite") {
                    const { data } = unknown.args;
                    const msg = new TextDecoder().decode(data);
                    // HEARTBEAT: Log every message from VFS
                    console.log(`[VFS -> UI] ${msg.substring(0, 100)}${msg.length > 100 ? "..." : ""}`);
                    
                    if (msg.includes("publishDiagnostics")) {
                        diagnosticReceived = true;
                    }
                    if (msg.includes("capabilities")) {
                        initializeResponseReceived = true;
                    }
                }
                return {};
            }
        }
    );

    // 2. SharedObject listeners
    new SharedObject(({ data }: { data: Uint8Array }) => {
        const msg = new TextDecoder().decode(data);
        console.log("[SharedObject ls_id] Received:", msg.substring(0, 50));
        if (msg.includes("publishDiagnostics")) diagnosticReceived = true;
        if (msg.includes("capabilities")) initializeResponseReceived = true;
    }, ctx.ls_id);

    new SharedObject(() => { return { cols: 80, rows: 24 }; }, ctx.get_terminal_size_id);
    new SharedObject(() => { console.log("[Test Host] VFS READY!"); }, ctx.vfs_ready_id);

    // 3. Start Worker Chain
    console.log("[Test] Starting Worker chain...");
    const workerUrl = new URL("./page/src/worker_process/worker.ts", import.meta.url).href;
    const worker = new Worker(workerUrl, { type: "module" });

    worker.postMessage({ ctx });
    worker.postMessage({ wasi_ref: farm.get_ref() });

    console.log("[Test] Waiting for VFS initialization...");
    // Reduced wait for a faster test
    await new Promise(r => setTimeout(r, 5000));

    const input_string = new SharedObjectRef(ctx.input_string_id).proxy<any>();
    
    console.log("\n--- Sending LSP Initialize Request ---");
    await input_string({
        sessionId: LSP_SESSION_ID,
        data: JSON.stringify({ 
            jsonrpc: "2.0", id: 1, method: "initialize", 
            params: { capabilities: {}, rootUri: "file:///", processId: null } 
        })
    });

    // 4. Verification Loop
    console.log("[Test] Monitoring communication (max 2 mins)...");
    for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (i % 10 === 0) console.log(`[Test Heartbeat] ${i}s elapsed...`);
        
        if (initializeResponseReceived && !diagnosticReceived) {
            // Once initialized, send the error code
            console.log("\n--- Sending code with syntax error ---");
            await input_string({
                sessionId: LSP_SESSION_ID,
                data: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "textDocument/didOpen",
                    params: {
                        textDocument: {
                            uri: "file:///tmp/main.rs",
                            languageId: "rust",
                            version: 1,
                            text: 'fn main() { let x = ; }'
                        }
                    }
                })
            });
            // Reset initialized flag so we don't spam
            initializeResponseReceived = false; 
        }

        if (diagnosticReceived) break;
    }

    if (diagnosticReceived) {
        console.log("\n✅ SUCCESS: Test Passed! LSP is alive and detecting errors.");
        setTimeout(() => process.exit(0), 100);
    } else {
        console.log("\n❌ FAILURE: Test Timed Out.");
        setTimeout(() => process.exit(1), 100);
    }
}

runLspIntegrationTest().catch(e => {
    console.error("Critical Test Error:", e);
    process.exit(1);
});
