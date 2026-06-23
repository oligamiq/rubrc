import { parseTar } from "./lib/src/parse_tar.ts";
const buf = new Uint8Array(600); // Only 600 bytes, not enough for 512 header + 512 data
const stream = new Blob([buf]).stream();
let iterations = 0;
await parseTar(stream, file => console.log(file.name));
console.log("Done");
