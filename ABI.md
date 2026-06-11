# Wasm ABI Document

## `rust-analyzer` (LSP) Wasm ABI

`rust-analyzer` compiles to WebAssembly with `wasm32-wasip1-threads`.
During initialization, the WebAssembly module imports specific host functions from the `env` namespace.

### Host Function Exports required from Host environment

The host (e.g. `wasi_virt_layer` wrapper / JavaScript runtime) must provide the following functions to the WebAssembly module in the `env` module:

#### 1. `host_run_cargo`
Used by the WebAssembly module to execute Cargo commands (like `cargo metadata`) on the host side.

**Signature (C-style):**
```c
int32_t host_run_cargo(
    int32_t req_ptr,
    int32_t req_len,
    int32_t out_stdout_ptr,
    int32_t out_stdout_len,
    int32_t out_stderr_ptr,
    int32_t out_stderr_len,
    int32_t out_status
);
```

**Parameters:**
- `req_ptr`: Pointer to a string in WebAssembly memory containing the JSON-serialized Cargo execution request.
- `req_len`: Length of the request string.
- `out_stdout_ptr`: Pointer to an integer where the host should write the memory address (pointer) of the stdout data allocated in WebAssembly memory.
- `out_stdout_len`: Pointer to an integer where the host should write the length of the stdout data.
- `out_stderr_ptr`: Pointer to an integer where the host should write the memory address (pointer) of the stderr data allocated in WebAssembly memory.
- `out_stderr_len`: Pointer to an integer where the host should write the length of the stderr data.
- `out_status`: Pointer to an integer where the host should write the exit status code of the Cargo process.

**Returns:**
- `int32_t`: `0` on success, or an error code.

**Host Implementation Responsibility:**
1. The host must parse the JSON request to extract Cargo arguments and environment variables.
2. The host runs `cargo` synchronously.
3. The host must allocate sufficient pages of WebAssembly memory (using the exported `memory.grow` or equivalent allocation strategy) to store the `stdout` and `stderr` streams returned by Cargo.
4. The host copies the process `stdout` and `stderr` outputs into the newly allocated memory regions.
5. The host writes the corresponding pointers and lengths into the `out_stdout_ptr`, `out_stdout_len`, `out_stderr_ptr`, and `out_stderr_len` pointers provided.
6. The host writes the exit code into `out_status`.

#### 2. `host_free_memory`
Called by the WebAssembly module to notify the host that memory allocated previously by the host (e.g., for stdout/stderr of `host_run_cargo`) is no longer needed.

**Signature (C-style):**
```c
void host_free_memory(
    int32_t ptr,
    int32_t len
);
```

**Parameters:**
- `ptr`: Pointer to the memory region to be freed.
- `len`: Length of the memory region to be freed.
