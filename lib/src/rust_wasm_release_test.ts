/// <reference lib="deno.ns" />

import {
  RUST_WASM_RELEASE_BASE_URL,
  rustWasmReleaseArchiveUrl,
} from "./rust_wasm_release.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(`${actual} !== ${expected}`);
};

Deno.test("rust_wasm archives share the pinned v0.2.1 release", () => {
  assertEquals(
    RUST_WASM_RELEASE_BASE_URL,
    "https://oligamiq.github.io/rust_wasm/v0.2.1",
  );
  assertEquals(
    rustWasmReleaseArchiveUrl("rust-src"),
    `${RUST_WASM_RELEASE_BASE_URL}/rust-src.tar.br`,
  );
  assertEquals(
    rustWasmReleaseArchiveUrl("wasm32-wasip1"),
    `${RUST_WASM_RELEASE_BASE_URL}/wasm32-wasip1.tar.br`,
  );
});
