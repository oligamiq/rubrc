import { readWasm } from "https://deno.land/x/wasm_parser@v0.0.3/mod.ts";

const path = Deno.args[0];
if (!path) {
  throw new Error("usage: deno run -A scripts/wasm_atomic_inspect.ts <wasm>");
}

const bytes = await Deno.readFile(path);
console.log(await readWasm(bytes));
