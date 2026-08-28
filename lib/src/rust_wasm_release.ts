export const RUST_WASM_RELEASE_BASE_URL =
  "https://oligamiq.github.io/rust_wasm/v0.2.1";

export function rustWasmReleaseArchiveUrl(name: string): string {
  return `${RUST_WASM_RELEASE_BASE_URL}/${name}.tar.br`;
}
