import { ConsoleStdout, File, OpenFile } from "https://esm.sh/@bjorn3/browser_wasi_shim@0.4.2";
import { WASIFarm } from "https://esm.sh/@oligami/browser_wasi_shim-threads@0.2.3";
import { set_fake_worker } from "./page/src/worker_process/vfs_bindings/common.ts";

await set_fake_worker();

async function runTest() {
    console.log("Starting VFS Parallel Execution Test with Threads...");

    // Stdin is empty, but we'll use runCommand args
    const stdinContent = new TextEncoder().encode("");
    const stdinFile = new File(stdinContent);

    let outputLog = "";

    const farm = new WASIFarm(
        new OpenFile(stdinFile), // fd 0 (stdin)
        ConsoleStdout.lineBuffered((msg) => {
            console.log(`[STDOUT] ${msg}`);
            outputLog += msg + "\n";
        }), // fd 1 (stdout)
        ConsoleStdout.lineBuffered((msg) => console.warn(`[STDERR] ${msg}`)), // fd 2 (stderr)
        [],
    );

    // Instead of reusing worker.ts (which has hardcoded args), we'll create a temporary worker script
    // that takes our desired command line as input.
    // BUT wait, it's easier to just modify crates/vfs/src/lib.rs to run our test command!

    const workerUrl = new URL("./page/src/worker_process/vfs_bindings/worker.ts", import.meta.url);
    const worker = new Worker(workerUrl, { type: "module" });

    worker.postMessage({
        wasi_ref: farm.get_ref(),
    });

    // Wait for the worker to process the shell commands and exit.
    // Since worker.ts calls start() which eventually finishes main(), it should exit.
    await new Promise(r => setTimeout(r, 50000));

    console.log("\n--- Verifying Output ---");
    if (outputLog.includes("hello") || outputLog.includes("LS_HELP")) {
        console.log("✅ SUCCESS: Found parallel output or command execution trace.");
        Deno.exit(0);
    } else {
        console.error("❌ FAILED: Output did not contain expected parallel execution trace.");
        console.error("Captured Output:\n" + outputLog);
        Deno.exit(1);
    }
}

runTest().catch(console.error);
