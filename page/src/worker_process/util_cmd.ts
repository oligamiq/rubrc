import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { wasi } from "@bjorn3/browser_wasi_shim";
import type { Ctx } from "../ctx";
import { get_data } from "../cat";
// @ts-ignore
import { instantiate } from "./vfs_bindings/vfs.js";

const shared: SharedObject[] = [];

globalThis.addEventListener("message", async (event) => {
  const {
    wasi_refs,
    ctx,
  }: {
    wasi_refs: any[];
    ctx: Ctx;
  } = event.data;

  console.log("loading virtualized vfs component");

  const terminal = new SharedObjectRef(ctx.terminal_id).proxy<
    (string: string) => Promise<void>
  >();
  const waiter = new SharedObjectRef(ctx.waiter_id).proxy<{
    set_end_of_exec: (_end_of_exec: boolean) => Promise<void>;
  }>();
  const download_by_url = new SharedObjectRef(ctx.download_by_url_id).proxy<
    (url: string, name: string) => Promise<void>
  >();

  const animal = new WASIFarmAnimal(
    wasi_refs,
    [], // args
    [], // env
  );

  // --- Instantiate VFS Component ---
  function snakeToCamel(snakeCaseString: string) {
    return snakeCaseString.toLowerCase().replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
  }

  const wasi_imports: Record<string, any> = {};
  for (const key in animal.wasiImport) {
    const inner_key = `${snakeToCamel(key)}Import`;
    wasi_imports[inner_key] = (...args: any[]) => {
      return (animal.wasiImport as any)[key](...args);
    };
  }

  const vfs_root = await instantiate(undefined, {
    "wasip1-vfs:host/virtual-file-system-wasip1-core": {
      Wasip1: wasi_imports,
    }
  }, async (module: WebAssembly.Module, imports: any) => {
    return await WebAssembly.instantiate(module, imports);
  });

  console.log("vfs component instantiated", vfs_root);

  // Simple crawler to sync files from TS to Rust
  const syncToRust = async () => {
      // For now, let's just sync the files we know might exist or be needed.
      // A full crawler would be better, but we'll start with this.
      const files: { path: string, content: Uint8Array }[] = [];
      
      // Try to get some common files if they exist
      try {
          // This is just a proof of concept. In a real scenario, we'd list directories.
          // Since get_data is already implemented, we use it.
          // Note: get_data throws if file not found.
      } catch (e) {
          // ignore
      }

      vfs_root.flushToVfs(files);
  };

  const syncFromRust = async () => {
      const files = vfs_root.flushFromVfs();
      for (const file of files) {
          // Here we would write files back to animal.
          // This requires a 'write_data' equivalent to 'get_data'.
      }
  };

  // Delegate all commands to Rust
  shared.push(
    new SharedObject(async (...args: string[]) => {
        try {
            await syncToRust();
            const request = vfs_root.runCommand(args);
            await syncFromRust();

            if (request.tag === 'handled') {
                // Done
            } else if (request.tag === 'exec-file') {
                const [exec_file, exec_args] = request.val;
                const file = get_data(exec_file, animal);
                const compiled_wasm = await WebAssembly.compile(file);
                const inst = (await WebAssembly.instantiate(compiled_wasm, {
                  wasi_snapshot_preview1: animal.wasiImport,
                })) as any;
                animal.args = [exec_file, ...exec_args];
                animal.start(inst);
            } else if (request.tag === 'download') {
                const file = request.val;
                const file_data = get_data(file, animal);
                const blob = new Blob([file_data]);
                const url = URL.createObjectURL(blob);
                await download_by_url(url, file.split("/").pop() || "download");
                URL.revokeObjectURL(url);
            } else if (request.tag === 'not-found') {
                await terminal(`command not found: ${request.val}\r\n`);
            }
        } catch (e) {
            await terminal(`Error: ${e}\r\n`);
        }
        await waiter.set_end_of_exec(true);
    }, ctx.exec_file_id),
  );

  // Keep other shared objects for backward compatibility if needed, 
  // but they now just point to the same delegated runner.
  shared.push(new SharedObject(async (...args: string[]) => {
      const delegated = new SharedObjectRef(ctx.exec_file_id).proxy<(...a: string[]) => Promise<void>>();
      await delegated("ls", ...args);
  }, ctx.ls_id));

  shared.push(new SharedObject(async (...args: string[]) => {
      const delegated = new SharedObjectRef(ctx.exec_file_id).proxy<(...a: string[]) => Promise<void>>();
      await delegated("tree", ...args);
  }, ctx.tree_id));
});
