import { parseTar } from "./lib/src/parse_tar.ts";
const buf = new Uint8Array(10);
buf.set(new TextEncoder().encode("foo.txt"), 0);
const stream = new Blob([buf]).stream();
let count = 0;
await parseTar(stream, (file) => {
  count++;
  if (count > 10) throw new Error("Infinite loop detected");
});
