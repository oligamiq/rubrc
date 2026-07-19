import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";
import { wasi } from "@bjorn3/browser_wasi_shim";
import type { Ctx } from "../ctx";
import { get_data } from "../cat";
import { write_data } from "../write_data";
import { custom_instantiate } from "./vfs_bindings/inst";
import { set_fake_worker } from "./vfs_bindings/common";
import { get_brotli_decompress_stream } from "../../../lib/src/brotli_stream";

import thread_spawn_path from "./vfs_bindings/thread_spawn.ts?worker&url";
import worker_background_worker_url from "./vfs_bindings/worker_background_worker.ts?worker&url";

await set_fake_worker();

const LSP_SESSION_ID = 0xffffffff;

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
    (args: { sessionId: number; data: Uint8Array }) => Promise<void>
  >();
  const lsp = new SharedObjectRef(ctx.ls_id).proxy<
    (args: { data: Uint8Array }) => Promise<void>
  >();
  const waiter = new SharedObjectRef(ctx.waiter_id).proxy<{
    set_end_of_exec: (_end_of_exec: boolean) => Promise<void>;
  }>();

  async function getCachedWasm(
    key: string,
  ): Promise<WebAssembly.Module | null> {
    if (typeof indexedDB === "undefined") return null;
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open("wasm_cache", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("modules");
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("modules")) {
            resolve(null);
            return;
          }
          try {
            const tx = db.transaction("modules", "readonly");
            const store = tx.objectStore("modules");
            const getReq = store.get(key);
            getReq.onsuccess = () => resolve(getReq.result || null);
            getReq.onerror = () => resolve(null);
          } catch (e) {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function cacheWasm(
    key: string,
    module: WebAssembly.Module,
  ): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open("wasm_cache", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("modules");
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction("modules", "readwrite");
            const store = tx.objectStore("modules");
            store.put(module, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          } catch (e) {
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  const vfs_wasm_path = new URL("./vfs_bindings/vfs.core.wasm", import.meta.url)
    .href;
  let vfs_wasm: WebAssembly.Module | null = null;

  try {
    if (import.meta.env.PROD) {
      const manifestUrl = new URL(vfs_wasm_path);
      manifestUrl.pathname += ".br.json";
      manifestUrl.hash = "";

      const manifestRes = await fetch(manifestUrl.href);
      if (!manifestRes.ok) {
        throw new Error(`Failed to fetch manifest: ${manifestUrl.href} ${manifestRes.status} ${manifestRes.statusText}`);
      }
      const manifest = await manifestRes.json();

      if (manifest.version !== 1 || manifest.encoding !== "br" || !manifest.parts || !Array.isArray(manifest.parts) || manifest.parts.length === 0) {
        throw new Error(`Invalid manifest at ${manifestUrl.href}`);
      }
      if (typeof manifest.originalFile !== 'string' || !/^vfs\.core-.*\.wasm$/.test(manifest.originalFile) || manifest.originalFile.includes('/') || manifest.originalFile.includes('\\') || manifest.originalFile.includes('..')) {
        throw new Error(`Invalid originalFile in manifest`);
      }
      if (!manifestUrl.pathname.endsWith(`/${manifest.originalFile}.br.json`)) {
        throw new Error(`Manifest URL basename does not match originalFile`);
      }
      if (!Number.isSafeInteger(manifest.originalSize) || manifest.originalSize <= 0) {
        throw new Error(`Invalid originalSize in manifest`);
      }
      if (!Number.isSafeInteger(manifest.compressedSize) || manifest.compressedSize <= 0) {
        throw new Error(`Invalid compressedSize in manifest`);
      }

      let totalPartSize = 0;
      for (let i = 0; i < manifest.parts.length; i++) {
        const part = manifest.parts[i];
        const expectedPartFile = `${manifest.originalFile}.br.part-${i.toString().padStart(3, "0")}`;
        if (part.file !== expectedPartFile) {
          throw new Error(`Invalid part file in manifest: expected ${expectedPartFile}, got ${part.file}`);
        }
        if (!Number.isSafeInteger(part.size) || part.size <= 0 || part.size > 25165824) {
          throw new Error(`Invalid part size in manifest`);
        }
        totalPartSize += part.size;
      }
      if (totalPartSize !== manifest.compressedSize) {
        throw new Error(`Manifest part sizes do not match compressedSize`);
      }

      const cacheKey = `${manifestUrl.href}?etag=${manifest.compressedSize}`;
      vfs_wasm = await getCachedWasm(cacheKey);

      if (vfs_wasm) {
        await terminal({
          sessionId: 0,
          data: new TextEncoder().encode(`[VFS] Loaded compiled Wasm from local cache.\r\n`),
        });
      } else {
        const total = manifest.compressedSize;
        const decompressStream = await get_brotli_decompress_stream();

        const { readable, writable } = new TransformStream();

        (async () => {
          const writer = writable.getWriter();
          try {
            let loaded = 0;
            let partIndex = 0;
            for (const part of manifest.parts) {
              const partUrl = new URL(part.file, manifestUrl.href).href;
              const partRes = await fetch(partUrl);
              if (!partRes.ok) {
                throw new Error(`Failed to fetch part ${partIndex} (${partUrl}): ${partRes.status} ${partRes.statusText}`);
              }
              const reader = partRes.body?.getReader();
              if (!reader) throw new Error("No body on part response");

              let partLoaded = 0;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                partLoaded += value.byteLength;
                loaded += value.byteLength;
                let progressMsg = `\r\x1b[K[VFS] Downloading: ${(loaded / 1024 / 1024).toFixed(2)}MB`;
                if (total > 0) {
                  const percent = Math.round((loaded / total) * 100);
                  progressMsg += `/${(total / 1024 / 1024).toFixed(2)}MB (${percent}%)`;
                }
                await terminal({
                  sessionId: 0,
                  data: new TextEncoder().encode(progressMsg),
                });
                await writer.write(value);
              }
              if (partLoaded !== part.size) {
                throw new Error(`Part size mismatch for ${part.file}: loaded ${partLoaded}, expected ${part.size}`);
              }
              partIndex++;
            }
            if (loaded !== manifest.compressedSize) {
              throw new Error(`Total size mismatch: loaded ${loaded}, expected ${manifest.compressedSize}`);
            }
            await terminal({
              sessionId: 0,
              data: new TextEncoder().encode(`\r\n[VFS] Finalizing compilation...\r\n`),
            });
            await writer.close();
          } catch (e) {
            await writer.abort(e);
          }
        })();

        let decompressedLoaded = 0;
        const validationStream = new TransformStream({
          transform(chunk, controller) {
            decompressedLoaded += chunk.byteLength;
            if (decompressedLoaded > manifest.originalSize) {
              controller.error(new Error("Decompressed size exceeds originalSize"));
              return;
            }
            controller.enqueue(chunk);
          },
          flush(controller) {
            if (decompressedLoaded !== manifest.originalSize) {
              controller.error(new Error(`Decompressed size (${decompressedLoaded}) does not match originalSize (${manifest.originalSize})`));
            }
          }
        });

        const decompressedReadable = readable.pipeThrough(decompressStream).pipeThrough(validationStream);

        vfs_wasm = await WebAssembly.compileStreaming(
          new Response(decompressedReadable, {
            headers: { "Content-Type": "application/wasm" },
          }),
        );

        await cacheWasm(cacheKey, vfs_wasm);
        await terminal({
          sessionId: 0,
          data: new TextEncoder().encode(`[VFS] Wasm ready and cached.\r\n`),
        });
      }
    } else {
      let response = await fetch(vfs_wasm_path);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${vfs_wasm_path}: ${response.status} ${response.statusText}`);
      }
      const etag =
        response.headers.get("etag") ||
        response.headers.get("last-modified") ||
        "unknown";
      const cacheKey = `${vfs_wasm_path}?etag=${etag}`;
      vfs_wasm = await getCachedWasm(cacheKey);

      if (vfs_wasm) {
        await terminal({
          sessionId: 0,
          data: new TextEncoder().encode(
            `[VFS] Loaded compiled Wasm from local cache.\r\n`,
          ),
        });
        response.body?.cancel(); // Cancel download to save bandwidth
      } else {
        const contentLength = response.headers.get("Content-Length");
        const total = parseInt(contentLength || "0", 10);

        const { readable, writable } = new TransformStream();
        (async () => {
          const writer = writable.getWriter();
          const reader = response.body?.getReader();
          if (!reader) {
            await writer.close();
            return;
          }
          try {
            let loaded = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              loaded += value.byteLength;
              let progressMsg = `\r\x1b[K[VFS] Downloading: ${(loaded / 1024 / 1024).toFixed(2)}MB`;
              if (total > 0) {
                const percent = Math.round((loaded / total) * 100);
                progressMsg += `/${(total / 1024 / 1024).toFixed(2)}MB (${percent}%)`;
              }
              await terminal({
                sessionId: 0,
                data: new TextEncoder().encode(progressMsg),
              });
              await writer.write(value);
            }
            await terminal({
              sessionId: 0,
              data: new TextEncoder().encode(
                `\r\n[VFS] Finalizing compilation...\r\n`,
              ),
            });
            await writer.close();
          } catch (e) {
            await writer.abort(e);
          }
        })();

        vfs_wasm = await WebAssembly.compileStreaming(
          new Response(readable, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
          }),
        );

        // Cache it for next time
        await cacheWasm(cacheKey, vfs_wasm);
        await terminal({
          sessionId: 0,
          data: new TextEncoder().encode(`[VFS] Wasm ready and cached.\r\n`),
        });
      }
    }
  } catch (err) {
    await terminal({
      sessionId: 0,
      data: new TextEncoder().encode(
        `\r\n[VFS] Error loading Wasm: ${err}\r\n`,
      ),
    });
    throw err;
  }

  const vfs_threads = 8;
  const animal = new WASIFarmAnimal(
    wasi_refs,
    [], // args
    [`VFS_THREADS=${vfs_threads}`], // env
    {
      can_thread_spawn: true,
      thread_spawn_worker_url: new URL(thread_spawn_path, import.meta.url).href,
      thread_spawn_wasm: vfs_wasm,
      worker_background_worker_url: new URL(
        worker_background_worker_url,
        import.meta.url,
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

  const vfs_root = await custom_instantiate(
    vfs_wasm,
    animal.wasiImport as any,
    animal.wasiThreadImport as any,
    animal.get_share_memory(),
    (idx, unknown: any) => {
      if (unknown.name === "terminalWrite") {
        console.log(
          `[Worker] VFS terminalWrite: session=${unknown.args.session_id}, len=${unknown.args.data.length}`,
        );
        if (unknown.args.session_id === LSP_SESSION_ID) {
          console.log("[Worker] Routing to LSP handler");
          lsp({ data: unknown.args.data });
        } else {
          terminal({
            sessionId: unknown.args.session_id,
            data: unknown.args.data,
          });
        }
      } else {
        return animal.call_unknown_fn(idx, unknown);
      }
    },
  );

  console.log("vfs component instantiated", vfs_root);

  // Initialize VFS component (runs its main function which sets up thread pool etc.)
  animal.start(vfs_root as any);

  // Initialize main session
  vfs_root.dispatch(0, 3, 0, 0);

  const get_terminal_size = new SharedObjectRef(ctx.get_terminal_size_id).proxy<
    () => Promise<{ cols: number; rows: number }>
  >();
  const { cols, rows } = await get_terminal_size();
  vfs_root.dispatch(0, 1, cols, rows);

  shared.push(
    new SharedObject(({ sessionId }: { sessionId: number }) => {
      vfs_root.dispatch(sessionId, 3, 0, 0);
    }, ctx.create_session_id),
  );

  shared.push(
    new SharedObject(({ sessionId, c }: { sessionId: number; c: number }) => {
      (async () => {
        try {
          console.log(
            `[Worker] input_char for session ${sessionId}, char code: ${c}`,
          );
          vfs_root.dispatch(sessionId, 0, c, 0);
        } catch (e) {
          await terminal({
            sessionId,
            data: new TextEncoder().encode(`Error: ${e}\r\n`),
          });
        }
      })();
    }, ctx.input_char_id),
  );

  console.log(
    "[Worker] Registering input_string SharedObject with ID:",
    ctx.input_string_id,
  );
  shared.push(
    new SharedObject(
      ({ sessionId, data }: { sessionId: number; data: string }) => {
        (async () => {
          try {
            console.log(
              `[Worker] input_string for session ${sessionId}, length: ${data.length}`,
            );
            if (sessionId !== LSP_SESSION_ID && sessionId !== 0xeeeeeeee) {
              for (const char of data) {
                const codePoint = char.codePointAt(0);
                if (codePoint !== undefined) {
                  vfs_root.dispatch(sessionId, 0, codePoint, 0);
                }
              }
              return;
            }

            const bytes = new TextEncoder().encode(data);
            const ptr = vfs_root.allocBuf(bytes.length);
            console.log(
              `[Worker] Allocated buffer at ${ptr}, copying ${bytes.length} bytes`,
            );
            const view = new Uint8Array(
              animal.get_share_memory().memory.buffer,
            );
            view.set(bytes, ptr);

            let eventType = sessionId === LSP_SESSION_ID ? 6 : 4; // 6 is EVENT_TYPE_LSP, 4 is InputString
            if (sessionId === 0xeeeeeeee) {
              eventType = 7; // EVENT_TYPE_WRITE_FILE
            }
            console.log(
              `[Worker] Dispatching to VFS: session=${sessionId}, eventType=${eventType}, len=${bytes.length}`,
            );
            vfs_root.dispatch(sessionId, eventType, ptr, bytes.length);
            vfs_root.freeBuf(ptr, bytes.length);
          } catch (e) {
            console.error(`[Worker] Error in input_string: ${e}`);
            await terminal({
              sessionId,
              data: new TextEncoder().encode(`Error: ${e}\r\n`),
            });
          }
        })();
      },
      ctx.input_string_id,
    ),
  );

  shared.push(
    new SharedObject(({ sessionId }: { sessionId: number }) => {
      vfs_root.dispatch(sessionId, 2, 0, 0);
    }, ctx.interrupt_id),
  );

  shared.push(
    new SharedObject(
      ({
        sessionId,
        cols,
        rows,
      }: {
        sessionId: number;
        cols: number;
        rows: number;
      }) => {
        (async () => {
          try {
            vfs_root.dispatch(sessionId, 1, cols, rows);
          } catch (e) {
            await terminal({
              sessionId,
              data: new TextEncoder().encode(`Error: ${e}\r\n`),
            });
          }
        })();
      },
      ctx.resize_id,
    ),
  );

  shared.push(
    new SharedObject(({ sessionId }: { sessionId: number }) => {
      vfs_root.dispatch(sessionId, 5, 0, 0); // 5 is CloseSession
    }, ctx.close_session_id),
  );

  const vfs_ready = new SharedObjectRef(ctx.vfs_ready_id).proxy<
    () => Promise<void>
  >();
  vfs_ready().catch(console.error);
});
