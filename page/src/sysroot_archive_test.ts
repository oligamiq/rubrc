import {
  loadSysrootArchive,
  loadSysrootArchiveBytes,
  parseSysrootArchiveEntriesFromBytes,
  validateSysrootArchiveEntryName,
} from "./sysroot_archive.ts";
import * as sysrootArchive from "./sysroot_archive.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("rust-src uses same-origin asset while target sysroots stay remote", () => {
  const sysrootArchiveUrl = (
    sysrootArchive as unknown as {
      sysrootArchiveUrl: (
        triple: string,
        pageUrl?: string,
        sourceRevision?: string,
        buildEpoch?: string,
      ) => string;
    }
  ).sysrootArchiveUrl;
  assert(
    typeof sysrootArchiveUrl === "function",
    "archive URL selector is missing",
  );
  assert(
    sysrootArchiveUrl(
      "rust-src",
      "https://example.test/rubrc/index.html",
      "abc123",
      "42",
    ) === "https://example.test/rubrc/rust-src.tar.vfsbr?v=abc123&build=42",
    "rust-src did not include the running source revision and build epoch",
  );
  assert(
    sysrootArchiveUrl(
      "wasm32-wasip1",
      "https://example.test/rubrc/index.html",
      "abc123",
      "42",
    ) === "https://oligamiq.github.io/rust_wasm/v0.2.0/wasm32-wasip1.tar.br",
    "target sysroot URL changed",
  );
});

Deno.test("sysroot archive returns complete entries atomically", async () => {
  const entries = await loadSysrootArchive("rust-src", {
    timeoutMs: 100,
    fetchStream: async () => new ReadableStream<Uint8Array>(),
    parse: async (_stream, visit) => {
      visit({
        name: "core/src/lib.rs",
        data: new Uint8Array([1]),
        type: "file",
      });
    },
    maintainRustSrcCache: () => {},
  });
  assert(entries.length === 1, "missing archive entry");
  assert(
    new TextDecoder().decode(entries[0].name) === "core/src/lib.rs",
    "wrong name",
  );
  assert(!entries[0].isDirectory, "file marked as directory");
});

Deno.test("sysroot archive rejects at the bounded timeout", async () => {
  let signal: AbortSignal | undefined;
  let rejected = false;
  try {
    await loadSysrootArchive("rust-src", {
      timeoutMs: 1,
      fetchStream: (_url, currentSignal) => {
        signal = currentSignal;
        return new Promise<ReadableStream<Uint8Array>>((_resolve, reject) => {
          currentSignal.addEventListener(
            "abort",
            () => reject(currentSignal.reason),
          );
        });
      },
      parse: async () => {},
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("timed out");
  }
  assert(rejected, "timeout did not reject");
  assert(signal?.aborted, "timed-out fetch was not aborted");
});

Deno.test("external abort cancels the byte stream", async () => {
  const controller = new AbortController();
  const abortReason = new Error("startup generation replaced");
  let streamCancelReason: unknown;
  const loading = loadSysrootArchiveBytes("rust-src", {
    signal: controller.signal,
    fetchStream: async () =>
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          streamCancelReason = reason;
        },
      }),
  });

  await Promise.resolve();
  controller.abort(abortReason);
  const rejected = await loading.then(() => undefined, (error) => error);

  assert(rejected === abortReason, "external abort reason was replaced");
  assert(
    streamCancelReason === abortReason,
    "archive stream was not cancelled",
  );
});

Deno.test("byte archive parsing streams the original archive buffer", async () => {
  const archiveBytes = new Uint8Array([1, 2, 3]);
  let parsedChunk: Uint8Array | undefined;

  await parseSysrootArchiveEntriesFromBytes(archiveBytes, {
    parse: async (stream) => {
      parsedChunk = (await stream.getReader().read()).value;
    },
  });

  assert(
    parsedChunk?.buffer === archiveBytes.buffer,
    "parser copied the archive",
  );
  assert(
    parsedChunk?.byteOffset === archiveBytes.byteOffset,
    "parser moved bytes",
  );
  assert(
    parsedChunk?.byteLength === archiveBytes.byteLength,
    "parser resized bytes",
  );
});

Deno.test("sysroot archive rejects unsafe production entry paths", async () => {
  for (const name of ["/absolute", "..", "../escape", "nested/../../escape"]) {
    let rejected = false;
    try {
      await loadSysrootArchive("rust-src", {
        fetchStream: async () => new ReadableStream<Uint8Array>(),
        parse: async (_stream, visit) => {
          visit({ name, data: new Uint8Array([1]), type: "file" });
        },
      });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("unsafe");
    }
    assert(rejected, `unsafe archive entry was accepted: ${name}`);
  }
});

