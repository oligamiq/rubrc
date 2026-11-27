# Actual-source sysroot reader checks

Native tests compile ../../crates/vfs-shell/src/sysroot_extraction.rs directly with pinned tar dependency:

```sh
cargo test --locked --manifest-path verification/sysroot-coalescing-native/Cargo.toml
cargo test --locked --manifest-path verification/sysroot-coalescing-native/Cargo.toml --features sysroot-read-coalescing
```

Small real Wasm→JS import fixture, not merged application:

```sh
cargo build --locked --manifest-path verification/sysroot-coalescing-native/Cargo.toml --target wasm32-wasip1 --bin wasm-boundary --features boundary-fixture
node verification/sysroot-coalescing-native/run_wasm_boundary.mjs verification/sysroot-coalescing-native/target/wasm32-wasip1/debug/wasm-boundary.wasm
cargo build --locked --manifest-path verification/sysroot-coalescing-native/Cargo.toml --target wasm32-wasip1 --bin wasm-boundary --features boundary-fixture,sysroot-read-coalescing
node verification/sysroot-coalescing-native/run_wasm_boundary.mjs verification/sysroot-coalescing-native/target/wasm32-wasip1/debug/wasm-boundary.wasm
```

Checks exact data and callback counts for six lengths, consumed in777byte buffers. At1048593bytes callback count falls1350→17. This is synthetic boundary behavior, not browser startup/Cargo performance. JS callback writes into actual exported Wasm memory. No real host SharedObject/channel, mount append, thread scheduling, trap unwinding or cancellation integration covered here; native tests cover reader cancellation/error cases. No end-to-end memory/speed claim. Application feature remains defaultoff.
