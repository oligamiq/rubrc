import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { set_fake_worker } from "../page/src/worker_process/vfs_bindings/common.ts";
import { custom_instantiate } from "../page/src/worker_process/vfs_bindings/inst.ts";

await set_fake_worker();

const bindingsDir = new URL(
  "../page/src/worker_process/vfs_bindings/",
  import.meta.url,
);
const LSP_SESSION_ID = 0xffff_ffff;

globalThis.addEventListener("error", (event) => {
  console.error("[worker error]", event.error ?? event.message);
  event.preventDefault();
});
globalThis.addEventListener("unhandledrejection", (event) => {
  console.error("[worker unhandled rejection]", event.reason);
  event.preventDefault();
});

globalThis.onmessage = async (event) => {
  try {
    const wasm = await WebAssembly.compile(
      await Deno.readFile(new URL("vfs.core.wasm", bindingsDir)),
    );
    const animal = new WASIFarmAnimal(
      event.data.wasiRef,
      ["vfs-lsp-check"],
      ["VFS_THREADS=8", "RUST_BACKTRACE=full"],
      {
        can_thread_spawn: true,
        thread_spawn_worker_url: new URL("thread_spawn.ts", bindingsDir).href,
        thread_spawn_wasm: wasm,
        worker_background_worker_url: new URL(
          "worker_background_worker.ts",
          bindingsDir,
        ).href,
        share_memory: {
          memory: new WebAssembly.Memory({
            initial: 1032,
            maximum: 32775,
            shared: true,
          }),
        },
      },
    );

    await animal.wait_worker_background_worker();
    let output = "";
    const sharedMemory = animal.get_share_memory().memory;
    const threadImports = {
      "thread-spawn": (startArg: number) => {
        const words = new Uint32Array(sharedMemory.buffer, startArg, 4);
        console.log("[outer thread-spawn]", {
          startArg,
          stackPointer: words[0],
          tlsBase: words[1],
          closureFn: words[2],
          closureData: words[3],
        });
        return animal.wasiThreadImport["thread-spawn"](startArg);
      },
    };
    const root = await custom_instantiate(
      wasm,
      animal.wasiImport,
      threadImports,
      animal.get_share_memory(),
      (index, message: { name?: string; args?: Record<string, unknown> }) => {
        if (message.name === "terminalWrite") {
          const args = message.args as {
            session_id: number;
            data: Uint8Array;
          };
          if (args.session_id === LSP_SESSION_ID) {
            output += new TextDecoder().decode(args.data);
          }
          return;
        }
        return animal.call_unknown_fn(index, message);
      },
    );

    animal.start(root);
    const virtualThreadIdCounter = new Uint32Array(
      sharedMemory.buffer,
      1084028,
      1,
    );
    console.log("[virtual thread id counter]", virtualThreadIdCounter[0]);
    Atomics.store(virtualThreadIdCounter, 0, 1000);
    const virtualThreadPoolMax = new Uint32Array(
      sharedMemory.buffer,
      1083752,
      1,
    );
    console.log("[virtual thread pool max]", virtualThreadPoolMax[0]);
    Atomics.store(virtualThreadPoolMax, 0, 100);
    const virtualThreadPoolCount = new Uint32Array(
      sharedMemory.buffer,
      1083756,
      1,
    );
    console.log("[virtual thread pool count]", virtualThreadPoolCount[0]);
    Atomics.store(virtualThreadPoolCount, 0, 100);

    const json = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: "file:///",
        capabilities: {},
      },
    });
    const request = new TextEncoder().encode(
      `Content-Length: ${new TextEncoder().encode(json).length}\r\n\r\n${json}`,
    );
    const ptr = root.allocBuf(request.length);
    new Uint8Array(animal.get_share_memory().memory.buffer).set(request, ptr);
    root.dispatch(LSP_SESSION_ID, 6, ptr, request.length);
    root.freeBuf(ptr, request.length);

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const u32 = new Uint32Array(sharedMemory.buffer);
    const threadArgs: Array<Record<string, number>> = [];
    for (let word = 0; word + 128 < u32.length; word++) {
      const address = word * 4;
      const stackPointer = u32[word];
      const tlsBase = u32[word + 1];
      if (
        stackPointer === 0 ||
        (stackPointer & 3) !== 0 ||
        tlsBase !== stackPointer + 24 ||
        stackPointer >= sharedMemory.buffer.byteLength
      )
        continue;
      const moduleBase = address - stackPointer;
      if (moduleBase < 0 || (moduleBase & 0xffff) !== 0) continue;
      threadArgs.push({
        address,
        moduleBase,
        startArg: stackPointer,
        tlsBase,
        vfsCurrent: u32[(moduleBase + tlsBase + 116) / 4],
        lspCurrent: u32[(moduleBase + tlsBase + 476) / 4],
        closureFn: u32[word + 2],
        closureData: u32[word + 3],
      });
    }
    console.log("[thread args]", threadArgs);

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (
        output.includes("Content-Length:") &&
        output.includes('"id":1') &&
        output.includes('"capabilities"')
      ) {
        globalThis.postMessage({
          ok: true,
          detail: "rust-analyzer returned an initialize response",
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    globalThis.postMessage({
      ok: false,
      detail: `no initialize response; captured: ${output.slice(0, 1000)}`,
    });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      detail:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};
