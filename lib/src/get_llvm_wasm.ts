import { get_wasm } from "./get_wasm";

export const get_llvm_wasm = () =>
  get_wasm("https://oligamiq.github.io/rust_wasm/v0.2.0/llvm_opt.wasm.br");
