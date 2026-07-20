import { loadSysrootArchive } from "./sysroot_archive.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

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