Deno.test("sysroot archive normalizes safe production entry paths", () => {
  assert(
    validateSysrootArchiveEntryName("./core/src/lib.rs") === "core/src/lib.rs",
    "safe path was not normalized",
  );
});

Deno.test("sysroot archive skips its root directory marker", async () => {
  const entries = await loadSysrootArchive("rust-src", {
    fetchStream: async () => new ReadableStream<Uint8Array>(),
    parse: async (_stream, visit) => {
      visit({ name: ".", type: "directory" });
      visit({ name: "core/src/lib.rs", type: "file" });
    },
    maintainRustSrcCache: () => {},
  });
  assert(entries.length === 1, "archive root marker was queued");
  assert(
    new TextDecoder().decode(entries[0].name) === "core/src/lib.rs",
    "wrong entry remained after root marker",
  );
});

Deno.test("sysroot archive timeout stops cached parse callbacks", async () => {
  let visits = 0;
  let rejected = false;
  try {
    await loadSysrootArchive("rust-src", {
      timeoutMs: 5,
      fetchStream: async () => new ReadableStream<Uint8Array>(),
      parse: async (_stream, visit) => {
        for (let index = 0; index < 100; index++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          visits++;
          visit({
            name: `core/src/generated-${index}.rs`,
            data: new Uint8Array([index]),
            type: "file",
          });
        }
      },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("timed out");
  }
  assert(rejected, "cached parse did not time out");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert(visits < 100, `parse continued through all ${visits} entries`);
});

Deno.test("sysroot archive timeout interrupts synchronous cached parsing", async () => {
  let rejected = false;
  try {
    await loadSysrootArchive("rust-src", {
      timeoutMs: 1,
      fetchStream: async () => new ReadableStream<Uint8Array>(),
      parse: async (_stream, visit) => {
        const start = performance.now();
        let index = 0;
        while (performance.now() - start < 25) {
          visit({
            name: `core/src/synchronous-${index++}.rs`,
            data: new Uint8Array(),
            type: "file",
          });
        }
      },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("timed out");
  }
  assert(rejected, "synchronous cached parse ran past its deadline");
});

Deno.test("rust-src cache maintenance starts only after a successful parse", async () => {
  const maintained: string[] = [];
  await loadSysrootArchive("rust-src", {
    fetchStream: async () => new ReadableStream<Uint8Array>(),
    parse: async () => {},
    maintainRustSrcCache: (url) => maintained.push(url),
  });
  assert(maintained.length === 1, `maintained ${maintained.length} times`);
});

Deno.test("rust-src parse failure does not prune cache variants", async () => {
  let maintenanceCalls = 0;
  await loadSysrootArchive("rust-src", {
    fetchStream: async () => new ReadableStream<Uint8Array>(),
    parse: async () => {
      throw new Error("partial archive");
    },
    maintainRustSrcCache: () => maintenanceCalls++,
  }).catch(() => undefined);
  assert(maintenanceCalls === 0, "failed parse started cache pruning");
});

Deno.test("blocked CacheStorage does not reject a parsed archive", async () => {
  const cachesDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "caches",
  );
  const warn = console.warn;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    get() {
      throw new DOMException("storage disabled", "SecurityError");
    },
  });
  console.warn = () => {};
  try {
    const entries = await loadSysrootArchive("rust-src", {
      fetchStream: async () => new ReadableStream<Uint8Array>(),
      parse: async () => {},
    });
    assert(entries.length === 0, "parsed archive did not complete");
  } finally {
    console.warn = warn;
    if (cachesDescriptor) {
      Object.defineProperty(globalThis, "caches", cachesDescriptor);
    } else {
      delete (globalThis as { caches?: unknown }).caches;
    }
  }
});

Deno.test("parse failure aborts the archive signal with its original error", async () => {
  const parseError = new Error("partial archive");
  let signal: AbortSignal | undefined;
  let rejected: unknown;
  try {
    await loadSysrootArchive("rust-src", {
      fetchStream: async (_url, currentSignal) => {
        signal = currentSignal;
        return new ReadableStream<Uint8Array>();
      },
      parse: async () => {
        throw parseError;
      },
    });
  } catch (error) {
    rejected = error;
  }
  assert(rejected === parseError, "parse failure reason was replaced");
  assert(signal?.aborted, "parse failure did not abort the archive signal");
  assert(
    signal?.reason === parseError,
    "abort reason was not the parse failure",
  );
});
