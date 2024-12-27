import { fetch_compressed_stream } from "./brotli_stream";

export const get_wasm = async (
  url: string | URL | globalThis.Request,
): Promise<WebAssembly.Module> => {
  const response = new Response(await fetch_compressed_stream(url), {
    headers: { "Content-Type": "application/wasm" },
  });

  const wasm = await WebAssembly.compileStreaming(response);

  return wasm;
};
