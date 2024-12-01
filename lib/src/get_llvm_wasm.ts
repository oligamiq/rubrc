import { parseTarGzip } from 'nanotar';

export const get_llvm_wasm = async (): Promise<WebAssembly.Module> => {
  const zipped_wasm = await fetch(
    // "https://oligamiq.github.io/rust_wasm/v0.1.0/wasm32-wasip1.tar.gz",
    "https://oligamiq.github.io/rust_wasm/v0.1.0/llvm_opt.wasm.tar.gz",
  );
  const files = await parseTarGzip(await zipped_wasm.arrayBuffer());
  const file = files[0];
  const wasmFile = file.data;
  if (!wasmFile) {
    throw new Error("Wasm file not found");
  }
  const wasm = await WebAssembly.compile(wasmFile);
  return wasm;
}
