import { parseTar } from "./lib/src/parse_tar.ts";
const buf = new Uint8Array(1024);
// Make it a valid tar header. Name = "a". Size = 512 (octal "1000")
buf[0] = 97; // 'a'
// size offset is 124, length 12
const sizeStr = "00000001000";
for(let i=0; i<11; i++) buf[124+i] = sizeStr.charCodeAt(i);
buf[124+11] = 0; // null terminator

const stream = new Blob([buf.slice(0, 600)]).stream(); // Only provide 600 bytes, missing the rest of data
let iterations = 0;
// We'll add a timeout so it doesn't hang the runner forever
const p = parseTar(stream, file => console.log(file.name));
const t = new Promise(r => setTimeout(r, 1000, "TIMEOUT"));
const res = await Promise.race([p, t]);
console.log(res);
