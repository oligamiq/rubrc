// deno run --allow-read --allow-env dist/test_run.ts

import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim";

const args = ["lsr", "--version"];
const env = ["FOO=bar"];
const fds = [
	new OpenFile(new File([])), // stdin
	ConsoleStdout.lineBuffered((msg) => console.log(`[WASI stdout] ${msg}`)),
	ConsoleStdout.lineBuffered((msg) => console.warn(`[WASI stderr] ${msg}`)),
	new PreopenDirectory(".", new Map()),
];
const wasi = new WASI(args, env, fds);

import { readFile } from "node:fs/promises";
let wasmBytes = await readFile("page/src/wasm/lsr.wasm");

let wasm = await WebAssembly.compile(wasmBytes);

let inst = await WebAssembly.instantiate(wasm, {
    "wasi_snapshot_preview1": wasi.wasiImport,
});

wasi.start(inst);
