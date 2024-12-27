# Release notes
## v1.0.0 (2024-11-26)
- Initial release

## v1.1.0 (2024-12-8)
- load time optimization
18s -> 10s
Finer-grained asynchronous fetch.
File size reduction due to brotli compression.
Change wasm compile method from compile to compileStreaming.
- lazy loading monaco editor

## v1.1.1 (2024-12-18)
- change default code.
- moved the file with the code that runs on the worker to another directory.

## v1.1.2 (2024-12-27)
- enable pasting
