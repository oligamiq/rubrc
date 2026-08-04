import init, {
  BrotliDecStream,
  BrotliStreamResultCode,
} from "brotli-dec-wasm/web"; // Import the default export
import { fetchWithOptionalCache } from "./fetch_with_optional_cache.ts";
// @ts-ignore
import brotli_dec_wasm_bg from "brotli-dec-wasm/web/bg.wasm?wasm&url"; // Import the wasm file

const promise = init(brotli_dec_wasm_bg); // Import is async in browsers due to wasm requirements!

// 1MB output buffer
const OUTPUT_SIZE = 1024 * 1024;

export const get_brotli_decompress_stream = async (): Promise<
  TransformStream<Uint8Array, Uint8Array>
> => {
  await promise;

  const decompressStream = new BrotliDecStream();
  const decompressionStream = new TransformStream({
    transform(chunk, controller) {
      let resultCode: number;
      let inputOffset = 0;

      // Decompress this chunk, producing up to OUTPUT_SIZE output bytes at a time, until the
      // entire input has been decompressed.

      do {
        const input = chunk.slice(inputOffset);
        const result = decompressStream.decompress(input, OUTPUT_SIZE);
        controller.enqueue(result.buf);
        resultCode = result.code;
        inputOffset += result.input_offset;
      } while (resultCode === BrotliStreamResultCode.NeedsMoreOutput);
      if (
        resultCode !== BrotliStreamResultCode.NeedsMoreInput &&
        resultCode !== BrotliStreamResultCode.ResultSuccess
      ) {
        controller.error(`Brotli decompression failed with code ${resultCode}`);
      }
    },
    flush(controller) {
      controller.terminate();
    },
  });
  return decompressionStream;
};

export const fetch_compressed_stream = async (
  url: string | URL | globalThis.Request,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> => {
  const response = await fetchWithOptionalCache(url, { signal }, {
    cacheStorage: "caches" in globalThis ? caches : undefined,
    fetch,
    reportCacheError(error) {
      console.warn("Failed to cache compressed asset", error);
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch wasm");
  }
  if (!response.body) {
    throw new Error("No body in response");
  }

  return response.body.pipeThrough(await get_brotli_decompress_stream());
};
