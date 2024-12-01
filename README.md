# Rubrc
Rubrc is a rustc that runs in the browser.

It is a port of the rustc compiler to WebAssembly. It is a work in progress and is not yet ready for general use.

This have some bottlenecks, like the lack of thread spawn is very slow.

Currently, the targets for which executable files can be generated are `wasm32-wasip1` and `x86_64-unknown-linux-musl`. Other targets fail during the linking process. If you have any information, we would greatly appreciate it if you could share it in an issue.

Demo: [Rubrc](https://oligamiq.github.io/rubrc/)

# Special Thanks
## Projects
- [rubri](https://github.com/LyonSyonII/rubri) by [LyonSyonII](https://github.com/LyonSyonII) - At first, I was using this project to run it on the browser.
- [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) by [bjorn3](https://github.com/bjorn3) - This project is used to run the WASI on the browser.
- [browser_wasi_shim-threads](https://github.com/bjorn3/browser_wasi_shim/tree/main/threads#README) by [oligamiq](https://github.com/oligamiq) - This project is used to run the WASI with threads on the browser.
- [rust_wasm](https://github.com/oligamiq/rust_wasm) by [oligamiq](https://github.com/oligamiq) - This is a project that hosts files and sysroots compiled from Rustc, supporting from Tier 1 to Tier 2 with host in this project, and compiled to wasm.

## People
- [bjorn3](https://github.com/bjorn3) - He created the foundation for compiling Rustc to WASI and managing linker relations.
- [oligamiq](https://github.com/oligamiq) - He created Rustc compiled with LLVM Backend to WASI.
- [whitequark](https://github.com/whitequark) - He created the LLVM to WASI.
- [rust-lang](https://github.com/rust-lang) - They created the Rust language.

## Related Page
- https://github.com/rust-lang/miri/issues/722#issuecomment-1960849880
- https://discourse.llvm.org/t/rfc-building-llvm-for-webassembly/79073/27

# Issues
This has been created in a rather haphazard manner, but as the creator, I will be busy for a while, so it’s been left in this state for now. There are numerous bugs, such as commands throwing errors and subsequently becoming unusable, but feel free to open issues if necessary. Minor pull requests to improve usability are also welcome, so feel free to tweak it as you like.

# Features
! This project require coop coep headers to work, so you need to run it on a server or use a browser extension to allow it.
- [x] Run rustc on the browser
- [x] Ctrl+V 

# Funding
The projects that this project depends on, namely [browser_wasi_shim-threads](https://www.npmjs.com/package/@oligami/browser_wasi_shim-threads), [rust_wasm](https://github.com/oligamiq/rust_wasm), and [shared-object](https://www.npmjs.com/package/@oligami/shared-object), are all my projects. The [toolchain-for-building-rustc](https://github.com/oligamiq/toolchain-for-building-rustc) that rust_wasm depends on is also my project. I was the one who enabled the LLVM backend for rustc, and ultimately, I aim to make rustc executable in browsers that support wasm and allow cargo to run seamlessly on the web.

If you like or want to use this series of projects, I would appreciate it if you could contribute financially via the sponsor button.

Please note that coding has temporarily stopped due to being busy, and there may be missing or incorrect documentation. Although it works, it is currently in a state with various issues, so I do not recommend using it for production.

# License
This project is licensed under the MIT OR Apache-2.0 License.
