import { get_wasm } from "./get_wasm";

export const get_rustc_wasm = () => get_wasm(
      "https://oligamiq.github.io/rust_wasm/v0.2.0/rustc_opt.wasm.br");
