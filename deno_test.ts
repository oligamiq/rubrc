import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI } from "https://esm.sh/@bjorn3/browser_wasi_shim@0.3.0";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { instantiate } from "./page/src/worker_process/vfs_bindings/vfs.js";

const wasmPath = "./target/wasm32-wasip1/debug/vfs.wasm";

function snakeToCamel(snakeCaseString: string) {
	return snakeCaseString
		.toLowerCase()
		.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

async function runTest() {
    console.log("Starting VFS traversal sync test...");

    const testDir = "./test_workspace";
    try { await Deno.remove(testDir, { recursive: true }); } catch {}
    await Deno.mkdir(testDir, { recursive: true });
    await Deno.writeTextFile(join(testDir, "hello.txt"), "Hello from Deno!");
    await Deno.mkdir(join(testDir, "sub"), { recursive: true });
    await Deno.writeTextFile(join(testDir, "sub/world.txt"), "Nested file");

    const args = ["vfs.wasm"];
    const env = ["HOME=/"];
    const fds = [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered((msg) => console.log(`[STDOUT] ${msg}`)),
        ConsoleStdout.lineBuffered((msg) => console.warn(`[STDERR] ${msg}`)),
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
        } as any,
        async (module, imports) => {
            return await WebAssembly.instantiate(module, imports);
        },
    );

    console.log("\n--- Syncing Host to VFS ---");
    root.flushToVfs();

    console.log("\n--- Running 'ls -R' in VFS ---");
    root.runCommand(["ls", "-R"]);

    console.log("\n--- Syncing VFS back to Host ---");
    await Deno.writeTextFile(join(testDir, "deno_change.txt"), "This should stay");
    
    root.flushFromVfs();

    console.log("\nVerifying host files after sync...");
    for await (const entry of Deno.readDir(testDir)) {
        console.log(`Found file on host: ${entry.name}`);
    }

    console.log("\nTest completed!");
}

runTest().catch(console.error);
