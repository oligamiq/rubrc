import { parseTar } from "./lib/src/parse_tar.ts";
const buf = new Uint8Array(512);
const name = "a".repeat(100);
buf.set(new TextEncoder().encode(name), 0);
// Add a size of "0" so it doesn't fail
buf.set(new TextEncoder().encode("00000000000\x00"), 124);

const stream = new Blob([buf]).stream();
await parseTar(stream, (file) => {
  console.log("Name:", file.name);
  console.log("Length:", file.name.length);
});
