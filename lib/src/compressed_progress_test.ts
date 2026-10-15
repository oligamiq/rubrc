/// <reference lib="deno.ns" />

import { fetchCompressedStream } from "./fetch_compressed_stream.ts";

Deno.test("compressed input reports activity even while decoding buffers output", async () => {
  const progress: number[] = [];
  const dependencies = {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array());
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    }), { headers: { "Content-Type": "application/octet-stream" } }),
    reportCacheError() {},
    onCompressedBytes: (bytes: number) => progress.push(bytes),
    getDecompressStream: async () => new TransformStream<Uint8Array, Uint8Array>({
      transform() {},
      flush(controller) { controller.enqueue(new Uint8Array([9])); },
    }),
  };
  const stream = await fetchCompressedStream("https://example.test/target.tar.br", undefined, dependencies);
  const result = await new Response(stream).arrayBuffer();
  if (result.byteLength !== 1 || JSON.stringify(progress) !== "[2,3]") {
    throw new Error(`compressed progress was not observed: ${JSON.stringify(progress)}`);
  }
});
