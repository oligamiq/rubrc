export const RUST_WASM_RELEASE_VERSION = "v0.2.1";
export const RUST_WASM_RELEASE_BASE_URL =
  `https://oligamiq.github.io/rust_wasm/${RUST_WASM_RELEASE_VERSION}`;

export function rustWasmReleaseArchiveUrl(name: string): string {
  return `${RUST_WASM_RELEASE_BASE_URL}/${name}.tar.br`;
}
